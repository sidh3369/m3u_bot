import fetch from "node-fetch";

const BOT_TOKEN = "8111045365:AAEzcnM_xAAePBOv8Mr7829d67VPx3cwtDw";
const ALLOWED_USER_IDS = [1098771509]; // Replace with your Telegram user ID

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Hello from Telegram bot webhook!");
  }

  const update = req.body;

  // Basic validation
  if (!update.message) return res.status(200).send("No message");

  const fromId = update.message.from.id;

  if (!ALLOWED_USER_IDS.includes(fromId)) {
    await sendMessage(fromId, "❌ Unauthorized user");
    return res.status(200).send("Unauthorized user");
  }

  // Check if message has document (file)
  if (update.message.document) {
    const fileName = update.message.document.file_name;
    const fileId = update.message.document.file_id;

    if (!fileName.toLowerCase().endsWith(".m3u")) {
      await sendMessage(fromId, "❌ Only .m3u files are accepted.");
      return res.status(200).send("Wrong file type");
    }

    // Get file path from Telegram API
    const fileInfo = await getFile(fileId);
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

      // === Here you would save the fileText to persistent storage ===
      // Vercel has no persistent disk in serverless functions.
      // You can save to cloud storage (AWS S3, Supabase, etc.).
      // For demo, just confirm receipt.

      console.log("Received .m3u file content:", fileText.slice(0, 100), "...");

      await sendMessage(fromId, "✅ .m3u file received successfully!");

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

// Helper to send message to user
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Helper to get file path from Telegram API
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
