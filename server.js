// Chatcord – servidor HTTP + WebSocket (sinalização WebRTC, chat e estado dos canais)
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const PORT = Number(process.env.PORT) || 3000;
const MAX_HISTORY = 200;

/* ---------- ICE (STUN/TURN) entregue aos clientes ---------- */
const iceServers = [
  { urls: (process.env.STUN_URLS || "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302").split(",").map(s => s.trim()) },
];
if (process.env.TURN_URL) {
  iceServers.push({ urls: process.env.TURN_URL.split(",").map(s => s.trim()), username: process.env.TURN_USER || "", credential: process.env.TURN_PASS || "" });
}

/* ---------- Persistência simples em JSON ---------- */
const uid = () => crypto.randomBytes(6).toString("hex");
let db = { servers: [], messages: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { /* primeira execução */ }
if (!db.servers?.length) {
  db.servers = [{ id: uid(), name: "Chatcord", channels: [
    { id: uid(), name: "geral", type: "text" },
    { id: uid(), name: "Sala 1", type: "voice" },
    { id: uid(), name: "Sala 2", type: "voice" },
  ] }];
}
db.messages ||= {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(DATA_FILE + ".tmp", JSON.stringify(db), err => { if (!err) fs.rename(DATA_FILE + ".tmp", DATA_FILE, () => {}); });
  }, 300);
}
const findChannel = id => { for (const s of db.servers) for (const c of s.channels) if (c.id === id) return c; return null; };

/* ---------- HTTP estático ---------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
const handler = (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)" });
    res.end(buf);
  });
};
const server = process.env.SSL_KEY && process.env.SSL_CERT
  ? https.createServer({ key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) }, handler)
  : http.createServer(handler);

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
const clients = new Map(); // id -> { ws, name, voice, state }

const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = o => { for (const c of clients.values()) send(c.ws, o); };
const slug = s => String(s || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 30);
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

function voiceMap() {
  const out = {};
  for (const [id, c] of clients) if (c.voice) (out[c.voice] ||= []).push({ id, name: c.name, state: c.state });
  return out;
}
const voicePeers = (channel, exceptId) => [...clients].filter(([id, c]) => c.voice === channel && id !== exceptId);

function leaveVoice(id) {
  const c = clients.get(id);
  if (!c || !c.voice) return;
  const ch = c.voice;
  c.voice = null; c.state = {};
  for (const [, p] of voicePeers(ch, id)) send(p.ws, { t: "peer-left", id });
  broadcast({ t: "voice", voice: voiceMap() });
}

wss.on("connection", ws => {
  const id = uid();
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  let me = null;

  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "hello") {
      me = { ws, name: clean(m.name, 24) || "Anônimo", voice: null, state: {} };
      clients.set(id, me);
      return send(ws, { t: "init", id, servers: db.servers, voice: voiceMap(), ice: iceServers });
    }
    if (!me) return;

    switch (m.t) {
      case "createServer": {
        const name = clean(m.name, 30); if (!name) return;
        db.servers.push({ id: uid(), name, channels: [{ id: uid(), name: "geral", type: "text" }, { id: uid(), name: "Sala 1", type: "voice" }] });
        save(); broadcast({ t: "servers", servers: db.servers }); break;
      }
      case "createChannel": {
        const s = db.servers.find(x => x.id === m.server); const name = slug(m.name);
        if (!s || !name || s.channels.length >= 50) return;
        s.channels.push({ id: uid(), name, type: m.type === "voice" ? "voice" : "text" });
        save(); broadcast({ t: "servers", servers: db.servers }); break;
      }
      case "history": {
        const ch = findChannel(m.channel); if (!ch || ch.type !== "text") return;
        send(ws, { t: "history", channel: ch.id, msgs: (db.messages[ch.id] || []).slice(-100) }); break;
      }
      case "msg": {
        const ch = findChannel(m.channel); const text = clean(m.text, 2000);
        if (!ch || ch.type !== "text" || !text) return;
        const msg = { id: uid(), uid: id, name: me.name, text, ts: Date.now() };
        const list = (db.messages[ch.id] ||= []); list.push(msg);
        if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
        save(); broadcast({ t: "msg", channel: ch.id, msg }); break;
      }
      case "joinVoice": {
        const ch = findChannel(m.channel); if (!ch || ch.type !== "voice") return;
        leaveVoice(id);
        const peers = voicePeers(ch.id, id).map(([pid, p]) => ({ id: pid, name: p.name, state: p.state }));
        me.voice = ch.id; me.state = {};
        send(ws, { t: "voice-joined", channel: ch.id, peers });
        for (const [, p] of voicePeers(ch.id, id)) send(p.ws, { t: "peer-joined", peer: { id, name: me.name, state: me.state } });
        broadcast({ t: "voice", voice: voiceMap() }); break;
      }
      case "leaveVoice": leaveVoice(id); break;
      case "state": {
        if (!me.voice) return;
        const s = m.state || {};
        me.state = { muted: !!s.muted, deaf: !!s.deaf, cam: !!s.cam, screenId: s.screenId ? clean(s.screenId, 80) : null, mainId: s.mainId ? clean(s.mainId, 80) : null };
        for (const [, p] of voicePeers(me.voice, id)) send(p.ws, { t: "peer-state", id, state: me.state });
        broadcast({ t: "voice", voice: voiceMap() }); break;
      }
      case "signal": {
        const to = clients.get(m.to);
        if (to && me.voice && to.voice === me.voice) send(to.ws, { t: "signal", from: id, data: m.data });
        break;
      }
    }
  });

  ws.on("close", () => { leaveVoice(id); clients.delete(id); });
  ws.on("error", () => {});
});

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000);

server.listen(PORT, () => console.log(`Chatcord rodando em ${process.env.SSL_KEY ? "https" : "http"}://localhost:${PORT}`));
process.on("SIGINT", () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch {} process.exit(0); });
