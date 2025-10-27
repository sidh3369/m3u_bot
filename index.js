// index.js
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const logs = [];
const uploadQueue = {};

const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID, WEBHOOK_URL, UPLOAD_URL, UPLOAD_KEY } = process.env;
const ALLOWED_USER_IDS = (MY_ID || '').split(',').map(id => id.trim());

// ✅ TELEGRAM WEBHOOK
app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;

  try {
    const body = req.body;
    if (!body.message) return res.status(200).send("No message");
    const chatId = body.message.chat.id;
    const userId = body.message.from?.id?.toString();
    const text = body.message.text;

    logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `Webhook from ${userId}`, raw: text });

    if (text === '/start') {
      await sendTelegramMessage(BOT_TOKEN, chatId, "👋 Welcome! Send me an .m3u file or use /uploadserver to upload videos from 1.m3u.");
      return res.status(200).send("Start command");
    }

    // ✅ Handle Upload Command
    if (text === '/uploadserver') {
      await sendTelegramMessage(BOT_TOKEN, chatId, "📂 Reading 1.m3u from GitHub...");
      const urls = await getM3ULinks(GITHUB_REPO);
      if (!urls.length) {
        await sendTelegramMessage(BOT_TOKEN, chatId, "⚠️ No valid video links found in 1.m3u.");
        return res.status(200).send("No videos found");
      }

      let msg = `🎬 Found ${urls.length} videos:\n`;
      urls.forEach((u, i) => msg += `${i + 1}. ${decodeURIComponent(u.split('/').pop().split('?')[0])}\n`);
      msg += "\nDo you want to upload all to your server? Reply YES or NO.";
      uploadQueue[userId] = urls;
      await sendTelegramMessage(BOT_TOKEN, chatId, msg);
      return res.status(200).send("Upload command processed");
    }

    // ✅ If user replies YES
    if (uploadQueue[userId] && text && text.toLowerCase() === 'yes') {
      const urls = uploadQueue[userId];
      delete uploadQueue[userId];

      await sendTelegramMessage(BOT_TOKEN, chatId, `📤 Uploading ${urls.length} videos to your server...`);

      for (const videoUrl of urls) {
        const fileName = decodeURIComponent(videoUrl.split('/').pop().split('?')[0]);
        try {
          await downloadAndUpload(videoUrl, fileName);
          logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `Uploaded ${fileName}` });
          await sendTelegramMessage(BOT_TOKEN, chatId, `✅ Uploaded ${fileName}`);
        } catch (err) {
          logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Failed ${fileName}: ${err.message}` });
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Failed ${fileName}: ${err.message}`);
        }
      }
      await sendTelegramMessage(BOT_TOKEN, chatId, "🎉 Upload completed.");
      return res.status(200).send("Uploads done");
    }

    return res.status(200).send("OK");
  } catch (err) {
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: err.message });
    console.error(err);
    return res.status(500).send("Error");
  }
});

// ✅ DASHBOARD ROUTES
app.get('/logs', (req, res) => res.json(logs.slice(-20)));
app.get('/status', (req, res) => res.json({ active: true, time: new Date().toISOString() }));

// ✅ Functions
async function sendTelegramMessage(token, chat_id, text) {
  const fetch = (await import('node-fetch')).default;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text })
  });
}

async function getM3ULinks(repo) {
  const fetch = (await import('node-fetch')).default;
  try {
    const m3uUrl = `https://raw.githubusercontent.com/${repo}/main/1.m3u`;
    const res = await fetch(m3uUrl);
    const text = await res.text();

    // filter video links only
    return text.split('\n').filter(l =>
      l.startsWith('http') &&
      !l.includes('.m3u8') &&
      (l.endsWith('.mp4') || l.endsWith('.mkv') || l.includes('seedr.cc'))
    );
  } catch (err) {
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'Failed to fetch 1.m3u' });
    return [];
  }
}

async function downloadAndUpload(videoUrl, fileName) {
  const fetch = (await import('node-fetch')).default;
  const FormData = (await import('form-data')).default;
  const fs = require('fs');

  const tmp = `/tmp/${fileName}`;
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  fs.writeFileSync(tmp, Buffer.from(buf));

  const form = new FormData();
  form.append('key', UPLOAD_KEY);
  form.append('file', fs.createReadStream(tmp), fileName);

  const uploadRes = await fetch(UPLOAD_URL, { method: 'POST', body: form });
  const result = await uploadRes.json().catch(() => ({}));

  fs.unlinkSync(tmp);
  if (!uploadRes.ok || !result.ok) throw new Error(result.error || "Upload failed");
  return result;
}

// ✅ Export for Vercel
module.exports = app;
