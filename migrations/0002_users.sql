-- =========================================================
-- Convoy MVP — auth slice (回合3)
--
--  ERD update (extends 0001):
--
--    messages                          users
--    ┌──────────────────────┐          ┌────────────────────────────┐
--    │ id          TEXT PK   │          │ id            TEXT PRIMARY KEY │
--    │ room        TEXT      │          │ email         TEXT NOT NULL UNIQUE │
--    │ user        TEXT      │ ←─ name │ password_hash TEXT NOT NULL       │
--    │ user_id     TEXT  ────┼────────→│ created_at    INTEGER NOT NULL    │
--    │ text        TEXT      │          └────────────────────────────────────┘
--    │ created_at  INTEGER   │
--    └──────────────────────┘
--
--  Design notes:
--   - messages.user is kept for back-compat with anonymous rows from 回合2;
--     we ADD a nullable user_id FK so old rows still render, new rows carry
--     the authenticated user. user_id is nullable so migration is zero-downtime
--     on the existing local D1.
--   - password_hash format: "pbkdf2$<iters>$<saltB64>$<hashB64>" (see auth.ts).
--     Single string column keeps schema simple; no separate salt column.
--   - email UNIQUE index gives us the upsert + 409 conflict path for free.
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Add nullable user_id to messages. Existing 回合2 rows keep user_id = NULL
-- and still render via the `user` column; new authenticated rows populate
-- both `user` (denormalized handle = email) and `user_id` (FK).
ALTER TABLE messages ADD COLUMN user_id TEXT REFERENCES users(id);
