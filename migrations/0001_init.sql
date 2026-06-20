-- =========================================================
-- Convoy MVP — D1 schema (回合2, no auth / no Stripe yet)
--
--  ERD:
--
--    messages
--    ┌──────────────────────────────────────┐
--    │ id          TEXT PRIMARY KEY          │  -- crypto.randomUUID()
--    │ room        TEXT NOT NULL             │  -- chat room / channel slug
--    │ user        TEXT NOT NULL             │  -- anonymous handle (body param)
--    │ text        TEXT NOT NULL             │  -- message body
--    │ created_at  INTEGER NOT NULL          │  -- ms since epoch
--    └──────────────────────────────────────┘
--        index idx_messages_room_time (room, created_at DESC)
--
--  Notes:
--   - "user" is a reserved-ish word but valid as a column name when quoted
--     in SQL via prepared-statement binds; we always bind, never interpolate.
--   - Composite index covers the hot path: GET /api/messages?room=X ORDER BY
--     created_at DESC (architecture-review.md Issue 6, Approach A).
-- =========================================================

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  room        TEXT NOT NULL,
  "user"      TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_room_time
  ON messages (room, created_at DESC);
