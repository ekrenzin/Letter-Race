# Letter Race

A real-time multiplayer word game. Players join a room, take turns adding letters
to a shared pool, then race to spell a real word from those letters. First valid
word wins the round — **longer words score more** (points = word length). First to
25 points wins the match.

Built on **Cloudflare Workers + Durable Objects** (one `GameRoom` Durable Object per
room code) with WebSockets for live play. The frontend is a single static `index.html`
served by the Worker — no build step.

## Run it locally

```bash
npm install
npm run dev
```

Open the URL Wrangler prints (usually http://localhost:8787). To play multiplayer
locally, open it in two browser tabs/windows (or two devices on your network) — one
creates a room, the other joins with the room code or the copied invite link.

## How a round works

1. Players take turns adding **one letter** to the shared pool (tap a letter, or use
   your keyboard on your turn).
2. At any moment, **anyone** can race to spell a word using the pool's letters.
3. First valid dictionary word ends the round and scores `length` points.
4. Rounds continue until someone reaches the target score.

The host can `skip this round` if the pool fills up and nobody can find a word.

## Word validation

Words are checked server-side (in the Durable Object) against a bundled dictionary
generated from the macOS system word list (`/usr/share/dict/words`), filtered to
lowercase a–z words of length 3–10 (~133k words). To regenerate `src/words.ts`:

```bash
node -e 'const fs=require("fs");const s=new Set(fs.readFileSync("/usr/share/dict/words","utf8").split("\n").filter(w=>/^[a-z]{3,10}$/.test(w)));const a=[...s].sort();fs.writeFileSync("src/words.ts",`export const WORDS_RAW = ${JSON.stringify(a.join(" "))};\n`)'
```

## Deploy to Cloudflare

```bash
npm run deploy
```

Requires a Cloudflare account (`npx wrangler login` first). Durable Objects with
SQLite storage are available on the Workers Free plan.

## Layout

- `src/index.ts` — Worker entry; routes `/api/room/:code/ws` to the room DO, serves static assets.
- `src/room.ts` — `GameRoom` Durable Object: game state, WebSocket fan-out, round/turn logic.
- `src/game.ts` — pure game rules (validation, scoring, turn order).
- `src/words.ts` — generated dictionary.
- `public/index.html` — the whole client (UI, WebSocket, rendering).
