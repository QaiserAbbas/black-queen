-- Black Queen — accounts, friends, and game history (Cloudflare D1 / SQLite).
-- Apply locally:  npx wrangler d1 execute DB --local  --file=migrations/0001_init.sql
-- Apply remote:   npx wrangler d1 execute DB --remote --file=migrations/0001_init.sql

PRAGMA foreign_keys = ON;

-- ---- accounts -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,
  username      TEXT NOT NULL,            -- public handle (friend requests)
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,            -- PBKDF2-SHA256, base64
  password_salt TEXT NOT NULL,            -- per-user random salt, base64
  iterations    INTEGER NOT NULL,         -- PBKDF2 iteration count (future-proofing)
  created_at    INTEGER NOT NULL
);
-- Case-insensitive uniqueness for login email + public handle.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));

-- ---- login sessions -------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,            -- random, stored in an httpOnly cookie
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- ---- friendships ----------------------------------------------------------
-- One row per directed pair. status: 'pending' (requester -> addressee) or
-- 'accepted'. requester_id records who sent it so we can show incoming vs out.
CREATE TABLE IF NOT EXISTS friendships (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,             -- 'pending' | 'accepted'
  requester_id INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships (friend_id);

-- ---- game history ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,           -- random id
  code        TEXT NOT NULL,              -- room code it was played in
  game_type   TEXT NOT NULL,              -- 'blackqueen' | 'treeky'
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,                    -- null until the game finishes
  winner_seat INTEGER                     -- seat index of the winner (null if unfinished)
);
CREATE INDEX IF NOT EXISTS idx_games_ended ON games (ended_at);

-- One row per seat in a game (humans AND bots). user_id is null for bots/guests.
CREATE TABLE IF NOT EXISTS game_players (
  game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seat        INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  final_score INTEGER,
  rank        INTEGER,
  PRIMARY KEY (game_id, seat)
);
CREATE INDEX IF NOT EXISTS idx_gp_user ON game_players (user_id);

-- Per-round breakdown. scores is a JSON array of per-seat round scores.
CREATE TABLE IF NOT EXISTS rounds (
  game_id    INTEGER NOT NULL,            -- TEXT in practice; SQLite is dynamic
  round_no   INTEGER NOT NULL,
  scores     TEXT NOT NULL,               -- JSON: [seat0, seat1, ...]
  totals     TEXT,                        -- JSON: running totals after this round
  created_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, round_no)
);
