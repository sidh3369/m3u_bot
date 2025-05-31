const express = require('express');
const dotenv = require('dotenv');

// Load environment variables from .env file (for local dev)
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// 1. Validate environment variables
const { BOT_TOKEN, GITHUB_TOKEN, GITHUB_REPO, MY_ID } = process.env;
if (!BOT_TOKEN || !GITHUB_TOKEN || !GITHUB_REPO || !MY_ID) {
  console.error("Missing environment variables");
  process.exit(1);
}

// 2. Parse allowed user IDs (assuming MY_ID is a comma-separated string)
const ALLOWED_USER_IDS = MY_ID.split(",").map(id => id.trim());

// Main handler for Telegram webhook
app.post('/webhook', async (req, res) => {
  // Dynamically import node-fetch
  const fetch = (await import('node-fetch')).default;

  try {
    // 3. Validate incoming message and document
    const body = req.body;
    if (!body.message || !body.message.document) {
      return res.status(200).send("No document");
    }

    const userId = body.message.from?.id?.toString();
    if (!userId) {
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ No user ID found.");
      return res.status(200).send("No user ID");
    }

    // 4. Check authorization
    if (!ALLOWED_USER_IDS.includes(userId)) {
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ Unauthorized user.");
      return res.status(200).send("Unauthorized user");
    }

    const fileId = body.message.document.file_id;
    if (!fileId) {
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ No file ID in document.");
      return res.status(200).send("No file ID");
    }

    // 5. Validate file type (basic check for M3U)
    const fileName = body.message.document.file_name || "unknown.m3u";
    if (!fileName.toLowerCase().endsWith(".m3u")) {
      await sendTelegramMessage(BOT_TOKEN, body.message.chat.id, "❌ Only M3U files are allowed.");
      return res.status(200).send("Invalid file type");
    }

    // 6. Get file path from Telegram
    const fileInfoResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, {
      signal: AbortSignal.timeout(5000) // 5-second timeout
    });
    const fileInfo = await fileInfoResp.json();
    if (!fileInfo.ok) {
      throw new Error(`Failed to get file path: ${fileInfo.description || "Unknown error"}`);
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;

    // 7. Download file content
    const fileResp = await fetch(fileUrl, {
      signal: AbortSignal.timeout(10000) // 10-second timeout
    });
    if (!fileResp.ok) {
      throw new Error(`Failed to download file: ${fileResp.statusText}`);
    }
    const fileBuffer = await fileResp.arrayBuffer();

    // 8. Get SHA of existing file to overwrite
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
      signal: AbortSignal.timeout(10000) // 10-second timeout
    });

    const uploadResult = await uploadResp.json();
    if (!uploadResp.ok) {
      throw new Error(uploadResult.message || "GitHub upload failed");
    }

    // 10. Send success message
    await sendTelegramMessage(
      BOT_TOKEN,
      body.message.chat.id,
      `✅ Uploaded successfully.\nhttps://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`
    );
    res.status(200).send("OK");
  } catch (error) {
    console.error("Error:", error);
    if (req.body?.message?.chat?.id) {
      await sendTelegramMessage(BOT_TOKEN, req.body.message.chat.id, `❌ Error: ${error.message}`);
    }
    res.status(500).send("Error");
  }
});

// Helper to send message via Telegram
async function sendTelegramMessage(token, chat_id, text) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
    signal: AbortSignal.timeout(5000) // 5-second timeout
  });
  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram send failed: ${result.description || "Unknown error"}`);
  }
}

// Helper to get file SHA from GitHub (for overwriting)
async function getGitHubFileSha(repo, token, path) {
  const fetch = (await import('node-fetch')).default;
  const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}` },
    signal: AbortSignal.timeout(5000) // 5-second timeout
  });
  if (!resp.ok) return null; // Return null if file doesn’t exist (e.g., 404)
  const data = await resp.json();
  return data.sha;
}

// Export for Vercel (serverless)
module.exports = app;

// For local development, start the server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setWebhook();
  });
}

// Set Telegram webhook (run once during setup)
async function setWebhook() {
  const fetch = (await import('node-fetch')).default;
  const webhookUrl = process.env.WEBHOOK_URL; // e.g., https://your-app.vercel.app/webhook
  if (!webhookUrl) {
    console.error("WEBHOOK_URL not set in .env");
    return;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    const result = await response.json();
    if (result.ok) {
      console.log("Webhook set successfully:", webhookUrl);
    } else {
      console.error("Failed to set webhook:", result.description);
    }
  } catch (error) {
    console.error("Error setting webhook:", error);
  }
}
