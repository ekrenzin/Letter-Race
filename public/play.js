// The live game board: built once when the round starts, then synced on each
// state update so the word input isn't clobbered. A 100ms ticker animates the
// pick / think countdown locally between server broadcasts.

let prevTimerKind = null;
const finePointer = window.matchMedia && window.matchMedia("(pointer: fine)").matches;

function buildGame() {
  app.innerHTML = `
    <div class="gamehead">
      <div class="code-pill" id="sharePill" title="Copy invite">
        <div><small>Room</small><div class="code">${roomCode}</div></div>
      </div>
      <div class="progress"><div>Round <b id="roundNum">1</b></div><div class="muted" style="font-size:11px">first to ${state.targetScore} pts</div></div>
    </div>
    <div class="scoreboard" id="scoreboard"></div>
    <div class="banner" id="banner"><span id="bannerText"></span><span id="bannerSecs"></span></div>
    <div class="timerbar hide" id="timerbar"><div id="timerfill"></div></div>
    <div class="poolwrap" id="pool"></div>
    <div class="poolmeta" id="poolmeta"></div>
    <div class="picker" id="picker"></div>
    <form class="wordform" id="wordform" autocomplete="off">
      <input type="text" id="word" placeholder="spell a word…" maxlength="15" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <button class="btn" type="submit">Go</button>
    </form>
    <div class="wordhint" id="wordhint"></div>
    <div class="hostbar" id="hostbar"></div>`;

  $("sharePill").onclick = shareInvite;

  const picker = $("picker");
  "abcdefghijklmnopqrstuvwxyz".split("").forEach((ch) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lk";
    b.textContent = ch;
    b.onclick = () => send({ type: "addLetter", letter: ch });
    picker.appendChild(b);
  });

  const form = $("wordform");
  const word = $("word");
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = (word.value || "").trim().toLowerCase();
    if (!v) return;
    send({ type: "submitWord", word: v });
  };
  word.oninput = updateWordHint;
  prevPoolLen = 0;
  prevTimerKind = null;
}

function syncGame() {
  if (!$("scoreboard")) buildGame();

  // new round? clear the word box + hints
  if (state.roundNumber !== prevRound || (state.phase === "roundEnd" && prevPhase !== "roundEnd")) {
    const w = $("word");
    if (w) w.value = "";
    setHint("", "");
  }
  if (state.phase === "playing" && state.pool.length === 0) prevPoolLen = 0;

  $("roundNum").textContent = state.roundNumber || 1;

  // scoreboard (sorted by score desc)
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  $("scoreboard").innerHTML = sorted.map((p) => {
    const turn = p.id === state.currentTurnId && state.phase === "playing" && state.timer && state.timer.kind === "pick";
    return `<div class="pchip ${turn ? "turn" : ""} ${p.connected ? "" : "off"}">
      <span class="dot"></span>
      <span class="nm">${escapeHtml(p.name)}</span>
      ${p.id === youId ? `<span class="badge">you</span>` : ""}
      <span class="sc">${p.score}</span>
    </div>`;
  }).join("");

  // pool tiles (animate only the newly added one)
  const pool = $("pool");
  if (state.pool.length === 0) {
    pool.innerHTML = `<span class="pool-empty">No letters yet — first player picks one.</span>`;
  } else {
    pool.innerHTML = state.pool.map((ch, i) => {
      const isNew = i === state.pool.length - 1 && state.pool.length > prevPoolLen;
      return `<div class="tile ${isNew ? "pop" : ""}">${ch}</div>`;
    }).join("");
  }
  prevPoolLen = state.pool.length;
  const need = state.minWord - state.pool.length;
  $("poolmeta").textContent =
    need > 0
      ? `${state.pool.length} / ${state.maxPool} letters · ${need} more to unlock spelling`
      : `${state.pool.length} / ${state.maxPool} letters`;

  // letter picker: only during your pick window
  const canAdd =
    state.phase === "playing" && state.timer && state.timer.kind === "pick" && isMyTurn() && state.pool.length < state.maxPool;
  $("picker").className = "picker" + (canAdd ? "" : " disabled");

  // word form: enabled once the pool reaches the minimum
  const word = $("word");
  const wf = $("wordform");
  const canSpell = state.phase === "playing" && state.pool.length >= state.minWord;
  word.disabled = !canSpell;
  wf.querySelector("button").disabled = !canSpell;

  // focus the word box when the think window opens (desktop only)
  const kind = state.timer && state.timer.kind;
  if (kind === "think" && prevTimerKind !== "think" && finePointer && canSpell) {
    word.focus();
  }
  prevTimerKind = kind || null;
  updateWordHint();

  // host controls
  const hostbar = $("hostbar");
  if (isHost() && state.phase === "playing") {
    hostbar.innerHTML = `<a id="skip">skip this round</a>`;
    $("skip").onclick = () => send({ type: "skipRound" });
  } else {
    hostbar.innerHTML = "";
  }

  if (state.phase === "roundEnd" && state.lastResult) showRoundOverlay(state.lastResult);
  else removeOverlay();

  renderStatus();
}

// Banner text + countdown + timer bar. Called on state change and every 100ms.
function renderStatus() {
  const banner = $("banner");
  const text = $("bannerText");
  const secsEl = $("bannerSecs");
  const bar = $("timerbar");
  const fill = $("timerfill");
  if (!banner || !text) return;

  const t = state.timer;
  const poolFull = state.pool.length >= state.maxPool;
  const remain = timerRemaining();
  const secs = Math.ceil(remain / 1000);

  let mode = "";
  let label = "";
  if (state.phase !== "playing") {
    label = "Round over";
  } else if (t && t.kind === "think") {
    mode = "think";
    label = "Everyone think — spell a word!";
  } else if (poolFull) {
    mode = "full";
    label = "Pool's full — spell a word!";
  } else if (t && t.kind === "pick" && isMyTurn()) {
    mode = "you";
    label = "Your turn — pick a letter";
  } else if (t && t.kind === "pick") {
    const who = state.players.find((p) => p.id === state.currentTurnId);
    label = (who ? who.name : "Someone") + " is picking…";
  }
  banner.className = "banner" + (mode ? " " + mode : "");
  text.textContent = label;

  const showClock = state.phase === "playing" && t && (t.kind === "pick" || t.kind === "think") && !poolFull;
  secsEl.textContent = showClock ? " · " + secs + "s" : "";
  if (showClock) {
    bar.className = "timerbar" + (t.kind === "think" ? " think" : "");
    fill.style.width = Math.max(0, Math.min(100, (remain / t.durationMs) * 100)) + "%";
  } else {
    bar.className = "timerbar hide";
  }
}

function updateWordHint() {
  const word = $("word");
  if (!word) return;
  if (state.pool.length < state.minWord) {
    setHint(`Spelling unlocks at ${state.minWord} letters`, "");
    return;
  }
  if (word.disabled) { setHint("", ""); return; }
  const v = (word.value || "").trim().toLowerCase();
  if (!v) { setHint("Spell a word from the pool to score", ""); return; }
  if (!/^[a-z]+$/.test(v)) { setHint("Letters only", "bad"); return; }
  if (v.length < state.minWord) { setHint(`At least ${state.minWord} letters`, "bad"); return; }
  if (!canForm(state.pool, v)) { setHint("Not enough letters in the pool", "bad"); return; }
  setHint(`${v.toUpperCase()} — worth ${v.length} pts if it's a word`, "live");
}
function setHint(text, kind) {
  const h = $("wordhint");
  if (!h) return;
  h.textContent = text;
  h.className = "wordhint" + (kind ? " " + kind : "");
}

function showReject(message) {
  setHint(message || "Nope", "bad");
  const w = $("word");
  if (w) { w.classList.remove("shake"); void w.offsetWidth; w.classList.add("shake"); w.select(); }
}

function showRoundOverlay(r) {
  const ov = $("overlay");
  const youWon = r.winnerId === youId;
  const html = `
    <div class="overlay" id="overlay">
      <div class="card resultcard">
        <div class="who">${youWon ? "You got it!" : escapeHtml(r.winnerName) + " got it"}</div>
        <div class="word">${escapeHtml(r.word)}</div>
        <div class="pts">+${r.points} points</div>
        <p class="muted" style="margin-top:14px;font-size:13px">Next round starting…</p>
      </div>
    </div>`;
  if (ov) ov.outerHTML = html; else app.insertAdjacentHTML("beforeend", html);
}
function removeOverlay() { const ov = $("overlay"); if (ov) ov.remove(); }

// boot + countdown ticker
renderHome();
setInterval(() => {
  if (currentScreen === "game" && state && state.phase === "playing") renderStatus();
}, 100);
