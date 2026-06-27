/* =============================================================================
 * Black Queen — WORKER ENTRY (Cloudflare Workers + partyserver)
 * -----------------------------------------------------------------------------
 * The Worker's job is tiny:
 *   • route /parties/:party/:room  →  the matching Durable Object (partyserver)
 *   • everything else  →  static assets (index.html, js, css, cards, sounds)
 *
 * `routePartykitRequest` keeps the SAME /parties/:party/:name URL scheme PartyKit
 * used, so the browser client is unchanged. Party "main" → the Main binding (the
 * game room), party "lobby" → the Lobby binding (the shared registry).
 * ===========================================================================*/

import { routePartykitRequest } from "partyserver";
import { handleApi } from "./api.js";

export { Main } from "./main.js";    // one Durable Object per room (the game)
export { Lobby } from "./lobby.js";  // a single shared registry object

export default {
  async fetch(request, env) {
    // 1) accounts / friends / history  →  /api/* (D1)
    const api = await handleApi(request, env);
    if (api) return api;
    // 2) WebSocket upgrades + lobby HTTP  →  a Durable Object
    // 3) everything else  →  static assets (Workers Assets serves most first)
    return (await routePartykitRequest(request, env)) || env.ASSETS.fetch(request);
  },
};
