// api/check-webhook.js
import axios from 'axios';

export default async function handler(req, res) {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getWebhookInfo`);
    const webhookInfo = response.data.result;
    const isSet = webhookInfo.url === process.env.WEBHOOK_URL;
    res.status(200).json({ success: isSet, error: isSet ? null : 'Webhook URL mismatch' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}
