export default function Home() {
    return (
      <div style={{
        fontFamily: 'Arial',
        maxWidth: '600px',
        margin: '50px auto',
        textAlign: 'center',
        padding: '20px',
        border: '1px solid #ccc',
        borderRadius: '12px',
        backgroundColor: '#f9f9f9'
      }}>
        <h1>📺 M3U Upload Bot</h1>
        <p>✅ Telegram bot is connected.</p>
        <p>📁 Uploaded file link:</p>
        <a
          href="https://raw.githubusercontent.com/sidh3369/m3u_bot/main/1.m3u"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#0070f3', fontWeight: 'bold' }}
        >
          View 1.m3u on GitHub
        </a>
        <hr />
        <p>🔒 Only allowed Telegram users can upload `.m3u` files.</p>
      </div>
    );
  }
  
