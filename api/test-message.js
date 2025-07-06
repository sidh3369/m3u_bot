// api/test-message.js
import axios from 'axios';

export default async function handler(req, res) {
  try {
    // Simulate sending a test message to the bot (replace with actual Telegram API call or log check)
    const logResponse = await fetch('https://your-vercel-app.vercel.app/api/logs');
    const logs = await logResponse.json();
    const hasNoDocument = logs.some(log => log.message.includes('No document'));
    res.status(200).json({ success: hasNoDocument, error: hasNoDocument ? null : 'No document response not found' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
