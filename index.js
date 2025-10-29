// index.js (FULL, replace your current file)
const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---- State & config ----
const logs = [];
const uploadQueue = {}; // uploadQueue[userId] = [url, ...]
let uploadProgress = { active: false, total: 0, completed: 0, current: null };

const {
  BOT_TOKEN,
  GITHUB_TOKEN,
  GITHUB_REPO,
  MY_ID,
  UPLOAD_URL,
  UPLOAD_KEY,
  SEEDR_TOKEN
} = process.env;

const ALLOWED_USER_IDS = (MY_ID || "").split(",").map(s => s.trim()).filter(Boolean);

// ---- Helpers ----
async function fetchJson(url, opts = {}) {
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(url, opts);
  return res;
}
async function postJson(url, body, opts = {}) {
  const fetch = (await import("node-fetch")).default;
  return fetch(url, Object.assign({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, opts));
}
async function answerCallback(callbackQueryId, text = "") {
  if (!BOT_TOKEN) return;
  const fetch = (await import("node-fetch")).default;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false })
    });
  } catch (e) { /* ignore */ }
}
async function sendMessage(chatId, text, keyboard = null) {
  if (!BOT_TOKEN) return;
  const fetch = (await import("node-fetch")).default;
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
function fileNameFromURL(url) {
  try { return decodeURIComponent(url.split("/").pop().split("?")[0]); } catch { return String(Date.now()); }
}
function sanitize(filename) { return filename.replace(/[^a-zA-Z0-9.\-_ ]/g, "_"); }
function addLog(type, msg) { logs.push({ ts: new Date().toISOString(), type, msg }); if (logs.length > 500) logs.shift(); }

// ---- GitHub helpers ----
async function getExistingSha(path) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return null;
  const fetch = (await import("node-fetch")).default;
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, { headers: { Authorization: `token ${GITHUB_TOKEN}` }});
    if (!r.ok) throw new Error("no file");
    const j = await r.json();
    return j.sha || null;
  } catch (e) { return null; }
}
async function githubPut(path, contentBase64, sha = null) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) throw new Error("GitHub not configured");
  const fetch = (await import("node-fetch")).default;
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Update via bot", content: contentBase64, ...(sha ? { sha } : {}) })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error("GitHub upload failed: " + txt.slice(0, 200));
  }
  return await r.json();
}

// ---- M3U reading ----
async function getM3ULinks() {
  if (!GITHUB_REPO) return [];
  const fetch = (await import("node-fetch")).default;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`);
    if (!r.ok) throw new Error("Failed to fetch 1.m3u");
    const text = await r.text();
    return text.split("\n").map(l => l.trim()).filter(l => l && l.startsWith("http") && !l.includes(".m3u8") && (l.includes(".mp4") || l.includes(".mkv") || l.includes("seedr")));
  } catch (e) {
    addLog("error", "getM3ULinks: " + e.message);
    return [];
  }
}

// ---- Download & upload single video ----
async function downloadAndUpload(videoUrl, fileName, progressCallback = null) {
  const fetch = (await import("node-fetch")).default;
  const FormData = (await import("form-data")).default;

  const tmpPath = `/tmp/${Date.now()}_${sanitize(fileName)}`;
  // Prepare headers (Seedr auth optional)
  const headers = {};
  if (SEEDR_TOKEN && videoUrl.includes("seedr")) headers.Authorization = `Bearer ${SEEDR_TOKEN}`;

  const res = await fetch(videoUrl, { headers, timeout: 0 });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const total = parseInt(res.headers.get("content-length") || "0", 10) || null;
  const stream = res.body;
  const out = fs.createWriteStream(tmpPath);
  let downloaded = 0;
  await new Promise((resolve, reject) => {
    stream.on("data", chunk => {
      out.write(chunk);
      downloaded += chunk.length;
      if (progressCallback) progressCallback(downloaded, total);
    });
    stream.on("end", () => { out.end(); resolve(); });
    stream.on("error", err => { out.close(); reject(err); });
  });

  // Upload to your server
  const form = new FormData();
  form.append("key", UPLOAD_KEY || "");
  form.append("file", fs.createReadStream(tmpPath), fileName);

  const uploadRes = await fetch(UPLOAD_URL, { method: "POST", body: form });
  let uploadJson = {};
  try { uploadJson = await uploadRes.json(); } catch(e){ uploadJson = {}; }
  // cleanup
  try { fs.unlinkSync(tmpPath); } catch(e){}

  if (!uploadRes.ok || !uploadJson.ok) {
    const errText = uploadJson && uploadJson.error ? uploadJson.error : `status ${uploadRes.status}`;
    throw new Error("Upload failed: " + errText);
  }
  return uploadJson;
}

// ---- Worker to process uploads (runs async, non-blocking webhook) ----
let workerRunning = false;
async function startUploadWorkerForUser(userId, chatId, urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    await sendMessage(chatId, "⚠️ Nothing to upload.");
    return;
  }
  if (workerRunning) {
    await sendMessage(chatId, "⚠️ Upload worker busy, your job is queued.");
  }
  // queue simply run this job now (not persisted)
  workerRunning = true;
  uploadProgress.active = true;
  uploadProgress.total = urls.length;
  uploadProgress.completed = 0;
  uploadProgress.current = null;

  addLog("info", `Start upload job for ${userId} (${urls.length} items)`);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const name = fileNameFromURL(url);
    uploadProgress.current = name;
    try {
      await sendMessage(chatId, `⏬ Downloading (${i+1}/${urls.length}): ${name}`);
      await downloadAndUpload(url, name, (downloaded, total) => {
        // optional: we could update uploadProgress with partial bytes, but keep it simple
      });
      uploadProgress.completed++;
      addLog("info", `Uploaded ${name}`);
      await sendMessage(chatId, `✅ Uploaded: ${name}`);
    } catch (e) {
      addLog("error", `${name} failed: ${e.message}`);
      await sendMessage(chatId, `❌ Failed: ${name}\n${e.message}`);
    }
  }

  uploadProgress.active = false;
  uploadProgress.current = null;
  uploadProgress.completed = uploadProgress.total;
  workerRunning = false;
  await sendMessage(chatId, "🎉 All uploads finished.");
}

// ---- Webhook handler (messages + callback_query) ----
app.post("/webhook", async (req, res) => {
  const fetch = (await import("node-fetch")).default;
  try {
    const body = req.body;

    // ---- callback_query (button presses) ----
    if (body.callback_query) {
      const cq = body.callback_query;
      const data = cq.data;
      const chatId = cq.message.chat.id;
      const userId = cq.from.id.toString();
      await answerCallback(cq.id); // remove waiting UI

      // START MENU pressed
      if (data === "menu_uploadserver") {
        const urls = await getM3ULinks();
        if (!urls.length) {
          await sendMessage(chatId, "⚠️ No video links found in 1.m3u.");
          return res.sendStatus(200);
        }
        uploadQueue[userId] = urls;
        await sendMessage(chatId, `🎬 Found ${urls.length} videos. Upload all?`, [
          [{ text: "✅ Yes", callback_data: "confirm_yes" }, { text: "❌ No", callback_data: "confirm_no" }]
        ]);
        return res.sendStatus(200);
      }

      // confirm yes/no
      if (data === "confirm_no") {
        delete uploadQueue[userId];
        await sendMessage(chatId, "❌ Upload cancelled.");
        return res.sendStatus(200);
      }

      if (data === "confirm_yes") {
        const urls = uploadQueue[userId] || [];
        if (!urls.length) {
          await sendMessage(chatId, "⚠️ No queued items.");
          return res.sendStatus(200);
        }
        delete uploadQueue[userId];
        // start worker (async)
        startUploadWorkerForUser(userId, chatId, urls).catch(e => addLog("error", "Worker err: " + e.message));
        await sendMessage(chatId, `📤 Upload started for ${urls.length} videos. I will notify progress here.`);
        return res.sendStatus(200);
      }

      // other callback types can be added
      return res.sendStatus(200);
    }

    // ---- normal message (text or file) ----
    if (!body.message) return res.sendStatus(200);
    const msg = body.message;
    const chatId = msg.chat.id;
    const userId = msg.from?.id?.toString();
    const text = (msg.text || "").trim();

    addLog("info", `Msg from ${userId}: ${text}`);

    // Only allow your user(s)
    if (ALLOWED_USER_IDS.length && !ALLOWED_USER_IDS.includes(userId)) {
      await sendMessage(chatId, "❌ You are not authorized to use this bot.");
      return res.sendStatus(200);
    }

    // /start -> show menu buttons (inline)
    if (text === "/start") {
      await sendMessage(chatId, "Welcome! Choose an action:", [
        [{ text: "▶️ Upload from 1.m3u", callback_data: "menu_uploadserver" }],
        [{ text: "📁 Update playlist (.m3u)", callback_data: "menu_update_m3u" }]
      ]);
      return res.sendStatus(200);
    }

    // If user sends YES text (some clients prefer typing)
    if (text.toLowerCase() === "yes" && uploadQueue[userId] && uploadQueue[userId].length) {
      const urls = uploadQueue[userId];
      delete uploadQueue[userId];
      startUploadWorkerForUser(userId, chatId, urls).catch(e => addLog("error", "Worker err: " + e.message));
      await sendMessage(chatId, `📤 Upload started for ${urls.length} videos.`);
      return res.sendStatus(200);
    }

    // upload server command via text
    if (text === "/uploadserver") {
      const urls = await getM3ULinks();
      if (!urls.length) {
        await sendMessage(chatId, "⚠️ No video links found in 1.m3u.");
        return res.sendStatus(200);
      }
      uploadQueue[userId] = urls;
      await sendMessage(chatId, `🎬 Found ${urls.length} videos. Reply "YES" or press the button to start.`, [
        [{ text: "✅ Start Upload (Yes)", callback_data: "confirm_yes" }, { text: "❌ Cancel", callback_data: "confirm_no" }]
      ]);
      return res.sendStatus(200);
    }

    // handle .m3u file upload to github
    if (msg.document && msg.document.file_name && msg.document.file_name.toLowerCase().endsWith(".m3u")) {
      // download file from telegram
      try {
        const info = await fetchJson(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${msg.document.file_id}`);
        const filePath = (await info.json()).result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
        const fileRes = await fetchJson(fileUrl);
        const arr = await fileRes.arrayBuffer();
        const base64 = Buffer.from(arr).toString("base64");
        const sha = await getExistingSha("1.m3u");
        await githubPut("1.m3u", base64, sha);
        await sendMessage(chatId, "✅ 1.m3u updated on GitHub.");
        addLog("info", "1.m3u updated via Telegram upload.");
      } catch (e) {
        addLog("error", "m3u upload failed: " + e.message);
        await sendMessage(chatId, "❌ Failed to upload 1.m3u: " + e.message);
      }
      return res.sendStatus(200);
    }

    // fallback
    return res.sendStatus(200);
  } catch (err) {
    addLog("error", "webhook: " + (err && err.message ? err.message : String(err)));
    return res.sendStatus(500);
  }
});

// ---- Dashboard endpoints ----
app.get("/logs", (req, res) => res.json(logs.slice(-200)));
app.get("/status", (req, res) => res.json({ active: true, time: new Date().toISOString() }));
app.get("/upload-progress", (req, res) => res.json(uploadProgress));
app.get("/folders", async (req, res) => {
  if (!UPLOAD_URL || !UPLOAD_KEY) return res.json({ ok: false, error: "UPLOAD_URL not configured" });
  const fetch = (await import("node-fetch")).default;
  try {
    const url = new URL(UPLOAD_URL);
    url.searchParams.set("list", "1");
    url.searchParams.set("key", UPLOAD_KEY);
    const r = await fetch(url.toString());
    const j = await r.json();
    res.json(j);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- Export ----
module.exports = app;
