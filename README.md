# ♛ Black Queen

A polished, fully-playable Black Queen card game (a Hearts-style trick-taking
game) with a clean, **rule-driven engine** designed to be modified later.

## Run it

**Single player** — just open `index.html` in any modern browser. Works offline,
no build step, no dependencies, no audio files (sound is synthesized live).

```
open index.html          # macOS
```

If your browser blocks audio/JS from `file://`, serve it: `python3 -m http.server 8765`.

**Multiplayer on your LAN** — run the included zero-dependency Node server:

```
node server.js            # default port 3000  (node server.js 8080 to change)
```

It prints a URL like `http://192.168.0.166:3000`. Everyone on the same
Wi-Fi/network opens that URL in a browser, picks **Multiplayer (LAN)**, and:

1. One player taps **Create Room** → gets a 4-letter code (e.g. `BWNB`).
2. Others tap **Join Room** and enter the code — or **leave the box blank** to
   join the only open game automatically. (Codes never contain `0`, `1`, `I`, or
   `O`. If you mistype, the error lists the valid open-room codes.)
3. The host presses **Start**. Empty seats are filled with bots.

Between rounds, **every player must press "I'm Ready"** — the next round only
begins once all connected humans have confirmed (the summary shows who's ready).
AI seats are clearly tagged **BOT**, your own seat is tagged **YOU**, and the
player whose turn it is glows/pulses (including bots).

The server runs the authoritative game; if someone disconnects, their seat
becomes a bot so the game never stalls. The host advances rounds and can edit
rules (Settings) before starting. Requires Node.js (v14+); no `npm install`.

### Connection health (built in)

Both sides heartbeat: the server pings every WebSocket every 25 s (and replies
to pings per RFC 6455), the client pings the server every 20 s. This keeps
cloud proxies (ngrok, Render, Cloudflare…) from killing "idle" sockets, measures
your latency (shown as a 🟢 pill in the toolbar), and detects half-open
connections within seconds instead of minutes. `setNoDelay` is enabled, so
moves aren't batched by Nagle's algorithm. A dropped player's seat shows
**⚠️ OFFLINE** on every table, a bot covers it, and the player auto-reconnects
into the exact same seat (their session token is kept for 90 s).

### Hosting it online (play across the internet)

The repo ships with `render.yaml` — push to GitHub, then on
[Render](https://render.com): *New → Blueprint → pick the repo*. One service
serves the site **and** the WebSocket.

- **Free tier sleeps after ~15 min idle** — the first visitor waits 30–50 s and
  it can feel "stuck". For real games use the **Starter** plan (always-on), or
  [Railway](https://railway.app) / [Fly.io](https://fly.io) — both run a plain
  Node server with WebSockets always-on for a few dollars a month.
- Rooms live in memory: keep it at **one instance** (no autoscaling).
- ngrok works for a quick session (`ngrok http 3000`), but tunnels add latency
  and free tunnels drop idle connections — the built-in heartbeat + auto-resume
  now survives that, but a real host is smoother.

### Desktop & mobile app

The game is a **PWA**: served over HTTPS (any of the hosts above), browsers
offer **Install** (desktop Chrome/Edge: ⊕ icon in the address bar; Android:
"Add to Home screen"; iOS Safari: Share → "Add to Home Screen"). It launches
fullscreen like a native app, and single player works offline.

To go further:
- **Desktop**: wrap with [Tauri](https://tauri.app) (tiny, Rust) or Electron —
  point the window at your hosted URL or bundle the static files.
- **Mobile stores**: wrap with [Capacitor](https://capacitorjs.com) — the
  whole game is static HTML/JS, so it drops straight in; multiplayer just needs
  the hosted server URL.

### Emotes & quick messages

In an online game, tap **💬** to send an emoji reaction, a preset quick message
("Nice play!", "Hurry up ⏳"…) or a short typed message — it pops up as a speech
bubble at your seat on everyone's table. Rate-limited server-side.

### Attack taunts (multiplayer)

💬 → the red **attack row**: send a 🦁 Lion charge, 🐉 Dragon fire, 💣 Bomb,
👻 Ghost or 💀 Doom rampaging across **every player's table** — pressure your
opponents right before they pick a card. Budget is **one attack per move**
(server-enforced); playing a card recharges it.

### Cinematics & sound

Big moments get live-stream-style effects (all CSS 3D + synthesized audio, no
assets, no dependencies — see `js/fx.js`):
- **Black Queen lands** → full-screen takeover: lightning, shockwave rings, a
  spinning 3D Q♠, falling queens, screen shake, thunder + tolling bells.
- **Someone eats hearts** → a beating heart bursts over their seat with the
  points, plus a soft thump-and-sigh sound.
- **Hearts broken** → top banner sweep + 💔 rain + whoosh.
- **Game over** → 3D tumbling confetti, trophy banner, brass-y fanfare.
- **Emoji reactions** (multiplayer) → float up the screen like a TikTok live.

Everything can be turned off per player: 🎨 → *Cinematic effects*.

All particles (sparks, rains, floats, confetti, attack actors) run on a single
full-screen **canvas** with a physics loop (`js/fx.js`) — velocity, gravity,
drag, sway, trails. Cards **fly** from each player's hand to the trick with an
arc (opponents' cards 3D-flip face-up mid-air), and deals spin out of the
center deck. Real recorded sounds live in `sounds/` (shuffle, card place, hard
punch) with synthesized fallbacks. **Settings → Sound Volumes** mixes six
channels independently: master, music, cards, hard punch, effects, interface.

### Appearance (per player)

Tap **🎨** (menu or in-game). Each player can pick — just for themselves:
- **Card size** — 70 % to 140 % slider for your own hand.
- **Table felt** — 6 themes (emerald, midnight, crimson, charcoal, royal, sand).
- **Card back** — 10 designs.
- **Card style** — classic illustrated deck, big-and-clean text, or
  high-contrast night cards.
- **Pre-select** — tick the option, then tap a card *before* your turn; it's
  pinned 📌 and plays automatically the moment your turn arrives (tap again to
  unpin).

## How to play

Avoid winning tricks that contain penalty cards. **Lowest total score wins.**

| Card                 | Points |
|----------------------|--------|
| Black Queen (Q♠)     | **12** |
| Each Heart (♥)       | **1**  |
| **Total per round**  | **25** |

Special rules (all toggleable in Settings):
- Win **no trick** all round → **−12**.
- **3** zero-point rounds in a row → **−12**.
- The two −12 penalties **never stack** — you lose at most −12 per round from
  them, and receiving any −12 **resets** your consecutive-zero streak.
- **Queen immunity:** a player at **≥ 80** points can't be charged the Queen.
  If they capture it, the 12 points are disregarded (they take only the hearts,
  so the round totals 13). Threshold is editable in Settings.
- **Must throw the Queen:** if you can't follow the led suit (you're void) and
  you hold the Black Queen, you're forced to discard it — you can't hold it back.
  *Exception:* if the Queen's points are **guaranteed wasted** this trick (every
  player who could still win it is score-exempt), throwing becomes optional. If
  there's any chance a non-exempt player takes it, you must throw.
- **No passing** cards.
- **Highest-scoring** player deals; player to their **right** leads first, and
  play proceeds to the **right** (counter-clockwise).
- A scoreboard shows running totals, a per-round breakdown, and a hand-by-hand
  conceded-points matrix (with a ♛ marker for who took/voided the Queen).

## Architecture — where to change things

Everything is plain ES5-ish JavaScript in `js/`, loaded as classic scripts (so
it runs from `file://`). All modules hang off a single global `BQ` namespace.

| File              | Responsibility | Edit this when you want to… |
|-------------------|----------------|------------------------------|
| `js/config.js`    | **All rules & tunables** (`DEFAULT_RULES`). | Change points, penalties, win conditions, player count, bot names, speeds. |
| `js/cards.js`     | Card/Deck data, shuffle, deal, sort. | Change deck composition or sorting. |
| `js/engine.js`    | Headless game engine: state, turns, trick resolution, scoring. Emits events. | Change *how* rules are applied / trick logic. |
| `js/ai.js`        | Bot decision heuristics. | Make bots smarter/dumber. |
| `js/sound.js`     | Web-Audio synthesized SFX + ambient music. | Change/add sounds. |
| `js/ui.js`        | All rendering, animation, modals, FX. | Change look & feel. |
| `js/net.js`       | Client networking: `NetClient` (WebSocket) + `NetworkEngine` (mirrors the engine, driven by server snapshots). | Change the wire protocol or client-side sync. |
| `js/main.js`      | Bootstrap: wires menu, lobby, the Settings rule-editor, single- & multi-player lifecycle. | Add new screens/buttons/settings fields. |
| `server.js`       | **LAN server** (zero-dep Node): static files + hand-rolled WebSocket + rooms + authoritative engine + bots. | Change matchmaking, rooms, or server rules. |
| `css/styles.css`  | All visual styling. | Restyle the table, cards, effects. |

### How multiplayer works
The same `GameEngine` runs **on the server** (it's headless, so it just works in
Node). Each connected browser is a thin view: it sends `{t:'play',cardId}` and
receives personalized **snapshots** (only your own hand is revealed) plus a
`hint` describing what just happened, which `NetworkEngine` turns back into the
exact same UI events the local engine emits. The UI is *perspective-aware*
(`ui.me`) so every player sees themselves at the bottom seat.

### The golden rule
The engine **never hard-codes a rule value** — it always reads from `this.rules`
(the config object). So to retune the game you only touch `config.js` (defaults)
or the in-game **Settings** panel (live overrides, saved to `localStorage`).

### Engine events (subscribe in `ui.js`)
```js
engine.on('roundStart',  e => ...)  // {round, dealerIndex, leaderIndex, hands}
engine.on('turn',        e => ...)  // {playerIndex, legalCardIds}
engine.on('cardPlayed',  e => ...)  // {playerIndex, card, trick}
engine.on('trickWon',    e => ...)  // {winnerIndex, trick, points}
engine.on('heartsBroken',e => ...)
engine.on('roundEnd',    e => ...)  // {round, roundScores, totals, breakdown}
engine.on('gameOver',    e => ...)  // {totals, winnerIndex, ranking}
```

### Adding a new editable rule
1. Add the key + default to `DEFAULT_RULES` in `config.js`.
2. Read it wherever needed in `engine.js` via `this.rules.yourKey`.
3. Add one row to `SETTINGS_SCHEMA` in `main.js` so it appears in the editor.

## Customizing rules in-game
Click **⚙️** (in-game) or **Settings** (menu). Change any value, hit **Save** —
it applies on the next round and persists across sessions. **Reset Defaults**
restores `config.js` values.
