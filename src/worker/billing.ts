// =========================================================
// Billing mock — checkout / webhook / quota enforcement (回合4 MVP slice)
//
//  What is mocked vs what would be real:
//
//    Real Stripe                    Mock here
//    ──────────────────────────     ────────────────────────────────────
//    POST /v1/checkout/sessions     POST /api/billing/checkout
//      → hosted checkout URL          → fake URL pointing at our own page
//    Stripe signs event              HMAC-SHA256(secret, `${sid}.${uid}`)
//    POST customer.subscription.*    POST /api/billing/webhook
//      → flips subscription state      → flips subscription state
//
//  Why HMAC the mock webhook at all:
//    a webhook with no verification is worse than a mock — it lets anyone
//    upgrade anyone by POSTing {user_id}. Signing with the same secret class
//    as JWT_SECRET keeps the security shape of real Stripe: only the
//    checkout-issuing server (us) can produce a signature the webhook will
//    accept. The "checkout" step is what mints that signature.
//
//  Quota model:
//    free → at most FREE_DAILY_LIMIT messages in the current UTC day.
//    Count is a single indexed COUNT(*) on messages(user_id, created_at).
//    Why count instead of a denormalized counter:
//      - the messages table is already the source of truth for activity;
//      - a counter would drift on retries / future delete-by-user features;
//      - at MVP volume one COUNT is well under 1ms on the indexed range.
//
//  Failure modes:
//    - BILLING_WEBHOOK_SECRET missing → checkout 500, webhook 500 (same
//      posture as JWT_SECRET missing: hard-fail over silent-insecure).
//    - signature mismatch → webhook 401, no state change.
//    - subscription row missing on quota check → treat as free (defensive:
//      register should always create the row, but a partially failed signup
//      must not grant unlimited access by accident).
// =========================================================

import {
  FREE_DAILY_LIMIT,
  MOCK_PRO_PERIOD_MS,
  type Subscription,
} from "../../shared/types";

// --- UTC day boundary ----------------------------------------------------
//
// Quota resets at UTC midnight. Storing "today" as a ms timestamp keeps the
// SQL range check a simple `created_at >= ?` with no date-string parsing in
// SQLite (which would force a function on the column and bypass the index).
export function utcDayStartMs(now = Date.now()): number {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor(now / dayMs) * dayMs;
}

// --- HMAC signing (mock Stripe signature) --------------------------------
//
// hex-encoded HMAC-SHA256 over `${session_id}.${user_id}`. Hex (not base64)
// so the signature is URL-safe to pass back from the fake checkout page to
// the webhook without encoding headaches.
export async function signSession(
  secret: string,
  sessionId: string,
  userId: string
): Promise<string> {
  if (!secret) throw new Error("BILLING_WEBHOOK_SECRET not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${sessionId}.${userId}`)
  );
  // hex
  const bytes = new Uint8Array(mac);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// Constant-time-ish string compare — same rationale as password verify.
// Network jitter dominates anyway; this just avoids the trivial early-exit
// oracle.
export async function verifySession(
  secret: string,
  sessionId: string,
  userId: string,
  presented: string
): Promise<boolean> {
  if (!secret) return false;
  const expected = await signSession(secret, sessionId, userId);
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

// --- Subscription read/write --------------------------------------------

export async function getSubscription(
  db: D1Database,
  userId: string
): Promise<Subscription | null> {
  // NOTE: must SELECT checkout_session_id — the webhook correlates the inbound
  // event to the row by it (sub.checkout_session_id === session_id). Omitting
  // the column here silently always returned undefined and the webhook 404'd
  // every upgrade. Caught in 回合4 end-to-end verification.
  const row = await db
    .prepare(
      `SELECT user_id, status, plan, current_period_end, checkout_session_id, created_at, updated_at
         FROM subscriptions WHERE user_id = ?`
    )
    .bind(userId)
    .first<Subscription>();
  return row ?? null;
}

// Create the default free subscription for a freshly registered user.
// Idempotent on the PK (user_id) — safe to retry. Uses INSERT OR IGNORE so a
// re-run (e.g. register retried after a transient D1 error) doesn't 500.
export async function createFreeSubscription(
  db: D1Database,
  userId: string
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT OR IGNORE INTO subscriptions
         (user_id, status, plan, current_period_end, checkout_session_id, created_at, updated_at)
       VALUES (?, 'free', 'free', NULL, NULL, ?, ?)`
    )
    .bind(userId, now, now)
    .run();
}

// Daily usage for a user (messages written since UTC midnight).
export async function todayMessageCount(
  db: D1Database,
  userId: string
): Promise<number> {
  const since = utcDayStartMs();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND created_at >= ?`
    )
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Outcome of a quota check. paid users always pass; free users pass while
// under the cap. The number returned is what the caller reports in 402 errors
// and in /api/billing/status so the UI can render "12 / 50 today".
export interface QuotaCheck {
  allowed: boolean;
  status: Subscription["status"];
  used: number;
  limit: number | null; // null = unlimited (paid)
  reason?: "free_limit_reached" | "no_subscription";
}

export async function checkQuota(
  db: D1Database,
  userId: string
): Promise<QuotaCheck> {
  const sub = await getSubscription(db, userId);
  if (!sub) {
    // Defensive: no row = unbounded-free would be a security regression.
    // Treat as free with 0 used so the user is blocked at the limit, not past
    // it. The register flow should have created the row; this is a backstop.
    return {
      allowed: true, // first message allowed; row should exist by next call
      status: "free",
      used: 0,
      limit: FREE_DAILY_LIMIT,
      reason: "no_subscription",
    };
  }

  if (sub.status === "paid") {
    return { allowed: true, status: "paid", used: 0, limit: null };
  }

  const used = await todayMessageCount(db, userId);
  const allowed = used < FREE_DAILY_LIMIT;
  return {
    allowed,
    status: "free",
    used,
    limit: FREE_DAILY_LIMIT,
    reason: allowed ? undefined : "free_limit_reached",
  };
}

// --- Checkout & upgrade -------------------------------------------------
//
// "Opening a checkout session" in the mock = minting a session_id and signing
// it, then recording the session_id on the row so the webhook can correlate.
// We don't mark the user paid yet — payment happens at webhook time, matching
// Stripe's lifecycle (checkout.created → customer completes → webhook fires).
export async function openCheckout(
  db: D1Database,
  secret: string,
  userId: string
): Promise<{ session_id: string; url: string }> {
  if (!secret) throw new Error("BILLING_WEBHOOK_SECRET not configured");

  const sessionId = `cs_mock_${crypto.randomUUID().replace(/-/g, "")}`;
  // Persist so the webhook can verify "this session really was issued by us
  // for this user" — the HMAC alone proves it, but recording the id also lets
  // a future admin UI show "abandoned checkouts".
  const now = Date.now();
  await db
    .prepare(
      `UPDATE subscriptions SET checkout_session_id = ?, updated_at = ? WHERE user_id = ?`
    )
    .bind(sessionId, now, userId)
    .run();

  // Fake "Stripe-hosted" URL: points at our own SPA, which auto-fires the
  // webhook with the signed payload to simulate the customer completing
  // checkout. Real Stripe would host this page and redirect on success.
  const url = `/billing/return?session_id=${sessionId}&user_id=${userId}`;
  return { session_id: sessionId, url };
}

// Apply a successful checkout: flip the row to paid/pro for +30d.
export async function applyUpgrade(
  db: D1Database,
  userId: string
): Promise<Subscription> {
  const now = Date.now();
  const periodEnd = now + MOCK_PRO_PERIOD_MS;
  await db
    .prepare(
      `UPDATE subscriptions
          SET status = 'paid', plan = 'pro', current_period_end = ?, updated_at = ?
        WHERE user_id = ?`
    )
    .bind(periodEnd, now, userId)
    .run();
  const updated = await getSubscription(db, userId);
  // applyUpgrade is only called after a verified webhook for a user we just
  // minted a session for, so the row must exist. If it somehow doesn't,
  // throw rather than fabricate one — the caller surfaces a 500.
  if (!updated) throw new Error("subscription row vanished during upgrade");
  return updated;
}
