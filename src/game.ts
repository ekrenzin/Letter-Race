// Pure game logic + types for Letter Race. No I/O here so it stays easy to test.
import { WORDS_RAW } from "./words";

export const MIN_WORD = 3; // also the minimum pool size before words can be spelled
export const MAX_POOL = 12;
export const DEFAULT_TARGET = 25;
export const MAX_PLAYERS = 8;
export const PICK_SECONDS = 10; // time a player has to pick a letter on their turn
export const THINK_SECONDS = 5; // shared "everyone think" window once the pool hits the minimum

// Weighted letter bag (vowel-rich) used when a pick times out, so auto-added
// letters keep the pool spellable.
const LETTER_BAG =
  "aaaaaaaaeeeeeeeeeeeeiiiiiiiooooooouuuu" +
  "nnnnnnrrrrrrttttttllllssssdddd" +
  "gggbbccmmppffhhvvwwyykjxqz";
export function randomLetter(): string {
  return LETTER_BAG[Math.floor(Math.random() * LETTER_BAG.length)];
}

export type TimerKind = "pick" | "think" | "roundEnd";
export interface GameTimer {
  kind: TimerKind;
  deadline: number; // server epoch ms when this timer fires
  durationMs: number; // full length, so clients can draw a progress bar
}

// The dictionary is a big space-joined string; parse it into a Set on first use.
let DICT: Set<string> | null = null;
export function isWord(w: string): boolean {
  if (!DICT) DICT = new Set(WORDS_RAW.split(" "));
  return DICT.has(w);
}

export type Phase = "lobby" | "playing" | "roundEnd" | "gameOver";

export interface Player {
  id: string;
  name: string;
  score: number;
  connected: boolean;
}

export interface RoundResult {
  winnerId: string;
  winnerName: string;
  word: string;
  points: number;
}

export interface GameState {
  phase: Phase;
  players: Player[]; // array order == turn order
  hostId: string | null;
  pool: string[]; // letters added this round, in order
  currentTurnId: string | null; // whose turn it is to add a letter
  roundNumber: number;
  lastResult: RoundResult | null;
  targetScore: number;
  maxPool: number;
  minWord: number;
  winnerId: string | null; // set when the match is won
  timer: GameTimer | null; // active countdown (pick / think / roundEnd), or null
}

export function createState(): GameState {
  return {
    phase: "lobby",
    players: [],
    hostId: null,
    pool: [],
    currentTurnId: null,
    roundNumber: 0,
    lastResult: null,
    targetScore: DEFAULT_TARGET,
    maxPool: MAX_POOL,
    minWord: MIN_WORD,
    winnerId: null,
    timer: null,
  };
}

export function connectedPlayers(state: GameState): Player[] {
  return state.players.filter((p) => p.connected);
}

// Can `word` be spelled using only the letters available in `pool` (respecting counts)?
export function canFormFromPool(pool: string[], word: string): boolean {
  const counts: Record<string, number> = {};
  for (const c of pool) counts[c] = (counts[c] || 0) + 1;
  for (const c of word) {
    if (!counts[c]) return false;
    counts[c]--;
  }
  return true;
}

export interface SubmitCheck {
  ok: boolean;
  reason?: string;
  points?: number;
}

// Validate a submitted word against the current pool + dictionary. Points == length.
export function checkWord(state: GameState, rawWord: string): SubmitCheck {
  const word = (rawWord || "").trim().toLowerCase();
  if (!/^[a-z]+$/.test(word)) return { ok: false, reason: "Letters only." };
  if (word.length < state.minWord)
    return { ok: false, reason: `Words must be at least ${state.minWord} letters.` };
  if (!canFormFromPool(state.pool, word))
    return { ok: false, reason: "Not enough letters in the pool for that." };
  if (!isWord(word)) return { ok: false, reason: `"${word.toUpperCase()}" isn't in the dictionary.` };
  return { ok: true, points: word.length };
}

// Next connected player after `currentId` in turn order (wraps around).
export function nextTurnAfter(state: GameState, currentId: string | null): string | null {
  const order = state.players;
  if (order.length === 0) return null;
  const startIdx = currentId ? order.findIndex((p) => p.id === currentId) : -1;
  for (let i = 1; i <= order.length; i++) {
    const cand = order[(startIdx + i + order.length) % order.length];
    if (cand.connected) return cand.id;
  }
  return null;
}

// Who adds the first letter this round. Rotates by round so it is fair.
export function firstTurnForRound(state: GameState, roundNumber: number): string | null {
  const order = state.players;
  if (order.length === 0) return null;
  const startPos = (roundNumber - 1) % order.length;
  for (let i = 0; i < order.length; i++) {
    const cand = order[(startPos + i) % order.length];
    if (cand.connected) return cand.id;
  }
  return null;
}
