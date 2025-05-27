export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Only POST allowed");

  const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const ALLOWED_USER_IDS = process.env.MY_ID?.split(',').map(id => id.trim());

  try {
    const body = req.body;

    if (!body.message || !body.message.document) {
      return res.status(200).send("No document");
    }

    const userId = body.message.from.id.toString();

    if (!ALLOWED_USER_IDS.includes(userId)) {
      await sendTelegramMessage(TELEGRAM_TOKEN, body.message.chat.id, "❌ Unauthorized user.");
      return res.status(200).send("Unauthorized user");
    }

    const document = body.message.document;
    if (!document.file_name.endsWith(".m3u")) {
      await sendTelegramMessage(TELEGRAM_TOKEN, body.message.chat.id, "⚠️ Only `.m3u` files are allowed.");
      return res.status(200).send("Invalid file");
    }

    const fileId = document.file_id;

    // Get file path
    const fileInfoResp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoResp.json();
    if (!fileInfo.ok) throw new Error("Failed to get file path");

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;

    // Download file content
    const fileResp = await fetch(fileUrl);
    const fileBuffer = await fileResp.arrayBuffer();
    const fileBase64 = Buffer.from(fileBuffer).toString("base64");

    // Get SHA for existing file
    const sha = await getGitHubFileSha(GITHUB_REPO, GITHUB_TOKEN, "1.m3u");

    // Upload to GitHub
    const uploadResp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/1.m3u`, {
      method: "PUT",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update 1.m3u via Telegram bot",
        content: fileBase64,
        ...(sha ? { sha } : {}),
      }),
    });

    const uploadResult = await uploadResp.json();

    if (uploadResp.ok) {
      await sendTelegramMessage(TELEGRAM_TOKEN, body.message.chat.id, `✅ Uploaded successfully.\n📁 File: https://raw.githubusercontent.com/${GITHUB_REPO}/main/1.m3u`);
    } else {
      console.error("GitHub upload failed:", uploadResult);
      throw new Error(uploadResult.message || "GitHub upload failed");
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Error:", error);
    if (req.body?.message?.chat?.id) {
      await sendTelegramMessage(process.env.BOT_TOKEN, req.body.message.chat.id, `❌ Error: ${error.message}`);
    }
    res.status(500).send("Error");
  }
}

// Telegram message sender
async function sendTelegramMessage(token, chat_id, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
}

// GitHub SHA checker
async function getGitHubFileSha(repo, token, path) {
  const resp = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    headers: { Authorization: `token ${token}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.sha;
}
