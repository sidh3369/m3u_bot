import fetch from "node-fetch";

const BOT_TOKEN = "8111045365:AAEzcnM_xAAePBOv8Mr7829d67VPx3cwtDw";
const ALLOWED_USER_IDS = [1098771509]; // Replace with your Telegram user ID


const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "yourusername/yourrepo"
const FILE_PATH = "1.m3u"; // file name/path in repo

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Hello from Telegram bot webhook!");
  }

  const update = req.body;

  if (!update.message) return res.status(200).send("No message");

  const fromId = update.message.from.id;

  if (!ALLOWED_USER_IDS.includes(fromId)) {
    await sendMessage(fromId, "❌ Unauthorized user");
    return res.status(200).send("Unauthorized user");
  }

  if (update.message.document) {
    const fileName = update.message.document.file_name;
    const fileId = update.message.document.file_id;

    if (!fileName.toLowerCase().endsWith(".m3u")) {
      await sendMessage(fromId, "❌ Only .m3u files accepted.");
      return res.status(200).send("Wrong file type");
    }

    // Download file content from Telegram
    const fileInfo = await getFile(update.message.document.file_id);
    if (!fileInfo) {
      await sendMessage(fromId, "❌ Failed to get file info.");
      return res.status(200).send("No file info");
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo}`;

    try {
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        await sendMessage(fromId, "❌ Failed to download file.");
        return res.status(200).send("Failed to download");
      }

      const fileText = await fileResponse.text();

      // Upload to GitHub
      const githubResult = await uploadToGitHub(fileText);

      if (githubResult.ok) {
        await sendMessage(fromId, `✅ File uploaded to GitHub!\n${githubResult.url}`);
      } else {
        await sendMessage(fromId, "❌ Failed to upload file to GitHub.");
      }

      return res.status(200).send("File processed");
    } catch (err) {
      console.error(err);
      await sendMessage(fromId, "❌ Error processing file.");
      return res.status(200).send("Error");
    }
  } else {
    await sendMessage(fromId, "📎 Please send a .m3u file.");
    return res.status(200).send("No document");
  }
}

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function getFile(fileId) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.ok && json.result && json.result.file_path) {
    return json.result.file_path;
  }
  return null;
}

async function uploadToGitHub(content) {
  const apiBase = "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + FILE_PATH;

  // First get the current file SHA if exists (required for update)
  let sha = null;
  const getResp = await fetch(apiBase, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (getResp.status === 200) {
    const getJson = await getResp.json();
    sha = getJson.sha;
  }

  const commitMessage = sha
    ? "Update 1.m3u via Telegram bot"
    : "Create 1.m3u via Telegram bot";

  const base64Content = Buffer.from(content).toString("base64");

  const putResp = await fetch(apiBase, {
    method: "PUT",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    body: JSON.stringify({
      message: commitMessage,
      committer: {
        name: "Telegram Bot",
        email: "bot@example.com",
      },
      content: base64Content,
      ...(sha ? { sha } : {}),
    }),
  });

  const putJson = await putResp.json();

  if (putResp.ok) {
    // Return the raw.githubusercontent URL for direct download
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${FILE_PATH}`;
    return { ok: true, url };
  } else {
    console.error("GitHub upload error:", putJson);
    return { ok: false };
  }
}
