const express = require('express');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// In-memory log store
const logs = [];

// Validate environment variables
const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID, WEBHOOK_URL } = process.env;
if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_REPO || !MY_ID || !WEBHOOK_URL) {
  const error = "Missing environment variables";
  console.error(error);
  logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
  process.exit(1);
}

const ALLOWED_USER_IDS = MY_ID.split(",").map(id => id.trim());

// Telegram webhook handler
app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;
  try {
    const body = req.body;

    if (!body.message || !body.message.document) {
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'No document in request' });
      return res.status(200).send("No document");
    }

    const userId = body.message.from?.id?.toString();
    if (!userId) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'No user ID found' });
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ No user ID found.");
      return res.status(200).send("No user ID");
    }

    if (!ALLOWED_USER_IDS.includes(userId)) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Unauthorized user: ${userId}` });
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ Unauthorized user.");
      return res.status(200).send("Unauthorized user");
    }

    const fileId = body.message.document.file_id;
    const fileName = body.message.document.file_name || "unknown.m3u";

    if (!fileName.toLowerCase().endsWith(".m3u")) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Invalid file type: ${fileName}` });
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ Only M3U files are allowed.");
      return res.status(200).send("Invalid file type");
    }

    const fileInfoResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, {
      signal: AbortSignal.timeout(5000)
    });
    const fileInfo = await fileInfoResp.json();
    if (!fileInfo.ok) throw new Error(`Failed to get file path: ${fileInfo.description || "Unknown error"}`);

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
    const fileResp = await fetch(fileUrl, { signal: AbortSignal.timeout(10000) });

    if (!fileResp.ok) throw new Error(`Failed to download file: ${fileResp.statusText}`);

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

    await sendTelegramMessage(
      BOT_TOKEN,
      body.message.chat.id,
      `✅ Uploaded successfully.\nhttps://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`
    );
    logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'File uploaded successfully' });
    res.status(200).send("OK");
  } catch (error) {
    console.error("Error:", error.message);
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error.message });
    if (req.body?.message?.chat?.id) {
      await sendTelegramMessage(BOT_TOKEN, req.body.message.chat.id, `❌ Error: ${error.message}`);
    }
    res.status(500).send("Error");
  }
});

// Logs viewer
app.get('/logs', (req, res) => {
  res.json(logs.slice(-10));
});

// Helper: Send message via Telegram
async function sendTelegramMessage(token, chat_id, text) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
    signal: AbortSignal.timeout(5000)
  });
  const result = await response.json();
  if (!result.ok) {
    const error = `Telegram send failed: ${result.description || "Unknown error"}`;
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
    throw new Error(error);
  }
}

// Helper: Get SHA of existing file in GitHub
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

// GitHub request wrapper with auth + timeout
async function githubFetch(url, options = {}) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("GitHub authentication failed – check token or scopes");
  }
  return response;
}

// Local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await setWebhook();
    await assertGitHubTokenWorks();
  });
}

// Validate GitHub token at startup
async function assertGitHubTokenWorks() {
  try {
    const resp = await githubFetch("https://api.github.com/user");
    const data = await resp.json();
    logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `GitHub auth verified as ${data.login}` });
  } catch (err) {
    console.error("GitHub token check failed:", err.message);
    process.exit(1);
  }
}

// Set Telegram webhook
async function setWebhook() {
  const fetch = (await import('node-fetch')).default;
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}`);
    const result = await response.json();
    if (result.ok) {
      console.log("Webhook set successfully:", WEBHOOK_URL);
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'Webhook set: ' + WEBHOOK_URL });
    } else {
      console.error("Failed to set webhook:", result.description);
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'Webhook set failed: ' + result.description });
    }
  } catch (error) {
    console.error("Webhook error:", error.message);
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'Webhook error: ' + error.message });
  }
}

// Export for Vercel/Serverless
module.exports = app;
