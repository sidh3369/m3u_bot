// index.js
const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const logs = [];
const uploadQueue = {};

// ENV
const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID, WEBHOOK_URL, SEEDR_TOKEN, UPLOAD_URL, UPLOAD_KEY, CHECK_URL } = process.env;

if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_REPO || !MY_ID) {
  console.warn('⚠️ Missing one or more environment variables!');
}

// ✅ ALLOWED USER IDS
const ALLOWED_USER_IDS = (MY_ID || '').split(',').map(id => id.trim());

// ========== TELEGRAM WEBHOOK HANDLER ==========
app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;
  const body = req.body;
  if (!body.message) return res.status(200).send('No message');

  const chatId = body.message.chat.id;
  const userId = body.message.from?.id?.toString();
  const text = body.message.text;
  const document = body.message.document;
  const callback = body.callback_query?.data;

  try {
    // --- Start command ---
    if (text === '/start') {
      await sendTelegramMessage(BOT_TOKEN, chatId, '👋 Welcome! Send an .m3u file or use /uploadserver to upload videos from Seedr.cc');
      return res.status(200).send('OK');
    }

    // --- Upload .m3u to GitHub ---
    if (document && document.file_name.toLowerCase().endsWith('.m3u')) {
      if (!ALLOWED_USER_IDS.includes(userId)) {
        await sendTelegramMessage(BOT_TOKEN, chatId, '❌ Unauthorized user.');
        return res.status(200).send('Unauthorized');
      }

      const fileId = document.file_id;
      const fileInfoResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileInfo = await fileInfoResp.json();
      if (!fileInfo.ok) throw new Error('Telegram getFile failed');

      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
      const fileResp = await fetch(fileUrl);
      if (!fileResp.ok) throw new Error('Failed to download file');

      const fileBuffer = await fileResp.arrayBuffer();
      const base64Content = Buffer.from(new Uint8Array(fileBuffer)).toString('base64');
      const sha = await getGitHubFileSha(GITHUB_REPO, GITHUB_TOKEN, '1.m3u');

      const uploadResp = await githubFetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/1.m3u`, {
        method: 'PUT',
        body: JSON.stringify({
          message: 'Update 1.m3u via Telegram bot',
          content: base64Content,
          ...(sha ? { sha } : {})
        })
      });

      const result = await uploadResp.json();
      if (!uploadResp.ok) throw new Error(result.message || 'GitHub upload failed');

      await sendTelegramMessage(BOT_TOKEN, chatId, `✅ Uploaded successfully!\n\n📂 https://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`);
      logs.push({ type: 'info', message: 'File uploaded successfully' });
      return res.status(200).send('OK');
    }

    // --- Upload videos from Seedr ---
    if (text === '/uploadserver') {
      await sendTelegramMessage(BOT_TOKEN, chatId, '📂 Fetching videos from Seedr.cc...');
      const files = await fetchSeedrVideos(SEEDR_TOKEN);
      if (!files.length) {
        await sendTelegramMessage(BOT_TOKEN, chatId, '⚠️ No downloadable videos found in Seedr.');
        return res.status(200).send('No videos');
      }

      uploadQueue[userId] = files;
      let msg = `Found ${files.length} videos:\n`;
      files.forEach((f, i) => { msg += `${i + 1}. ${f.name}\n`; });
      msg += '\nDo you want to upload all to your server? Reply YES or NO.';
      await sendTelegramMessage(BOT_TOKEN, chatId, msg);
      return res.status(200).send('Upload ready');
    }

    // --- User confirms upload ---
    if (uploadQueue[userId] && text && text.toLowerCase() === 'yes') {
      const files = uploadQueue[userId];
      delete uploadQueue[userId];
      await sendTelegramMessage(BOT_TOKEN, chatId, `📤 Uploading ${files.length} videos to server...`);

      for (const f of files) {
        try {
          const r = await fetch(UPLOAD_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: UPLOAD_KEY,
              video_url: f.url,
              name: f.name
            })
          });

          if (!r.ok) throw new Error(await r.text());
          await sendTelegramMessage(BOT_TOKEN, chatId, `✅ ${f.name} uploaded.`);
        } catch (err) {
          await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Failed ${f.name}: ${err.message}`);
        }
      }
      await sendTelegramMessage(BOT_TOKEN, chatId, '🎉 All uploads complete.');
      return res.status(200).send('Done');
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error('Bot error:', e);
    logs.push({ type: 'error', message: e.message });
    await sendTelegramMessage(BOT_TOKEN, chatId, `❌ Error: ${e.message}`);
    return res.status(500).send('Error');
  }
});

// ========== API for Dashboard ==========
app.get('/logs', (req, res) => res.json(logs.slice(-20)));
app.get('/status', (req, res) => res.json({ version: '1.0.0', uptime: process.uptime().toFixed(0) + 's' }));

// ========== Helper Functions ==========
async function sendTelegramMessage(token, chat_id, text) {
  const fetch = (await import('node-fetch')).default;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text })
  });
}

async function getGitHubFileSha(repo, token, path) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.sha || null;
}

async function githubFetch(url, options) {
  const fetch = (await import('node-fetch')).default;
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
}

async function fetchSeedrVideos(token) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://www.seedr.cc/rest/folder', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  const videos = [];

  function walk(obj) {
    if (obj.files) {
      for (const f of obj.files) {
        if (f.name.endsWith('.mp4') || f.name.endsWith('.mkv'))
          videos.push({ name: f.name, url: f.stream_url });
      }
    }
    if (obj.folders) obj.folders.forEach(walk);
  }

  walk(data);
  return videos;
}

// ✅ Export app for Vercel
module.exports = app;
