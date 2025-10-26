// server.js (node >= 14)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.json());
app.use(express.static('public')); // serve dashboard.html from /public

// Example REST endpoints used by the dashboard fallback and control buttons:
app.get('/status', (req, res) => res.json(getStatusSnapshot()));
app.get('/fileinfo', (req, res) => res.json(getFileInfo()));
app.get('/history', (req, res) => res.json(getHistory()));
app.get('/logs', (req, res) => res.json(getRecentLogs()));
app.get('/sysinfo', (req, res) => res.json(getSysInfo()));
app.get('/preview', (req,res) => res.json(getTopPreview()));

// simple control endpoints (protect these with auth in production)
app.post('/control/restart', (req, res) => { restartBot(); res.status(202).send({ok:true}); });
app.post('/control/rebuild', (req,res) => { rebuildPlaylist(); res.status(202).send({ok:true}); });
app.post('/control/clearlogs', (req,res) => { clearLogs(); res.status(202).send({ok:true}); });

wss.on('connection', ws => {
  console.log('dashboard connected');
  // send initial snapshot
  ws.send(JSON.stringify({type:'status', data: getStatusSnapshot()}));
  ws.send(JSON.stringify({type:'file', data: getFileInfo()}));
  ws.send(JSON.stringify({type:'sys', data: getSysInfo()}));
  ws.send(JSON.stringify({type:'history', data: getHistory()}));
  ws.send(JSON.stringify({type:'logs', data: getRecentLogs()}));
  ws.send(JSON.stringify({type:'preview', data: getTopPreview()}));

  // if your bot emits events, broadcast them. Example periodic push:
  const interval = setInterval(()=>{
    ws.send(JSON.stringify({type:'sys', data: getSysInfo()}));
    ws.send(JSON.stringify({type:'status', data: getStatusSnapshot()}));
  }, 3000);

  ws.on('message', msg => {
    try {
      const m = JSON.parse(msg);
      if (m.type === 'hello') {
        ws.send(JSON.stringify({type:'status', data:getStatusSnapshot()}));
      } else if (m.type === 'command' && m.cmd === 'refresh') {
        ws.send(JSON.stringify({type:'file', data: getFileInfo()}));
      }
    } catch(e) { console.warn(e); }
  });

  ws.on('close', ()=> clearInterval(interval));
});

server.listen(3000, ()=> console.log('listening on :3000'));

/* ===== Mock snapshots – replace with real collectors ===== */
function getStatusSnapshot(){
  return { active: true, uptime: '3h 12m', version:'2.3.0', pid: process.pid, ping: Math.floor(Math.random()*60) };
}
function getFileInfo(){
  return { name:'1.m3u', size:1851234, uploaded: new Date().toISOString(), items: 420, sha256: 'abc123...' };
}
function getHistory(){ return [ getFileInfo(), /* ... up to 10 */]; }
function getRecentLogs(){ return [{ timestamp:new Date().toISOString(), type:'INFO', message:'Parsed file', raw:'{}' }]; }
function getSysInfo(){ return { cpu: Math.round(Math.random()*50), memory: Math.round(Math.random()*80), disk: 60, uptime: '5h' }; }
function getTopPreview(){ return [{ title:'Channel 1'}, {title:'Channel 2'}]; }
function restartBot(){ console.log('restart requested'); }
function rebuildPlaylist(){ console.log('rebuild requested'); }
function clearLogs(){ console.log('clear logs requested'); }
