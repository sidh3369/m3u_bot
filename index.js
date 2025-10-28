// index.js
const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const logs = [];
const uploadQueue = {};

const {
  BOT_TOKEN,
  GITHUB_TOKEN,
  GITHUB_REPO,
  MY_ID,
  UPLOAD_URL,
  UPLOAD_KEY
} = process.env;

const ALLOWED_USER_IDS = (MY_ID || "").split(",").map(id => id.trim());

// ✅ TELEGRAM WEBHOOK HANDLER
app.post("/webhook", async (req, res) => {
  const fetch = (await import("node-fetch")).default;

  try {
    const body = req.body;
    if (!body.message) return res.sendStatus(200);

    const chatId = body.message.chat.id;
    const userId = body.message.from?.id?.toString();
    const text = body.message.text;

    // Only allow your user(s)
    if (!ALLOWED_USER_IDS.includes(userId)) {
      await sendTelegram(chatId, "❌ Not allowed.");
      return res.sendStatus(200);
    }

    // Start
    if (text === "/start") {
      await sendTelegram(chatId, "👋 Send me an .m3u file.\nOr use /uploadserver to upload videos.");
      return res.sendStatus(200);
    }

    // ✅ Upload All Videos Command
    if (text === "/uploadserver") {
      await sendTelegram(chatId, "📂 Reading `1.m3u`...");
      const urls = await getM3UVideoLinks();
      if (!urls.length) {
        await sendTelegram(chatId, "⚠️ No video links found in 1.m3u.");
        return res.sendStatus(200);
      }

      uploadQueue[userId] = urls;

      let msg = `🎬 Found ${urls.length} videos:\n\n`;
      urls.forEach((u, i) => msg += `${i+1}. ${fileNameFromURL(u)}\n`);
      msg += "\nReply YES to start uploading.";

      await sendTelegram(chatId, msg);
      return res.sendStatus(200);
    }

    // ✅ Confirm Upload
    if (uploadQueue[userId] && text && text.toLowerCase() === "yes") {
      const urls = uploadQueue[userId];
      delete uploadQueue[userId];

      await sendTelegram(chatId, `📤 Uploading ${urls.length} videos...`);

      for (const url of urls) {
        const name = fileNameFromURL(url);
        try {
          await uploadVideo(url, name);
          await sendTelegram(chatId, `✅ Uploaded: ${name}`);
        } catch (err) {
          await sendTelegram(chatId, `❌ Failed: ${name} (${err.message})`);
        }
      }

      await sendTelegram(chatId, "🎉 Upload complete.");
      return res.sendStatus(200);
    }

    // ✅ Handle .m3u File Upload to GitHub (1.m3u)
    if (body.message.document) {
      if (!body.message.document.file_name.endsWith(".m3u")) {
        await sendTelegram(chatId, "❌ Only .m3u files allowed.");
        return res.sendStatus(200);
      }

      const fileId = body.message.document.file_id;
      const info = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`).then(r => r.json());
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
      const data = await fetch(url).then(r => r.arrayBuffer());

      const base64 = Buffer.from(new Uint8Array(data)).toString("base64");
      const sha = await getExistingSha("1.m3u");

      await githubPut("1.m3u", base64, sha);
      await sendTelegram(chatId, "✅ Updated 1.m3u on GitHub.");
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    logs.push(err.message);
    return res.sendStatus(500);
  }
});

// ✅ Dashboard Data
app.get("/logs", (req, res) => res.json(logs.slice(-20)));
app.get("/status", (req, res) => res.json({ active: true }));

// ✅ Helper Functions
async function sendTelegram(chatId, text) {
  const fetch = (await import("node-fetch")).default;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

function fileNameFromURL(url) {
  return decodeURIComponent(url.split("/").pop().split("?")[0]);
}

async function getM3UVideoLinks() {
  const fetch = (await import("node-fetch")).default;
  const text = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`).then(r => r.text());

  return text.split("\n").filter(l =>
    l.startsWith("http") &&
    !l.endsWith(".m3u8") &&
    (l.includes(".mkv") || l.includes(".mp4") || l.includes("seedr"))
  );
}

async function uploadVideo(url, name) {
  const fetch = (await import("node-fetch")).default;
  const FormData = (await import("form-data")).default;
  const fs = require("fs");

  const temp = `/tmp/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download ${response.status}`);
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));

  const form = new FormData();
  form.append("key", UPLOAD_KEY);
  form.append("file", fs.createReadStream(temp), name);

  const upload = await fetch(UPLOAD_URL, { method: "POST", body: form }).then(r => r.json()).catch(() => ({ ok:false }));
  fs.unlinkSync(temp);

  if (!upload.ok) throw new Error("Upload failed");
}

async function getExistingSha(path) {
  const fetch = (await import("node-fetch")).default;
  return fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}` }
  }).then(r => r.json()).then(j => j.sha).catch(() => null);
}

async function githubPut(path, content, sha) {
  const fetch = (await import("node-fetch")).default;
  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}` },
    body: JSON.stringify({
      message: "Update via Telegram bot",
      content,
      ...(sha ? { sha } : {})
    })
  });
}

module.exports = app;
