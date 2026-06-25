// ---------- identity ----------
function uid() {
  return "p_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
let myPlayerId = localStorage.getItem("lr_pid");
if (!myPlayerId) { myPlayerId = uid(); localStorage.setItem("lr_pid", myPlayerId); }
let myName = localStorage.getItem("lr_name") || "";

// ---------- state ----------
let ws = null;
let youId = null;
let roomCode = null;
let state = null;
let currentScreen = null; // 'home' | 'lobby' | 'game' | 'over'
let intentionalClose = false;
let reconnectDelay = 500;
let prevPoolLen = 0;
let prevPhase = null;
let prevRound = -1;
let clockOffset = 0; // serverEpoch - clientEpoch, for accurate countdowns

const app = document.getElementById("app");
const $ = (id) => document.getElementById(id);

function me() { return state && state.players.find((p) => p.id === youId); }
function isHost() { return state && state.hostId === youId; }
function isMyTurn() { return state && state.currentTurnId === youId; }
function serverNow() { return Date.now() + clockOffset; }
function timerRemaining() {
  if (!state || !state.timer) return 0;
  return Math.max(0, state.timer.deadline - serverNow());
}

// ---------- networking ----------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect(code) {
  roomCode = code;
  intentionalClose = false;
  history.replaceState(null, "", "?room=" + code);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(proto + "//" + location.host + "/api/room/" + code + "/ws");
  ws.onopen = () => {
    reconnectDelay = 500;
    showConn(false);
    send({ type: "join", playerId: myPlayerId, name: myName });
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    if (intentionalClose) return;
    showConn(true);
    setTimeout(() => connect(code), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 6000);
  };
  ws.onerror = () => {};
}

function handleMessage(msg) {
  if (msg.type === "welcome") youId = msg.youId;
  else if (msg.type === "state") onState(msg.state, msg.serverNow);
  else if (msg.type === "error") toast(msg.message);
  else if (msg.type === "reject") showReject(msg.message);
}

// ---------- screen routing ----------
function onState(s, srvNow) {
  if (typeof srvNow === "number") clockOffset = srvNow - Date.now();
  state = s;
  const target = s.phase === "lobby" ? "lobby" : s.phase === "gameOver" ? "over" : "game";
  if (target !== currentScreen) {
    currentScreen = target;
    if (target === "game") buildGame();
  }
  if (target === "lobby") renderLobby();
  else if (target === "over") renderOver();
  else syncGame();
  prevPhase = s.phase;
  prevRound = s.roundNumber;
}

// ---------- shared helpers ----------
function ensureName() {
  if (!myName.trim()) { toast("Enter your name first"); $("name") && $("name").focus(); return false; }
  myName = myName.trim();
  localStorage.setItem("lr_name", myName);
  return true;
}
function randomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no easily-confused chars
  let c = "";
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function canForm(pool, word) {
  const c = {};
  for (const ch of pool) c[ch] = (c[ch] || 0) + 1;
  for (const ch of word) { if (!c[ch]) return false; c[ch]--; }
  return true;
}
function shareInvite() {
  const url = location.origin + "/?room=" + roomCode;
  const done = () => toast("Invite link copied");
  if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
    navigator.share({ title: "Letter Race", text: "Join my Letter Race game!", url }).catch(() => copy(url, done));
  } else {
    copy(url, done);
  }
}
function copy(text, cb) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(cb, () => fallbackCopy(text, cb));
  else fallbackCopy(text, cb);
}
function fallbackCopy(text, cb) {
  const t = document.createElement("textarea");
  t.value = text; document.body.appendChild(t); t.select();
  try { document.execCommand("copy"); cb && cb(); } catch {}
  document.body.removeChild(t);
}

let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function showConn(show) { $("conn").classList.toggle("show", show); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// physical keyboard: letter keys add to the pool during your pick window
window.addEventListener("keydown", (e) => {
  if (currentScreen !== "game" || !state || state.phase !== "playing") return;
  if (document.activeElement && document.activeElement.tagName === "INPUT") return;
  const canPick = state.timer && state.timer.kind === "pick" && isMyTurn() && state.pool.length < state.maxPool;
  if (!canPick) return;
  const k = (e.key || "").toLowerCase();
  if (k.length === 1 && /^[a-z]$/.test(k) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    send({ type: "addLetter", letter: k });
  }
});
