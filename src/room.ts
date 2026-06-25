// GameRoom: one Durable Object instance per room code. Holds the live game,
// fans state out to every connected player over WebSockets (hibernation API).
// A single DO alarm drives all timed transitions (pick / think / roundEnd).
import { DurableObject } from "cloudflare:workers";
import {
  GameState,
  TimerKind,
  createState,
  checkWord,
  nextTurnAfter,
  firstTurnForRound,
  connectedPlayers,
  randomLetter,
  MAX_PLAYERS,
  MIN_WORD,
  PICK_SECONDS,
  THINK_SECONDS,
} from "./game";

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

interface SocketMeta {
  playerId: string;
}

const ROUND_END_SECONDS = 4;

export class GameRoom extends DurableObject<Env> {
  private state: GameState;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = createState();
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<GameState>("state");
      if (saved) this.state = saved;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- timer helpers (single alarm, multiplexed by kind) ----
  private setTimer(kind: TimerKind, seconds: number) {
    const durationMs = seconds * 1000;
    const deadline = Date.now() + durationMs;
    this.state.timer = { kind, deadline, durationMs };
    this.ctx.storage.setAlarm(deadline);
  }
  private clearTimer() {
    this.state.timer = null;
    this.ctx.storage.deleteAlarm();
  }

  private async persist() {
    await this.ctx.storage.put("state", this.state);
  }
  private broadcast() {
    // serverNow lets clients render an accurate countdown despite clock skew.
    const msg = JSON.stringify({ type: "state", state: this.state, serverNow: Date.now() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        /* socket mid-close */
      }
    }
  }
  private send(ws: WebSocket, obj: unknown) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }
  private meta(ws: WebSocket): SocketMeta | null {
    return (ws.deserializeAttachment() as SocketMeta) || null;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: any;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "join":
        return this.onJoin(ws, msg);
      case "start":
        return this.onStart(ws);
      case "addLetter":
        return this.onAddLetter(ws, msg);
      case "submitWord":
        return this.onSubmit(ws, msg);
      case "nextRound":
        return this.onNextRound(ws);
      case "skipRound":
        return this.onSkipRound(ws);
      case "playAgain":
        return this.onPlayAgain(ws);
    }
  }

  private async onJoin(ws: WebSocket, msg: any) {
    const playerId = String(msg.playerId || "").slice(0, 64);
    let name = String(msg.name || "").trim().slice(0, 20);
    if (!playerId) {
      this.send(ws, { type: "error", message: "Missing player id." });
      return;
    }
    if (!name) name = "Player";
    ws.serializeAttachment({ playerId } as SocketMeta);

    let player = this.state.players.find((p) => p.id === playerId);
    if (player) {
      player.connected = true;
      player.name = name;
    } else {
      if (this.state.players.length >= MAX_PLAYERS) {
        this.send(ws, { type: "error", message: "This room is full." });
        return;
      }
      player = { id: playerId, name, score: 0, connected: true };
      this.state.players.push(player);
    }

    const hostOk =
      this.state.hostId && this.state.players.some((p) => p.id === this.state.hostId && p.connected);
    if (!hostOk) {
      const firstConnected = this.state.players.find((p) => p.connected);
      this.state.hostId = firstConnected ? firstConnected.id : null;
    }

    this.send(ws, { type: "welcome", youId: playerId });
    await this.persist();
    this.broadcast();
  }

  private async onStart(ws: WebSocket) {
    const me = this.meta(ws);
    if (!me) return;
    if (me.playerId !== this.state.hostId) {
      this.send(ws, { type: "error", message: "Only the host can start." });
      return;
    }
    if (connectedPlayers(this.state).length < 2) {
      this.send(ws, { type: "error", message: "Need at least 2 players to start." });
      return;
    }
    for (const p of this.state.players) p.score = 0;
    this.state.phase = "playing";
    this.state.roundNumber = 1;
    this.state.pool = [];
    this.state.lastResult = null;
    this.state.winnerId = null;
    this.state.currentTurnId = firstTurnForRound(this.state, 1);
    this.setTimer("pick", PICK_SECONDS);
    await this.persist();
    this.broadcast();
  }

  private async onAddLetter(ws: WebSocket, msg: any) {
    const me = this.meta(ws);
    if (!me || this.state.phase !== "playing") return;
    // Letters can only be added during a "pick" window by the active player.
    if (this.state.timer?.kind !== "pick" || this.state.currentTurnId !== me.playerId) {
      this.send(ws, { type: "error", message: "It's not your turn to pick." });
      return;
    }
    const letter = String(msg.letter || "").toLowerCase();
    if (!/^[a-z]$/.test(letter)) {
      this.send(ws, { type: "error", message: "Pick a single letter A-Z." });
      return;
    }
    if (this.state.pool.length >= this.state.maxPool) return;
    this.state.pool.push(letter);
    this.afterLetterAdded();
    await this.persist();
    this.broadcast();
  }

  // Decide what happens once a letter lands in the pool.
  private afterLetterAdded() {
    if (this.state.pool.length >= this.state.maxPool) {
      this.clearTimer(); // pool full: free-for-all race, host can skip
    } else if (this.state.pool.length >= MIN_WORD) {
      this.setTimer("think", THINK_SECONDS); // minimum reached: everyone thinks
    } else {
      this.state.currentTurnId = nextTurnAfter(this.state, this.state.currentTurnId);
      this.setTimer("pick", PICK_SECONDS); // keep building toward the minimum
    }
  }

  private async onSubmit(ws: WebSocket, msg: any) {
    const me = this.meta(ws);
    if (!me || this.state.phase !== "playing") return;
    const player = this.state.players.find((p) => p.id === me.playerId);
    if (!player) return;

    if (this.state.pool.length < MIN_WORD) {
      this.send(ws, {
        type: "reject",
        message: `Spelling unlocks at ${MIN_WORD} letters.`,
      });
      return;
    }
    const check = checkWord(this.state, String(msg.word || ""));
    if (!check.ok) {
      this.send(ws, { type: "reject", message: check.reason });
      return;
    }

    const word = String(msg.word).trim().toLowerCase();
    player.score += check.points!;
    this.state.lastResult = {
      winnerId: player.id,
      winnerName: player.name,
      word,
      points: check.points!,
    };

    if (player.score >= this.state.targetScore) {
      this.state.phase = "gameOver";
      this.state.winnerId = player.id;
      this.state.currentTurnId = null;
      this.clearTimer();
    } else {
      this.state.phase = "roundEnd";
      this.state.currentTurnId = null;
      this.setTimer("roundEnd", ROUND_END_SECONDS);
    }
    await this.persist();
    this.broadcast();
  }

  private startNextRound() {
    this.state.roundNumber += 1;
    this.state.pool = [];
    this.state.phase = "playing";
    this.state.currentTurnId = firstTurnForRound(this.state, this.state.roundNumber);
    this.setTimer("pick", PICK_SECONDS);
  }

  private async onNextRound(ws: WebSocket) {
    const me = this.meta(ws);
    if (!me || this.state.phase !== "roundEnd") return;
    this.startNextRound();
    await this.persist();
    this.broadcast();
  }

  private async onSkipRound(ws: WebSocket) {
    const me = this.meta(ws);
    if (!me || me.playerId !== this.state.hostId || this.state.phase !== "playing") return;
    this.state.lastResult = null;
    this.startNextRound();
    await this.persist();
    this.broadcast();
  }

  private async onPlayAgain(ws: WebSocket) {
    const me = this.meta(ws);
    if (!me) return;
    if (me.playerId !== this.state.hostId) {
      this.send(ws, { type: "error", message: "Only the host can restart." });
      return;
    }
    if (this.state.phase !== "gameOver") return;
    for (const p of this.state.players) p.score = 0;
    this.state.phase = "lobby";
    this.state.pool = [];
    this.state.roundNumber = 0;
    this.state.lastResult = null;
    this.state.winnerId = null;
    this.state.currentTurnId = null;
    this.clearTimer();
    await this.persist();
    this.broadcast();
  }

  // The single alarm fires for whichever timer is active.
  async alarm() {
    const kind = this.state.timer?.kind;
    if (kind === "pick") {
      // Picker ran out of time -> auto-add a random letter and move on.
      if (this.state.phase === "playing" && this.state.pool.length < this.state.maxPool) {
        this.state.pool.push(randomLetter());
        this.afterLetterAdded();
      }
    } else if (kind === "think") {
      // Think window elapsed with no winner -> next player picks.
      if (this.state.phase === "playing") {
        this.state.currentTurnId = nextTurnAfter(this.state, this.state.currentTurnId);
        this.setTimer("pick", PICK_SECONDS);
      }
    } else if (kind === "roundEnd") {
      if (this.state.phase === "roundEnd") this.startNextRound();
    }
    await this.persist();
    this.broadcast();
  }

  async webSocketClose(ws: WebSocket) {
    await this.onDisconnect(ws);
  }
  async webSocketError(ws: WebSocket) {
    await this.onDisconnect(ws);
  }

  private async onDisconnect(ws: WebSocket) {
    const me = this.meta(ws);
    if (!me) return;
    const stillOpen = this.ctx.getWebSockets().some((s) => {
      if (s === ws) return false;
      return this.meta(s)?.playerId === me.playerId;
    });
    const player = this.state.players.find((p) => p.id === me.playerId);
    if (player && !stillOpen) player.connected = false;

    if (!stillOpen && this.state.hostId === me.playerId) {
      const firstConnected = this.state.players.find((p) => p.connected);
      this.state.hostId = firstConnected ? firstConnected.id : null;
    }

    // If the disconnecting player was mid-pick, hand the turn to someone present.
    if (
      !stillOpen &&
      this.state.phase === "playing" &&
      this.state.timer?.kind === "pick" &&
      this.state.currentTurnId === me.playerId
    ) {
      this.state.currentTurnId = nextTurnAfter(this.state, me.playerId);
      this.setTimer("pick", PICK_SECONDS);
    }

    await this.persist();
    this.broadcast();
  }
}
