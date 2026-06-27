/* =============================================================================
 * Black Queen — LOBBY (a single shared registry Durable Object)
 * -----------------------------------------------------------------------------
 * In the old single-process server, ONE Map held every room, so "join with a
 * blank code" or "watch the only live game" could just scan it. On Workers each
 * room is an isolated Durable Object that can't see the others — so this one
 * fixed object (name "lobby") keeps the cross-room view, reached over HTTP:
 *
 *   • allocates a unique, unused 4-letter code for a new room      (GET ?need=create)
 *   • answers "give me an open room to join"                       (GET ?need=join)
 *   • answers "give me a live game to watch"                       (GET ?need=spectate)
 *   • lists everything (debug / future room browser)               (GET ?need=list)
 *
 * Each Main room reports its state here on every meaningful change (created,
 * started, a seat opened/closed, torn down) via getServerByName(env.Lobby,...).
 * It is HTTP-only (no sockets), so it evicts between requests — the registry is
 * persisted to Durable Object storage and reloaded on demand.
 * ===========================================================================*/

import { Server } from "partyserver";

// Unambiguous alphabet (no 0/O/1/I) — mirrors the old makeCode().
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// A confirmed room with no activity for this long is considered dead and swept
// (a safety net against rooms that vanished without reporting a removal).
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
// A code reserved by ?need=create but never actually created (the client closed
// the tab before connecting) expires quickly so it can't block its slot.
const RESERVED_TTL_MS = 90 * 1000;

export class Lobby extends Server {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = new Map();   // code -> { started, joinable, live, reserved, ts }
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    const saved = await this.ctx.storage.get("rooms");
    if (Array.isArray(saved)) this.rooms = new Map(saved);
    this.loaded = true;
  }

  async persist() {
    await this.ctx.storage.put("rooms", [...this.rooms]);
  }

  // Drop stale entries: long-dead rooms and abandoned reservations.
  sweep() {
    const now = Date.now();
    for (const [code, v] of this.rooms) {
      const ttl = v.reserved ? RESERVED_TTL_MS : ENTRY_TTL_MS;
      if (now - (v.ts || 0) > ttl) this.rooms.delete(code);
    }
  }

  freshCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () =>
        CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  async onRequest(req) {
    await this.load();
    this.sweep();

    // Rooms report their state with a POST.
    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch (_) { return json({ ok: false }, 400); }
      const code = String(body.code || "").toUpperCase();
      if (!code) return json({ ok: false }, 400);
      if (body.removed) {
        this.rooms.delete(code);
      } else {
        this.rooms.set(code, {
          started: !!body.started,
          joinable: !!body.joinable,
          live: !!body.live,
          reserved: false,
          ts: Date.now(),
        });
      }
      await this.persist();
      return json({ ok: true });
    }

    // Clients ask questions with a GET.
    const need = new URL(req.url).searchParams.get("need");

    if (need === "create") {
      const code = this.freshCode();
      // Reserved (not yet joinable) until the room itself reports its real state.
      this.rooms.set(code, { started: false, joinable: false, live: false, reserved: true, ts: Date.now() });
      await this.persist();
      return json({ code });
    }

    if (need === "join") {
      const hit = [...this.rooms].find(([, v]) => v.joinable);
      return hit ? json({ code: hit[0] }) : json({ error: "none" }, 404);
    }

    if (need === "spectate") {
      const hit = [...this.rooms].find(([, v]) => v.live);
      return hit ? json({ code: hit[0] }) : json({ error: "none" }, 404);
    }

    if (need === "list") {
      return json({ rooms: [...this.rooms].map(([code, v]) => ({ code, ...v })) });
    }

    return json({ error: "bad-request" }, 400);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
