/* =============================================================================
 * Black Queen — HTTP API  (accounts, friends, game history) on Cloudflare D1
 * -----------------------------------------------------------------------------
 * handleApi() is called from the Worker's fetch before routePartykitRequest.
 * It owns everything under /api/ and talks to D1 (env.DB) directly. Returns a
 * Response for /api/* routes, or null to let the request fall through (to the
 * parties / static assets).
 * ===========================================================================*/

import {
  hashPassword, verifyPassword, randomToken,
  getSessionToken, sessionCookie, clearSessionCookie, SESSION_TTL_SEC,
} from "./auth.js";

const VALID_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const VALID_USERNAME = /^[a-zA-Z0-9_]{3,20}$/;

export async function handleApi(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;

  // No DB binding (e.g. assets-only preview) — fail clearly instead of 500s.
  if (!env.DB) return json({ error: "database-unavailable" }, 503);

  const secure = url.protocol === "https:";
  const route = url.pathname.slice(5);           // strip "/api/"
  const method = request.method;

  // Same-origin guard for state-changing requests (defence-in-depth on top of
  // the SameSite=Lax session cookie).
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== url.host) return json({ error: "bad-origin" }, 403);
  }

  try {
    if (route === "register" && method === "POST") return register(request, env, secure);
    if (route === "login"    && method === "POST") return login(request, env, secure);
    if (route === "logout"   && method === "POST") return logout(request, env, secure);
    if (route === "me"       && method === "GET")  return me(request, env);

    if (route === "friends" && method === "GET")    return listFriends(request, env);
    if (route === "friends/request"  && method === "POST") return friendRequest(request, env);
    if (route === "friends/respond"  && method === "POST") return friendRespond(request, env);
    if (route === "friends" && method === "DELETE")  return friendRemove(request, env);

    if (route === "history" && method === "GET")     return listHistory(request, env);
    if (route.startsWith("history/") && method === "GET")
      return gameDetail(request, env, decodeURIComponent(route.slice("history/".length)));

    return json({ error: "not-found" }, 404);
  } catch (e) {
    return json({ error: "server-error", detail: String(e && e.message || e) }, 500);
  }
}

/* ---- helpers ------------------------------------------------------------ */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
  });
}

const pub = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, email: u.email });

// Resolve the logged-in user from the session cookie (or null).
export async function getUser(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, Date.now()).first();
  return row || null;
}

async function startSession(env, userId) {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(token, userId, now, now + SESSION_TTL_SEC * 1000).run();
  return token;
}

/* ---- auth ---------------------------------------------------------------- */
async function register(request, env, secure) {
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || "").trim();
  const username = String(b.username || "").trim();
  const displayName = String(b.displayName || username).trim().slice(0, 24);
  const password = String(b.password || "");

  if (!VALID_EMAIL.test(email)) return json({ error: "Enter a valid email." }, 400);
  if (!VALID_USERNAME.test(username)) return json({ error: "Username must be 3–20 letters, numbers, or _." }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

  const { hash, salt, iterations } = await hashPassword(password);
  const now = Date.now();
  let res;
  try {
    res = await env.DB.prepare(
      `INSERT INTO users (email, username, display_name, password_hash, password_salt, iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(email, username, displayName || username, hash, salt, iterations, now).run();
  } catch (e) {
    // unique index violation on email/username
    return json({ error: "That email or username is already taken." }, 409);
  }
  const userId = res.meta.last_row_id;
  const token = await startSession(env, userId);
  return json(
    { user: { id: userId, username, displayName: displayName || username, email } },
    200, { "Set-Cookie": sessionCookie(token, secure) }
  );
}

async function login(request, env, secure) {
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || "").trim();
  const password = String(b.password || "");

  const user = await env.DB.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`).bind(email).first();
  // Generic message either way — don't reveal whether the email exists.
  const ok = user && await verifyPassword(password, user.password_salt, user.password_hash, user.iterations);
  if (!ok) return json({ error: "Invalid email or password." }, 401);

  const token = await startSession(env, user.id);
  return json({ user: pub(user) }, 200, { "Set-Cookie": sessionCookie(token, secure) });
}

async function logout(request, env, secure) {
  const token = getSessionToken(request);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(secure) });
}

async function me(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  return json({ user: pub(user) });
}

/* ---- friends ------------------------------------------------------------- */
async function listFriends(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  const rows = (await env.DB.prepare(
    `SELECT f.user_id, f.friend_id, f.status, f.requester_id,
            ua.username AS u_username, ua.display_name AS u_display,
            ub.username AS f_username, ub.display_name AS f_display
       FROM friendships f
       JOIN users ua ON ua.id = f.user_id
       JOIN users ub ON ub.id = f.friend_id
      WHERE f.user_id = ? OR f.friend_id = ?`
  ).bind(user.id, user.id).all()).results || [];

  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const other = r.user_id === user.id
      ? { id: r.friend_id, username: r.f_username, displayName: r.f_display }
      : { id: r.user_id,   username: r.u_username, displayName: r.u_display };
    if (r.status === "accepted") friends.push(other);
    else if (r.requester_id === user.id) outgoing.push(other);
    else incoming.push(other);
  }
  return json({ friends, incoming, outgoing });
}

async function friendRequest(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const username = String(b.username || "").trim();

  const target = await env.DB.prepare(`SELECT * FROM users WHERE lower(username) = lower(?)`).bind(username).first();
  if (!target) return json({ error: "No user with that username." }, 404);
  if (target.id === user.id) return json({ error: "You can't add yourself." }, 400);

  const existing = await env.DB.prepare(
    `SELECT status FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`
  ).bind(user.id, target.id, target.id, user.id).first();
  if (existing) return json({ error: existing.status === "accepted" ? "Already friends." : "Request already pending." }, 409);

  await env.DB.prepare(
    `INSERT INTO friendships (user_id, friend_id, status, requester_id, created_at) VALUES (?, ?, 'pending', ?, ?)`
  ).bind(user.id, target.id, user.id, Date.now()).run();
  return json({ ok: true });
}

async function friendRespond(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const fromId = b.userId | 0;
  const accept = !!b.accept;

  // The pending row was created by the OTHER user (requester) toward me.
  const row = await env.DB.prepare(
    `SELECT * FROM friendships WHERE user_id = ? AND friend_id = ? AND status = 'pending'`
  ).bind(fromId, user.id).first();
  if (!row) return json({ error: "No such request." }, 404);

  if (accept) {
    await env.DB.prepare(
      `UPDATE friendships SET status = 'accepted' WHERE user_id = ? AND friend_id = ?`
    ).bind(fromId, user.id).run();
  } else {
    await env.DB.prepare(
      `DELETE FROM friendships WHERE user_id = ? AND friend_id = ?`
    ).bind(fromId, user.id).run();
  }
  return json({ ok: true });
}

async function friendRemove(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const b = await request.json().catch(() => ({}));
  const otherId = b.userId | 0;
  await env.DB.prepare(
    `DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`
  ).bind(user.id, otherId, otherId, user.id).run();
  return json({ ok: true });
}

/* ---- history ------------------------------------------------------------- */
async function listHistory(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  const rows = (await env.DB.prepare(
    `SELECT g.id, g.code, g.game_type, g.started_at, g.ended_at, g.winner_seat,
            gp.seat, gp.rank, gp.final_score
       FROM game_players gp JOIN games g ON g.id = gp.game_id
      WHERE gp.user_id = ? AND g.ended_at IS NOT NULL
      ORDER BY g.ended_at DESC LIMIT 50`
  ).bind(user.id).all()).results || [];

  return json({ games: rows.map((r) => ({
    id: r.id, code: r.code, gameType: r.game_type,
    startedAt: r.started_at, endedAt: r.ended_at,
    yourSeat: r.seat, yourRank: r.rank, yourScore: r.final_score,
    won: r.winner_seat === r.seat,
  })) });
}

async function gameDetail(request, env, gameId) {
  const user = await getUser(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);

  // Only participants can view a game's detail.
  const mine = await env.DB.prepare(
    `SELECT 1 FROM game_players WHERE game_id = ? AND user_id = ?`
  ).bind(gameId, user.id).first();
  if (!mine) return json({ error: "not-found" }, 404);

  const game = await env.DB.prepare(`SELECT * FROM games WHERE id = ?`).bind(gameId).first();
  if (!game) return json({ error: "not-found" }, 404);
  const players = (await env.DB.prepare(
    `SELECT seat, user_id, name, is_bot, final_score, rank FROM game_players WHERE game_id = ? ORDER BY seat`
  ).bind(gameId).all()).results || [];
  const rounds = (await env.DB.prepare(
    `SELECT round_no, scores, totals, breakdown FROM rounds WHERE game_id = ? ORDER BY round_no`
  ).bind(gameId).all()).results || [];

  return json({
    game: {
      id: game.id, code: game.code, gameType: game.game_type,
      startedAt: game.started_at, endedAt: game.ended_at, winnerSeat: game.winner_seat,
    },
    players: players.map((p) => ({
      seat: p.seat, userId: p.user_id, name: p.name, isBot: !!p.is_bot,
      finalScore: p.final_score, rank: p.rank,
    })),
    rounds: rounds.map((r) => ({
      roundNo: r.round_no,
      scores: safeParse(r.scores),
      totals: safeParse(r.totals),
      breakdown: safeParse(r.breakdown),
    })),
  });
}

function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }
