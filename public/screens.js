// Full-screen renderers: home, lobby, and game-over. (Rebuilt on each state
// update; the live game board lives in play.js so its inputs aren't clobbered.)

function renderHome() {
  currentScreen = "home";
  const params = new URLSearchParams(location.search);
  const presetCode = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  app.innerHTML = `
    <div class="brand">
      <div class="logo">Letter Race</div>
      <h1>Letter Race</h1>
      <div class="tag">Stack letters. Beat the clock. Race to spell.</div>
    </div>
    <div class="card">
      <label for="name">Your name</label>
      <input type="text" id="name" maxlength="20" placeholder="e.g. Ean" value="${escapeAttr(myName)}" autocomplete="off" />
      ${presetCode
        ? `<div style="margin-top:16px">
             <label>You're invited to room</label>
             <div class="row"><input type="text" id="join" class="code-input" maxlength="8" value="${presetCode}" autocomplete="off" /></div>
             <button class="btn" id="joinBtn" style="margin-top:12px">Join room</button>
           </div>
           <div class="divider">or</div>
           <button class="btn ghost" id="createBtn">Create a new room</button>`
        : `<button class="btn" id="createBtn" style="margin-top:16px">Create a room</button>
           <div class="divider">or join with a code</div>
           <div class="row">
             <input type="text" id="join" class="code-input" maxlength="8" placeholder="CODE" autocomplete="off" />
             <button class="btn small" id="joinBtn" style="flex:0 0 auto;padding:0 20px">Join</button>
           </div>`}
    </div>
    <div class="card how">
      <h3 style="font-size:15px;margin-bottom:8px">How to play</h3>
      <ol class="how" style="margin:0;padding-left:18px">
        <li>Take turns adding a letter — you have 10s, or a random one is added.</li>
        <li>Once the pool hits 3 letters, everyone gets a 5s window to think.</li>
        <li>Race to spell a real word from the pool. Longer words score more.</li>
        <li>First to 25 points takes the match.</li>
      </ol>
    </div>`;
  const nameEl = $("name");
  nameEl.oninput = () => { myName = nameEl.value; localStorage.setItem("lr_name", myName); };
  const createBtn = $("createBtn");
  if (createBtn) createBtn.onclick = () => {
    if (!ensureName()) return;
    connect(randomCode());
  };
  const joinBtn = $("joinBtn");
  if (joinBtn) joinBtn.onclick = () => {
    if (!ensureName()) return;
    const code = ($("join").value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!code) { toast("Enter a room code"); return; }
    connect(code);
  };
  if (presetCode && !myName) nameEl.focus();
}

function renderLobby() {
  const players = state.players;
  const host = isHost();
  const enoughPlayers = players.filter((p) => p.connected).length >= 2;
  app.innerHTML = `
    <div class="brand"><div class="logo">Lobby</div><h1>Letter Race</h1></div>
    <div class="card">
      <div class="gamehead">
        <div class="code-pill"><div><small>Room code</small><div class="code">${roomCode}</div></div></div>
        <button class="btn small ghost" id="shareBtn">Copy invite</button>
      </div>
      <label>Players (${players.length})</label>
      <div class="plist">
        ${players.map((p) => `
          <div class="prow">
            <span class="dot" style="${p.connected ? "" : "background:var(--muted)"}"></span>
            <span class="nm">${escapeHtml(p.name)}${p.id === youId ? " (you)" : ""}</span>
            ${p.id === state.hostId ? `<span class="badge">Host</span>` : ""}
          </div>`).join("")}
      </div>
      ${host
        ? `<button class="btn" id="startBtn" style="margin-top:16px" ${enoughPlayers ? "" : "disabled"}>
             ${enoughPlayers ? "Start game" : "Waiting for 1 more player…"}
           </button>`
        : `<div class="banner" style="margin-top:16px;margin-bottom:0">Waiting for the host to start…</div>`}
    </div>
    <div class="card" style="text-align:center">
      <p class="muted" style="font-size:14px">Share the code <b style="color:var(--text);letter-spacing:2px">${roomCode}</b> or send the invite link so friends can join from their own phones.</p>
    </div>`;
  $("shareBtn").onclick = shareInvite;
  const sb = $("startBtn");
  if (sb) sb.onclick = () => send({ type: "start" });
}

function renderOver() {
  removeOverlay();
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const champ = state.players.find((p) => p.id === state.winnerId) || sorted[0];
  const host = isHost();
  app.innerHTML = `
    <div class="brand"><div class="logo">Match over</div><h1>${escapeHtml(champ ? champ.name : "")} wins!</h1></div>
    <div class="card resultcard">
      <div class="trophy">🏆</div>
      <div class="standings">
        ${sorted.map((p, i) => `
          <div class="srow ${i === 0 ? "first" : ""}">
            <span class="rank">${i + 1}</span>
            <span class="nm">${escapeHtml(p.name)}${p.id === youId ? " (you)" : ""}</span>
            <span class="sc">${p.score}</span>
          </div>`).join("")}
      </div>
      ${host
        ? `<button class="btn" id="again">Play again</button>`
        : `<div class="banner" style="margin:0">Waiting for the host to start a rematch…</div>`}
    </div>`;
  const a = $("again");
  if (a) a.onclick = () => send({ type: "playAgain" });
}
