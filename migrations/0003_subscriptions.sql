-- =========================================================
-- Convoy MVP — paywall mock slice (回合4)
--
--  ERD update (extends 0002):
--
--    users                                 subscriptions
--    ┌────────────────────────────┐        ┌──────────────────────────────────────┐
--    │ id            TEXT PK       │        │ user_id              TEXT PRIMARY KEY │
--    │ email         TEXT UNIQUE   │ ──1:1→ │ status               TEXT NOT NULL    │
--    │ password_hash TEXT          │        │ plan                 TEXT NOT NULL    │
--    │ created_at    INTEGER       │        │ current_period_end   INTEGER          │
--    └────────────────────────────┘        │ checkout_session_id  TEXT             │
--                                         │ created_at           INTEGER NOT NULL │
--                                         │ updated_at           INTEGER NOT NULL │
--                                         └──────────────────────────────────────┘
--
--  Design notes:
--   - 1:1 with users, PK = user_id. Cheaper than a separate id column for a
--     1:1 relation; we already have the FK value to look up by.
--   - Separate table from users: billing state evolves independently of
--     identity. Later we add invoices, trials, cancellations without touching
--     the auth table or its indexes.
--   - status: 'free' | 'paid'. We don't store 'trialing' or 'past_due' in the
--     MVP — the mock webhook flips free→paid in one step. Real Stripe would
--     emit customer.subscription.* events that map to these.
--   - plan: 'free' | 'pro'. Product catalog stays in code (shared/types.ts);
--     the row only records the user's current entitlement.
--   - current_period_end: ms-since-epoch, nullable. Mock sets +30d on
--     checkout; real Stripe gives this on the subscription object.
--   - checkout_session_id: stored so the mock webhook can correlate an
--     "incoming" event to the row we created at checkout time. Real Stripe
--     signs this; the mock signs an HMAC of {session_id, user_id}.
--   - Quota is NOT stored here — we COUNT messages written today by user_id.
--     Rationale: the messages table is already the source of truth for
--     activity; a denormalized counter would drift on retries / deletes.
--     Cost is one indexed COUNT(*) per post, fine at MVP volume.
--   - Index on messages(user_id, created_at DESC) is added below to make the
--     daily-quota COUNT cheap. Also useful for future "my messages" views.
-- =========================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('free', 'paid')),
  plan                TEXT NOT NULL CHECK (plan IN ('free', 'pro')),
  current_period_end  INTEGER,
  checkout_session_id TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Fast lookup: "is this user paid?" + the daily-quota COUNT.
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);
CREATE INDEX IF NOT EXISTS idx_messages_user_time ON messages (user_id, created_at DESC);
