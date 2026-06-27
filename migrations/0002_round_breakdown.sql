-- Add per-seat round breakdown (hearts taken, Queen taken, notes) so the
-- history view can coach the player on what went wrong each round.
-- Apply: npx wrangler d1 execute DB --local/--remote --file=migrations/0002_round_breakdown.sql

ALTER TABLE rounds ADD COLUMN breakdown TEXT;
