// pages/index.js
export default function Home() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: '2rem' }}>
      <h1>📡 Telegram M3U Bot</h1>
      <p>This bot receives `.m3u` files from authorized users on Telegram and uploads them to GitHub as <code>1.m3u</code>.</p>
      <p>Status: ✅ Webhook Active</p>
    </div>
  );
}
