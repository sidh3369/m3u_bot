// index.js — Telegram M3U Bot + Seedr uploader + Dashboard
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const app = express();
app.use(express.json());

// ✅ Serve dashboard HTML
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- LOG STORAGE ---
const logs = [];
const uploadQueue = {};

// --- ENVIRONMENT VARIABLES ---
const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID, WEBHOOK_URL } = process.env;

// --- Safe check ---
if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_REPO || !MY_ID || !WEBHOOK_URL) {
  const warning = "⚠️ Missing one or more environment variables (BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID, WEBHOOK_URL)";
  console.warn(warning);
  logs.push({ timestamp: new Date().toISOString(), type: 'warn', message: warning });
}

const ALLOWED_USER_IDS = (MY_ID || '').split(',').map(id => id.trim());

// --- TELEGRAM WEBHOOK ---
app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;
  const body = req.body;
  logs.push({
    timestamp: new Date().toISOString(),
    type: 'info',
    message: 'Webhook triggered',
    raw: JSON.stringify(body)
  });

  try {
    if (!body.message) return res.status(200).send("No message");
    const chatId = body.message.chat.id;
    const userId = body.message.from?.id?.toString();
    const text = body.message.text;
    const data = body.callback_query?.data || text;

    // --- START COMMAND ---
    if (text === '/start') {
      await sendTelegramMessage(BOT_TOKEN, chatId, "👋 Welcome! Send me an .m3u file or use /uploadserver to upload Seedr videos.");
      return res.status(200).send("Start handled");
    }

    // --- M3U UPLOAD HANDLER ---
    if (body.message.document) {
      if (!ALLOWED_USER_IDS.includes(userId)) {
        await sendTelegramMessage(BOT_TOKEN, chatId, "❌ Unauthorized user.");
        return res.status(200).send("Unauthorized");
      }

      const fileId = body.message.document.file_id;
      const fileName = body.message.document.file_name || "unknown.m3u";
      if (!fileName.toLowerCase().endsWith(".m3u")) {
        await sendTelegramMessage(BOT_TOKEN, chatId, "❌ Only M3U files are allowed.");
        return res.status(200).send("Invalid type");
      }

      const fileInfoResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileInfo = await fileInfoResp.json();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
      const fileResp = await fetch(fileUrl);
      const fileBuffer = await fileResp.arrayBuffer();
      const base64Content = Buffer.from(new Uint8Array(fileBuffer)).toString("base64");

      const sha = await getGitHubFileSha(GITHUB_REPO, GITHUB_TOKEN, "1.m3u");
      const uploadResp = await githubFetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/1.m3u`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Update 1.m3u via Telegram bot",
          content: base64Content,
          ...(sha ? { sha } : {})
        })
      });

      const uploadResult = await uploadResp.json();
      if (!uploadResp.ok) throw new Error(uploadResult.message || "GitHub upload failed");

      await sendTelegramMessage(BOT_TOKEN, chatId, `✅ Uploaded successfully.\nhttps://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`);
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'File uploaded successfully' });
      return res.status(200).send("OK");
    }

    // --- Upload Videos from Seedr ---
    if (data === 'upload_videos') {
      handleUploadVideos(chatId);
      return res.status(200).send("Started upload_videos");
    }

    // --- /uploadserver Command ---
    if (text === '/uploadserver') {
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `Upload to server command from ${userId}` });
      await sendTelegramMessage(BOT_TOKEN, chatId, "📂 Fetching videos from Seedr.cc...");
      try {
        const files = await fetchSeedrVideos(process.env.SEEDR_TOKEN);
        if (!files.length) {
          await sendTelegramMessage(BOT_TOKEN, chatId, "⚠️ No downloadable videos found in your Seedr.");
          return res.status(200).send("No videos found");
        }
        let msg = "Found these files:\n";
        files.forEach((f, i) => { msg += `${i + 1}. ${f.name}\n`; });
        msg += "\nDo you want to upload all to your server? Reply YES or NO.";
        await sendTelegramMessage(BOT_TOKEN, chatId, msg);
        uploadQueue[userId] = files;
      } catch (err) {
        await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Error fetching Seedr files: ${err.message}`);
      }
      return res.status(200).send("Upload command processed");
    }

    // --- Confirm Upload ---
    if (uploadQueue[userId] && text && text.toLowerCase() === 'yes') {
      const files = uploadQueue[userId];
      delete uploadQueue[userId];
      await sendTelegramMessage(BOT_TOKEN, chatId, `📤 Uploading ${files.length} videos to your server...`);
      for (const f of files) {
        try {
          const res = await fetch(process.env.UPLOAD_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              key: process.env.UPLOAD_KEY,
              video_url: f.url,
              name: f.name
            })
          });
          const text = await res.text();
          logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `Uploaded ${f.name}`, raw: text });
          await sendTelegramMessage(BOT_TOKEN, chatId, `✅ ${f.name} uploaded.`);
        } catch (e) {
          logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Upload failed for ${f.name}` });
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Upload failed for ${f.name}`);
        }
      }
      return res.status(200).send("Uploads done");
    }

    return res.status(200).send("Unhandled");
  } catch (err) {
    console.error("Webhook error:", err.message);
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: err.message });
    return res.status(500).send("Error");
  }
});

// --- HELPER: Upload Videos ---
async function handleUploadVideos(chatId) {
  await sendTelegramMessage(BOT_TOKEN, chatId, "🔍 Parsing 1.m3u and preparing uploads...");
  await uploadVideosFromSeedr(chatId);
}

// --- SUPPORT FUNCTIONS ---
async function sendTelegramMessage(token, chat_id, text) {
  const fetch = (await import('node-fetch')).default;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text })
  });
}

async function getGitHubFileSha(repo, token, path) {
  try {
    const resp = await githubFetch(`https://api.github.com/repos/${repo}/contents/${path}`);
    const data = await resp.json();
    return data.sha || null;
  } catch {
    return null;
  }
}

async function githubFetch(url, options = {}) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  return response;
}

// --- Fetch Seedr Video Files ---
async function fetchSeedrVideos(token) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch("https://www.seedr.cc/rest/folder", {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await resp.json();
  if (!data.folders && !data.torrents) return [];

  const files = [];
  function collectFiles(obj) {
    if (obj.files) {
      obj.files.forEach(f => {
        if (f.name.endsWith(".mp4") || f.name.endsWith(".mkv")) {
          files.push({ name: f.name, url: f.stream_url });
        }
      });
    }
    if (obj.folders) obj.folders.forEach(collectFiles);
  }
  collectFiles(data);
  return files;
}

// --- Dashboard APIs ---
app.get("/logs", (req, res) => res.json(logs.slice(-10)));
app.get("/status", (req, res) => res.json({
  version: "1.0.0", active: true, uptime: process.uptime().toFixed(0) + "s"
}));
app.get("/fileinfo", (req, res) => res.json({ name: "1.m3u", size: 102400 }));
app.get("/sysinfo", (req, res) => res.json({ cpu: Math.random() * 100, memory: Math.random() * 100 }));

// ✅ Export for Vercel
module.exports = app;
