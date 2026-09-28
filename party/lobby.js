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
 *   • answers "which room holds MY seat?" (cross-device rejoin)    (GET ?need=mine)
 *   • lists every live room for the "Active rooms" browser         (GET ?need=rooms)
 *   • lists everything (debug; account ids stripped)               (GET ?need=list)
 *
 * Each Main room reports its state here on every meaningful change (created,
 * started, a seat opened/closed, torn down) and on a heartbeat while played,
 * via the `report()` RPC on getServerByName(env.Lobby, ...). Reports are RPC,
 * not HTTP, so nobody who can reach /parties/lobby/lobby can forge or delete
 * registry entries. The object has no sockets, so it evicts between requests —
 * the registry is persisted to Durable Object storage and reloaded on demand.
 * ===========================================================================*/

import { Server } from "partyserver";
import { getUser } from "./api.js";

// Unambiguous alphabet (no 0/O/1/I) — mirrors the old makeCode().
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// A confirmed room with no activity for this long is considered dead and swept
// (a safety net against rooms that vanished without reporting a removal).
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
// A code reserved by ?need=create but never actually created (the client closed
// the tab before connecting) expires quickly so it can't block its slot.
const RESERVED_TTL_MS = 90 * 1000;
// A started room re-reports at least every few minutes while anyone plays
// (LOBBY_REFRESH_MS in main.js). One silent for this long — everyone AFK, or
// the object evicted with nobody coming back — is shown as idle, not playing.
const STALE_MS = 15 * 60 * 1000;
// Seat kinds a room reports for the room browser.
const SEAT_KINDS = new Set(["human", "away", "bot", "open"]);
// Room browser order: games in progress first, finished tables last.
const STATUS_ORDER = { playing: 0, waiting: 1, idle: 2, finished: 3 };

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

  // Durable Object RPC (room objects call `stub.getBackupKey()`; NOT reachable
  // over HTTP — onRequest never exposes it). One random 256-bit AES key, minted
  // on first use and kept here forever, seals every room's host backup so the
  // blob a host's browser holds can't be read or forged, only handed back.
  async getBackupKey() {
    let key = await this.ctx.storage.get("backupKey");
    if (!key) {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      key = btoa(String.fromCharCode(...raw));
      await this.ctx.storage.put("backupKey", key);
    }
    return key;
  }

  // Durable Object RPC (room objects call `stub.report({...})`; NOT reachable
  // over HTTP): a room's current state, or `removed` when it is torn down.
  async report(body) {
    await this.load();
    this.sweep();
    const code = String((body && body.code) || "").toUpperCase();
    if (!code) return false;
    if (body.removed) {
      this.rooms.delete(code);
    } else {
      this.rooms.set(code, {
        gameType: typeof body.gameType === "string" ? body.gameType : "blackqueen",
        started: !!body.started,
        joinable: !!body.joinable,
        live: !!body.live,
        users: Array.isArray(body.users) ? body.users : [],
        // Public summary for the room browser (see publicRoom).
        seatCap: Number(body.seatCap) || 0,
        players: Array.isArray(body.players)
          ? body.players.map((p) => ({
              name: String((p && p.name) || "").slice(0, 14),
              kind: SEAT_KINDS.has(p && p.kind) ? p.kind : "bot",
            }))
          : [],
        spectators: Number(body.spectators) || 0,
        round: Number(body.round) || null,
        over: !!body.over,
        reserved: false,
        ts: Date.now(),
      });
    }
    await this.persist();
    return true;
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

    // Cross-device rejoin: which room is the logged-in user seated in? The
    // session cookie rides along on the same-origin fetch; resolve it against
    // D1 and scan the registry for a room holding that user's seat.
    if (need === "mine") {
      if (!this.env.DB) return json({ error: "none" }, 404);
      const user = await getUser(req, this.env).catch(() => null);
      if (!user) return json({ error: "unauthorized" }, 401);
      // Every room holding a seat for this account (started games first, newest
      // first) — the menu lists them all under "Unfinished games"; `code` keeps
      // the original single-answer shape for older clients.
      const rooms = [...this.rooms]
        .filter(([, v]) => !v.reserved && Array.isArray(v.users) && v.users.includes(user.id))
        .sort(([, a], [, b]) => (Number(!!b.started) - Number(!!a.started)) || ((b.ts || 0) - (a.ts || 0)))
        .map(([code, v]) => ({ code, gameType: v.gameType || "blackqueen", started: !!v.started, live: !!v.live, ts: v.ts || 0 }));
      return rooms.length
        ? json({ code: rooms[0].code, started: rooms[0].started, live: rooms[0].live, rooms })
        : json({ error: "none" }, 404);
    }

    // Room browser: every live room (multiplayer screen, "Active rooms"). Only
    // for signed-in players when accounts are enabled; `mine` marks the rooms
    // that hold the caller's seat so the list can offer Rejoin, not Join.
    if (need === "rooms") {
      let user = null;
      if (this.env.DB) {
        user = await getUser(req, this.env).catch(() => null);
        if (!user) return json({ error: "unauthorized" }, 401);
      }
      const now = Date.now();
      const rooms = [...this.rooms]
        .filter(([, v]) => !v.reserved)
        .map(([code, v]) => publicRoom(code, v, now, user))
        .sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.ts - a.ts));
      return json({ rooms });
    }

    if (need === "list") {
      // Debug view (also the multiplayer screen's reachability probe) — account
      // ids stay private.
      return json({ rooms: [...this.rooms].map(([code, v]) => {
        const { users, ...rest } = v;
        return { code, ...rest };
      }) });
    }

    return json({ error: "bad-request" }, 400);
  }
}

// What the room browser sees of a registry entry: no account ids, plus a
// derived status. Entries reported before rooms sent a `players` summary still
// list, with whatever is known.
function publicRoom(code, v, now, user) {
  const players = Array.isArray(v.players) ? v.players : [];
  const humans = players.filter((p) => p.kind === "human").length;
  let status = "playing";
  if (!v.started) status = "waiting";
  else if (v.over) status = "finished";
  else if ((Array.isArray(v.players) && !humans) || now - (v.ts || 0) > STALE_MS) status = "idle";
  return {
    code,
    gameType: v.gameType || "blackqueen",
    status,
    started: !!v.started,
    joinable: !!v.joinable,
    live: !!v.live,
    mine: !!(user && Array.isArray(v.users) && v.users.includes(user.id)),
    players,
    seatCap: v.seatCap || 0,
    spectators: v.spectators || 0,
    round: v.round || null,
    ts: v.ts || 0,
  };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}
