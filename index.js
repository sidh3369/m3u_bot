const express = require('express');
const dotenv = require('dotenv');

// Load environment variables (for local dev)
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// In-memory log store (resets on serverless restart; use a DB for production)
const logs = [];

// 1. Validate environment variables
const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID } = process.env;
if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_REPO || !MY_ID) {
  const error = "Missing environment variables";
  console.error(error);
  logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
  process.exit(1);
}

// 2. Parse allowed user IDs
const ALLOWED_USER_IDS = MY_ID.split(",").map(id => id.trim());

// Main handler for Telegram webhook
app.post('/webhook', async (req, res) => {
  const fetch = (await import('node-fetch')).default;
  try {
    // 3. Validate incoming message and document
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

    // 4. Check authorization
    if (!ALLOWED_USER_IDS.includes(userId)) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Unauthorized user: ${userId}` });
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ Unauthorized user.");
      return res.status(200).send("Unauthorized user");
    }

    const fileId = body.message.document.file_id;
    if (!fileId) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'No file ID in document' });
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ No file ID in document.");
      return res.status(200).send("No file ID");
    }

    // 5. Validate file type
    const fileName = body.message.document.file_name || "unknown.m3u";
    if (!fileName.toLowerCase().endsWith(".m3u")) {
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: `Invalid file type: ${fileName}` });
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ Only M3U files are allowed.");
      return res.status(200).send("Invalid file type");
    }

    // 6. Get file path from Telegram
    const fileInfoResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, {
      signal: AbortSignal.timeout(5000)
    });
    const fileInfo = await fileInfoResp.json();
    if (!fileInfo.ok) {
      const error = `Failed to get file path: ${fileInfo.description || "Unknown error"}`;
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
      throw new Error(error);
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;

    // 7. Download file content
    const fileResp = await fetch(fileUrl, {
      signal: AbortSignal.timeout(10000)
    });
    if (!fileResp.ok) {
      const error = `Failed to download file: ${fileResp.statusText}`;
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
      throw new Error(error);
    }
    const fileBuffer = await fileResp.arrayBuffer();

    // 8. Get SHA of existing file
    const sha = await getGitHubFileSha(GITHUB_REPO, GITHUB_TOKEN, "1.m3u");

    // 9. Upload to GitHub
    const uploadResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/1.m3u`, {
      method: "PUT",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update 1.m3u via Telegram bot",
        content: Buffer.from(fileBuffer).toString("base64"),
        ...(sha ? { sha } : {}),
      }),
      signal: AbortSignal.timeout(10000)
    });

    const uploadResult = await uploadResp.json();
    if (!uploadResp.ok) {
      const error = uploadResult.message || "GitHub upload failed";
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
      throw new Error(error);
    }

    // 10. Send success message
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

// Logs endpoint
app.get('/logs', (req, res) => {
  res.json(logs.slice(-10)); // Return last 10 logs
});

// Helper to send message via Telegram
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

// Helper to get file SHA from GitHub
async function getGitHubFileSha(repo, token, path) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}` },
    signal: AbortSignal.timeout(5000)
  });
  if (!resp.ok) {
    logs.push({ timestamp: new Date().toISOString(), type: 'info', message: `No existing file at ${path}` });
    return null;
  }
  const data = await resp.json();
  return data.sha;
}

// Export for Vercel
module.exports = app;

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setWebhook();
  });
}

// Set Telegram webhook
async function setWebhook() {
  const fetch = (await import('node-fetch')).default;
  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    const error = "WEBHOOK_URL not set";
    console.error(error);
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: error });
    return;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    const result = await response.json();
    if (result.ok) {
      console.log("Webhook set successfully:", webhookUrl);
      logs.push({ timestamp: new Date().toISOString(), type: 'info', message: 'Webhook set successfully: ' + webhookUrl });
    } else {
      console.error("Failed to set webhook:", result.description);
      logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'Failed to set webhook: ' + result.description });
    }
  } catch (error) {
    console.error("Error setting webhook:", error);
    logs.push({ timestamp: new Date().toISOString(), type: 'error', message: 'Error setting webhook: ' + error.message });
  }
}
