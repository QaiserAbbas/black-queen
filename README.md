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
