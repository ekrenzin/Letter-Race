// Worker entry: route /api/room/:code/ws to the right GameRoom Durable Object,
// everything else falls through to the static frontend in /public.
import { GameRoom } from "./room";

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
}

function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const ws = url.pathname.match(/^\/api\/room\/([^/]+)\/ws$/);
    if (ws) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const code = normalizeCode(decodeURIComponent(ws[1]));
      if (!code) return new Response("bad room code", { status: 400 });
      // getByName: same code -> same DO instance, anywhere in the world.
      return env.GAME_ROOM.getByName(code).fetch(request);
    }

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true });
    }

    // Static assets (index.html, etc.) are served by the assets binding.
    return env.ASSETS.fetch(request);
  },
};
