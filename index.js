const express = require('express');
const dotenv = require('dotenv');

// Load env variables
dotenv.config();

const app = express();
app.use(express.json());

const logs = [];

const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID, WEBHOOK_URL } = process.env;

if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_REPO || !MY_ID || !WEBHOOK_URL) {
  const error = "❌ Missing environment variables.";
  console.error(error);
  logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
  process.exit(1);
}

const ALLOWED_USER_IDS = MY_ID.split(',').map(id => id.trim());

app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;

  logs.push({
    timestamp: new Date().toISOString(),
    type: 'info',
    message: 'Webhook triggered',
    raw: JSON.stringify(req.body)
  });

  try {
    const body = req.body;

    if (!body.message) {
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'No message in request' });
      return res.status(200).send("No message");
    }

    const chatId = body.message.chat.id;
    const userId = body.message.from?.id?.toString();
    const text = body.message.text;

    if (text === '/start') {
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `Start command from ${userId}` });
      await sendTelegramMessage(BOT_TOKEN, chatId, "👋 Welcome! Send me an .m3u file and I will upload it to GitHub.");
      return res.status(200).send("Start command handled");
    }

    if (!body.message.document) {
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'No document in message' });
      return res.status(200).send("No document");
    }

    if (!ALLOWED_USER_IDS.includes(userId)) {
      await sendTelegramMessage(BOT_TOKEN, chatId, "❌ Unauthorized user.");
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Unauthorized user: ${userId}` });
      return res.status(200).send("Unauthorized user");
    }

    const fileId = body.message.document.file_id;
    const fileName = body.message.document.file_name || "unknown.m3u";

    if (!fileName.toLowerCase().endsWith(".m3u")) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Invalid file type: ${fileName}` });
      await sendTelegramMessage(BOT_TOKEN, chatId, "❌ Only M3U files are allowed.");
      return res.status(200).send("Invalid file type");
    }

    const fileInfoResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoResp.json();

    if (!fileInfo.ok) throw new Error("Telegram file path fetch failed");

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const fileResp = await fetch(fileUrl);

    if (!fileResp.ok) throw new Error("Failed to download file");

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
  } catch (error) {
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error.message });
    console.error("Bot error:", error.message);
    if (req.body?.message?.chat?.id) {
      await sendTelegramMessage(BOT_TOKEN, req.body.message.chat.id, `❌ Error: ${error.message}`);
    }
    return res.status(500).send("Error");
  }
});

app.get('/logs', (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(logs.slice(-10));
  } catch (err) {
    res.status(500).send("Error reading logs");
  }
});

async function sendTelegramMessage(token, chat_id, text) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text })
  });
  const result = await response.json();
  if (!result.ok) {
    const error = `Telegram send failed: ${result.description || "Unknown error"}`;
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
    throw new Error(error);
  }
}

async function getGitHubFileSha(repo, token, path) {
  try {
    const resp = await githubFetch(`https://api.github.com/repos/${repo}/contents/${path}`);
    const data = await resp.json();
    return data.sha || null;
  } catch {
    logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `No existing file at ${path}` });
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
  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub authentication failed – check token or scopes");
  }
  return response;
}

// For Vercel export
module.exports = app;
