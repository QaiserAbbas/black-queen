/* =============================================================================
 * Black Queen — HEADLESS ENGINE BUNDLE (Cloudflare Workers / PartyKit)
 * -----------------------------------------------------------------------------
 * The six game modules are plain IIFEs that attach to `globalThis.BQ` (they run
 * unchanged in the browser AND here — no Node APIs, no DOM). Importing them for
 * their side effects populates globalThis.BQ; we just re-export it so the party
 * servers can `import { BQ } from "./engine.js"`.
 *
 * Order matters: config → cards → ai → engine, then the Treeky pair.
 * ===========================================================================*/

import "../js/config.js";
import "../js/cards.js";
import "../js/ai.js";
import "../js/engine.js";
import "../js/treeky-engine.js";
import "../js/treeky-ai.js";

export const BQ = globalThis.BQ;
