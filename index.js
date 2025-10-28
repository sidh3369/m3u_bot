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

app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;
  try {
    const body = req.body;
    if (!body.message) return res.sendStatus(200);

    const chatId = body.message.chat.id;
    const userId = body.message.from.id.toString();
    const text = body.message.text?.trim();

    logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `Message from ${userId}: ${text}` });

    // /start
    if (text === '/start') {
      await sendTelegramMessage(BOT_TOKEN, chatId,
        "👋 Welcome!\n\nSend me a `.m3u` file to update it on GitHub.\nOr send `/uploadserver` to upload videos from playlist to your server."
      );
      return res.sendStatus(200);
    }

    // /uploadserver → Read playlist links
    if (text === '/uploadserver') {
      const urls = await getM3ULinks(GITHUB_REPO);

      if (!urls.length) {
        await sendTelegramMessage(BOT_TOKEN, chatId, "⚠️ No video links found in `1.m3u`.");
        return res.sendStatus(200);
      }

      uploadQueue[userId] = urls;

      let msg = `🎬 Found ${urls.length} videos:\n\n`;
      urls.forEach((u, i) => msg += `${i+1}. ${decodeURIComponent(u.split('/').pop().split('?')[0])}\n`);
      msg += "\nReply YES to start uploading.";

      await sendTelegramMessage(BOT_TOKEN, chatId, msg);
      return res.sendStatus(200);
    }

    // ✅ Detect "YES" reply → Start uploading
    if (uploadQueue[userId] && text.toLowerCase() === 'yes') {
      const urls = uploadQueue[userId];
      delete uploadQueue[userId];

      await sendTelegramMessage(BOT_TOKEN, chatId, `📤 Uploading ${urls.length} video(s)...`);
      for (const url of urls) {
        const fileName = decodeURIComponent(url.split('/').pop().split('?')[0]);

        try {
          await downloadAndUpload(url, fileName);
          await sendTelegramMessage(BOT_TOKEN, chatId, `✅ Uploaded: ${fileName}`);
        } catch (err) {
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Failed: ${fileName}\nReason: ${err.message}`);
        }
      }

      await sendTelegramMessage(BOT_TOKEN, chatId, "🎉 Upload Completed.");
      return res.sendStatus(200);
    }
     // ✅ Upload `.m3u` file to GitHub
    if (body.message.document) {
      const fileName = body.message.document.file_name;
      if (!fileName.toLowerCase().endsWith(".m3u")) return res.sendStatus(200);

      const fileId = body.message.document.file_id;
      const info = await (await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`)).json();
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
      const bin = await (await fetch(url)).arrayBuffer();
      const base64 = Buffer.from(new Uint8Array(bin)).toString("base64");
      const sha = await getGitHubFileSha(GITHUB_REPO, GITHUB_TOKEN, "1.m3u");

      await githubFetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/1.m3u`, {
        method: "PUT",
        body: JSON.stringify({
          message: "Updated via bot",
          content: base64,
          ...(sha ? { sha } : {})
        })
      });

      await sendTelegramMessage(BOT_TOKEN, chatId, "✅ `1.m3u` updated on GitHub.");
      return res.sendStatus(200);
    }

    return res.sendStatus(200);

  } catch (err) {
    console.log("Webhook error:", err.message);
    return res.sendStatus(500);
  }
});

// ✅ Dashboard Data
app.get("/logs", (req, res) => res.json(logs.slice(-20)));
app.get("/status", (req, res) => res.json({ active: true }));

async function sendTelegramMessage(token, chat_id, text, keyboard = null) {
  const fetch = (await import('node-fetch')).default;

  const payload = {
    chat_id,
    text,
    parse_mode: "HTML"
  };

  if (keyboard) {
    payload.reply_markup = { inline_keyboard: keyboard };
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
