// api/check-env.js (Vercel serverless function)
export default function handler(req, res) {
  const requiredVars = ['BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO', 'MY_ID', 'WEBHOOK_URL'];
  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length === 0) {
    res.status(200).json({ success: true });
  } else {
    res.status(400).json({ success: false, error: `Missing: ${missing.join(', ')}` });
  }
}
