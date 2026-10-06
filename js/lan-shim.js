/* =============================================================================
 * Black Queen — BROWSER STAND-INS FOR THE ROOM SERVER'S IMPORTS  (ES module)
 * -----------------------------------------------------------------------------
 * Local-network play runs the cloud's room class (party/main.js) in the host's
 * browser. index.html's import map points that file's three imports here:
 *   • "partyserver"      → Server / getServerByName below
 *   • "./engine.js"      → BQ (the classic scripts already loaded it — importing
 *                          the engine modules again would re-create its classes)
 *   • "./api.js"         → getUser (accounts live in the cloud only)
 * js/lan.js subclasses the result and overrides everything platform-specific
 * (storage, lobby, history, backups); what's left here is the bare minimum the
 * class touches while it runs.
 * ===========================================================================*/

// The parts of a partyserver Server the room uses. `ctx` is built by js/lan.js:
// { name, conns: Map(id → connection), storage, blockConcurrencyWhile }.
export class Server {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  get name() { return this.ctx.name; }
  getConnection(id) { return this.ctx.conns.get(id); }
}

// There is no lobby registry on the local network (the cloud room reports for
// the table). Callers already treat the lobby as best-effort.
export function getServerByName() {
  return Promise.reject(new Error("no lobby on the local network"));
}

export const BQ = globalThis.BQ;

export async function getUser() { return null; }
