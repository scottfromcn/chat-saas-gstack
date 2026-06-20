// =========================================================
// Convoy Worker — Hono routes (回合4 billing mock slice)
//
//  Route table (★ = new this round; ◐ = changed this round):
//
//    GET  /api/health                              → { ok, ts }
//    POST /api/auth/register  {email,pwd}          → 201 { token, user }    ◐ seeds free sub
//    POST /api/auth/login     {email,pwd}          → 200 { token, user }
//    GET  /api/messages?room=X   [auth]            → { messages: [...] }
//    POST /api/messages  [auth] {room,text}        → 201 { message }        ◐ quota check
//    GET  /api/billing/status   [auth]             → { subscription, usage } ★
//    POST /api/billing/checkout [auth]             → { session_id, url }     ★ (mock Stripe)
//    POST /api/billing/webhook {sid,uid,signature} → { ok: true }            ★ (mock verify)
//    GET  /ws/:room                                → upgrade to ChatRoom DO
//    GET  /                                        → static SPA
//
//  Auth model: unchanged from 回合3 (Bearer JWT). Billing routes that need
//  "who is the customer" reuse the same middleware; the webhook is the one
//  public billing route — like real Stripe, it authenticates by signature,
//  not by user session.
//
//  Quota enforcement point: POST /api/messages only. Reads (GET history) are
//  unlimited on both tiers — reading is not the scarce resource. WS-origin
//  writes go through the DO which currently has no auth/quota; that's a known
//  gap inherited from 回合2/3 (WS auth = architecture-review Issue 4) and the
//  quota wedge doesn't widen that surface. The HTTP path is what the billing
//  demo exercises end-to-end.
//
//  Persistence: messages.user_id FK (回合3) is reused as the quota counter
//  key — no extra writes per message, the COUNT(*) on the indexed range is
//  the only added cost.
// =========================================================

import { Hono, type Context, type Next } from "hono";
import { ChatRoom, type Env } from "./chat-room.do";
import type {
  ChatMessage,
  User,
  JwtPayload,
  Subscription,
} from "../../shared/types";
import { MAX_MESSAGE_TEXT, FREE_DAILY_LIMIT } from "../../shared/types";
import {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  isValidEmail,
  isValidPassword,
} from "./auth";
import {
  createFreeSubscription,
  getSubscription,
  checkQuota,
  todayMessageCount,
  openCheckout,
  applyUpgrade,
  signSession,
  verifySession,
} from "./billing";

export { ChatRoom };

const HISTORY_LIMIT = 100;

const app = new Hono<{ Bindings: Env; Variables: { jwt: JwtPayload } }>();

// --- Health check (public) ----------------------------------------------
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));

// --- Auth: register -------------------------------------------------------
//
// POST /api/auth/register { email, password } → 201 { token, user }
//   - 400 invalid email / password
//   - 409 email already registered (UNIQUE constraint surface)
//   - 500 JWT_SECRET missing or D1 failure
//
app.post("/api/auth/register", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "bad_request", message: "invalid json" } }, 400);
  }
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };

  // Normalize email: trim + lowercase so case variants don't create dupes.
  const normalized =
    typeof email === "string" ? email.trim().toLowerCase() : email;

  if (!isValidEmail(normalized)) {
    return c.json(
      { error: { code: "bad_request", message: "invalid email" } },
      400
    );
  }
  if (!isValidPassword(password)) {
    return c.json(
      {
        error: {
          code: "bad_request",
          message: "password must be 8-72 characters",
        },
      },
      400
    );
  }
  if (!c.env.JWT_SECRET) {
    // Hard fail rather than issuing unsigned tokens — security over UX.
    console.error("JWT_SECRET not configured");
    return c.json({ error: { code: "internal", message: "auth not configured" } }, 500);
  }

  const user: User = {
    id: crypto.randomUUID(),
    email: normalized,
    created_at: Date.now(),
  };

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (err) {
    console.error("hash failed", err);
    return c.json({ error: { code: "internal", message: "hash failed" } }, 500);
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`
    )
      .bind(user.id, user.email, passwordHash, user.created_at)
      .run();
  } catch (err: unknown) {
    // D1 surfaces UNIQUE violation as "SQLITE_CONSTRAINT UNIQUE".
    const msg = (err as { message?: string })?.message ?? "";
    if (msg.includes("UNIQUE")) {
      return c.json(
        { error: { code: "conflict", message: "email already registered" } },
        409
      );
    }
    console.error("D1 user insert failed", err);
    return c.json({ error: { code: "internal", message: "persist failed" } }, 500);
  }

  // Seed the free subscription. Best-effort: if this throws, the user can still
  // log in — checkQuota treats a missing row defensively as free, so the wall
  // still works. We log but don't fail the register.
  try {
    await createFreeSubscription(c.env.DB, user.id);
  } catch (err) {
    console.error("subscription seed failed", err);
  }

  const token = await issueToken(user, c.env.JWT_SECRET);
  return c.json({ token, user }, 201);
});

// --- Auth: login ---------------------------------------------------------
//
// POST /api/auth/login { email, password } → 200 { token, user }
//   - 400 malformed body
//   - 401 wrong password OR user not found — SAME error, no user enumeration
//
app.post("/api/auth/login", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "bad_request", message: "invalid json" } }, 400);
  }
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (!isValidEmail(email) || typeof password !== "string") {
    return c.json({ error: { code: "bad_request", message: "invalid credentials" } }, 400);
  }
  if (!c.env.JWT_SECRET) {
    console.error("JWT_SECRET not configured");
    return c.json({ error: { code: "internal", message: "auth not configured" } }, 500);
  }

  const normalized = (email as string).trim().toLowerCase();
  const row = await c.env.DB.prepare(
    `SELECT id, email, password_hash, created_at FROM users WHERE email = ?`
  )
    .bind(normalized)
    .first<{ id: string; email: string; password_hash: string; created_at: number }>();

  // Always run a verify, even if the user is missing, to keep response timing
  // constant-ish (mitigates timing-based user enumeration). Cost: ~1 PBKDF2.
  const dummyHash =
    "pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const ok = row
    ? await verifyPassword(password, row.password_hash)
    : await verifyPassword(password, dummyHash);

  if (!row || !ok) {
    return c.json(
      { error: { code: "unauthorized", message: "invalid email or password" } },
      401
    );
  }

  const user: User = {
    id: row.id,
    email: row.email,
    created_at: row.created_at,
  };
  const token = await issueToken(user, c.env.JWT_SECRET);
  return c.json({ token, user }, 200);
});

// --- Auth middleware ------------------------------------------------------
//
// Pulled out as a function so /api/messages/* and the per-route billing
// mounts (status, checkout) share one implementation. The webhook does NOT
// use this — it authenticates by HMAC signature, exactly like real Stripe.
//
async function bearerAuth(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json(
      { error: { code: "unauthorized", message: "missing bearer token" } },
      401
    );
  }
  const payload = await verifyToken(match[1], c.env.JWT_SECRET);
  if (!payload) {
    return c.json(
      { error: { code: "unauthorized", message: "invalid or expired token" } },
      401
    );
  }
  c.set("jwt", payload);
  await next();
}

app.use("/api/messages/*", bearerAuth);
app.use("/api/billing/status", bearerAuth);
app.use("/api/billing/checkout", bearerAuth);

// --- History (authed) ----------------------------------------------------
//
// GET /api/messages?room=X[&limit=N]   Authorization: Bearer <jwt>
//   - 400 missing room
//   - 401 no/bad token
//   - 200 { messages: [...] } (oldest-first for typical chat rendering)
//
app.get("/api/messages", async (c) => {
  const room = c.req.query("room")?.trim();
  if (!room) {
    return c.json({ error: { code: "bad_request", message: "missing room" } }, 400);
  }
  let limit = HISTORY_LIMIT;
  const rawLimit = c.req.query("limit");
  if (rawLimit !== undefined) {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n) && n > 0 && n <= HISTORY_LIMIT) limit = n;
  }

  const result = await c.env.DB.prepare(
    `SELECT m.id, m.room, COALESCE(m."user", u.email) AS user, m.text, m.created_at
       FROM messages m
       LEFT JOIN users u ON u.id = m.user_id
      WHERE m.room = ?
      ORDER BY m.created_at DESC
      LIMIT ?`
  )
    .bind(room, limit)
    .all<ChatMessage>();

  return c.json({ messages: (result.results ?? []).reverse() });
});

// --- Post a message (authed) --------------------------------------------
//
// POST /api/messages  Authorization: Bearer <jwt>  { room, text }
//   - 400 missing/empty room, missing/empty text, text > MAX_MESSAGE_TEXT
//   - 401 no/bad token
//   - 500 D1 write failed
//   - 201 { message }
//
// Note: `user` is no longer accepted from the body — it is derived from the
// authenticated principal. This closes 回合2's spoofing hole (any client could
// claim to be anyone).
//
app.post("/api/messages", async (c) => {
  const jwt = c.get("jwt");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "bad_request", message: "invalid json" } }, 400);
  }
  const { room, text } = (body ?? {}) as { room?: unknown; text?: unknown };

  if (typeof room !== "string" || room.trim().length === 0) {
    return c.json({ error: { code: "bad_request", message: "missing room" } }, 400);
  }
  if (typeof text !== "string" || text.length === 0) {
    return c.json({ error: { code: "bad_request", message: "missing text" } }, 400);
  }
  if (text.length > MAX_MESSAGE_TEXT) {
    return c.json(
      { error: { code: "bad_request", message: `text > ${MAX_MESSAGE_TEXT}` } },
      400
    );
  }

  // --- Paywall quota check (回合4) -------------------------------------
  //
  // Free users are capped at FREE_DAILY_LIMIT messages per UTC day. We check
  // BEFORE writing so a blocked message doesn't count toward tomorrow either.
  // 402 Payment Required is the canonical "you need to pay" code; the body
  // carries the current usage + limit so the UI can render "12 / 50 today".
  // Order matters: do this after input validation so a malformed request
  // never burns the user's quota.
  const quota = await checkQuota(c.env.DB, jwt.sub);
  if (!quota.allowed) {
    return c.json(
      {
        error: {
          code: "payment_required",
          message: `free plan limit reached (${quota.used}/${quota.limit} today). upgrade for unlimited messaging.`,
          usage: { used: quota.used, limit: quota.limit },
        },
      },
      402
    );
  }

  const message: ChatMessage = {
    id: crypto.randomUUID(),
    room: room.trim().slice(0, 128),
    user: jwt.email,
    text,
    created_at: Date.now(),
  };

  try {
    await c.env.DB.prepare(
      `INSERT INTO messages (id, room, "user", user_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(message.id, message.room, message.user, jwt.sub, message.text, message.created_at)
      .run();
  } catch (err) {
    console.error("D1 insert failed", err);
    return c.json({ error: { code: "internal", message: "persist failed" } }, 500);
  }

  // Fan-out to live WS subscribers (best-effort — HTTP client already has 201).
  try {
    const id = c.env.CHAT_ROOM.idFromName(message.room);
    const stub = c.env.CHAT_ROOM.get(id);
    await stub.fetch(`https://do/relay`, {
      method: "POST",
      body: JSON.stringify(message),
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("DO relay failed", err);
  }

  return c.json({ message }, 201);
});

// =========================================================
// Billing routes (回合4 mock slice)
// =========================================================

// --- GET /api/billing/status --------------------------------------------
//
// Returns the caller's subscription + current-day usage. The frontend polls
// this on app load and after a checkout to drive the paywall UI. Cheapest
// path through the billing surface — one SELECT on subscriptions and one
// COUNT on messages (indexed).
//
app.get("/api/billing/status", async (c) => {
  const jwt = c.get("jwt");
  const sub = await getSubscription(c.env.DB, jwt.sub);
  if (!sub) {
    // Should not happen — register seeds the row. If it does, return a
    // synthetic free view rather than 500 so the UI keeps working.
    return c.json({
      subscription: {
        user_id: jwt.sub,
        status: "free" as const,
        plan: "free" as const,
        current_period_end: null,
        checkout_session_id: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      } satisfies Subscription,
      usage: { used: 0, limit: FREE_DAILY_LIMIT },
    });
  }
  const used = sub.status === "paid" ? 0 : await todayMessageCount(c.env.DB, jwt.sub);
  const limit = sub.status === "paid" ? null : FREE_DAILY_LIMIT;
  return c.json({ subscription: sub, usage: { used, limit } });
});

// --- POST /api/billing/checkout -----------------------------------------
//
// Mock Stripe checkout session creation. Returns a fake hosted URL that
// points back at our SPA; the SPA then POSTs to /api/billing/webhook with
// the signed payload to simulate "customer completed checkout".
//
//   500 → BILLING_WEBHOOK_SECRET not configured (same posture as JWT_SECRET)
//   200 → { session_id, url, user_id }
//
app.post("/api/billing/checkout", async (c) => {
  const jwt = c.get("jwt");
  if (!c.env.BILLING_WEBHOOK_SECRET) {
    console.error("BILLING_WEBHOOK_SECRET not configured");
    return c.json(
      { error: { code: "internal", message: "billing not configured" } },
      500
    );
  }
  // If the user has no row yet (legacy account from before 回合4), seed one
  // so openCheckout's UPDATE hits a row.
  const existing = await getSubscription(c.env.DB, jwt.sub);
  if (!existing) {
    await createFreeSubscription(c.env.DB, jwt.sub);
  }
  try {
    const { session_id, url } = await openCheckout(
      c.env.DB,
      c.env.BILLING_WEBHOOK_SECRET,
      jwt.sub
    );
    // Mint the signature the mock hosted page would carry to the webhook.
    // See CheckoutResponse docs for why this is safe in the mock.
    const signature = await signSession(
      c.env.BILLING_WEBHOOK_SECRET,
      session_id,
      jwt.sub
    );
    return c.json({ session_id, url, user_id: jwt.sub, signature });
  } catch (err) {
    console.error("checkout failed", err);
    return c.json({ error: { code: "internal", message: "checkout failed" } }, 500);
  }
});

// --- POST /api/billing/webhook ------------------------------------------
//
// Mock Stripe webhook. Authenticates by HMAC signature over
// `${session_id}.${user_id}` — only the server that holds
// BILLING_WEBHOOK_SECRET (and that issued the checkout) can produce a valid
// signature. Public route: no Bearer token, like real Stripe.
//
//   400 → missing fields
//   401 → signature mismatch / secret missing
//   404 → session_id not found on any row (someone fabricated a payload)
//   200 → { ok: true, subscription }
//
app.post("/api/billing/webhook", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "bad_request", message: "invalid json" } }, 400);
  }
  const { session_id, user_id, signature } = (body ?? {}) as {
    session_id?: unknown;
    user_id?: unknown;
    signature?: unknown;
  };
  if (
    typeof session_id !== "string" ||
    typeof user_id !== "string" ||
    typeof signature !== "string"
  ) {
    return c.json(
      { error: { code: "bad_request", message: "missing session_id/user_id/signature" } },
      400
    );
  }
  if (!c.env.BILLING_WEBHOOK_SECRET) {
    return c.json(
      { error: { code: "internal", message: "billing not configured" } },
      500
    );
  }

  const ok = await verifySession(
    c.env.BILLING_WEBHOOK_SECRET,
    session_id,
    user_id,
    signature
  );
  if (!ok) {
    return c.json(
      { error: { code: "unauthorized", message: "invalid signature" } },
      401
    );
  }

  // Correlate: the session_id must match what we recorded at checkout time.
  const sub = await getSubscription(c.env.DB, user_id);
  if (!sub || sub.checkout_session_id !== session_id) {
    return c.json(
      { error: { code: "not_found", message: "unknown checkout session" } },
      404
    );
  }

  const updated = await applyUpgrade(c.env.DB, user_id);
  return c.json({ ok: true, subscription: updated });
});

// --- WebSocket upgrade (unchanged from 回合2) -----------------------------
//
// NOTE: WS auth is explicitly out of scope for this slice (architecture-review
// Issue 4 — needs short-lived ticket). The room is the only routing key here.
//
app.get("/ws/:room", (c) => {
  const room = c.req.param("room")?.trim();
  if (!room) {
    return c.json({ error: { code: "bad_request", message: "missing room" } }, 400);
  }

  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.json(
      { error: { code: "bad_request", message: "expected websocket upgrade" } },
      426
    );
  }

  const id = c.env.CHAT_ROOM.idFromName(room);
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

// --- Static assets (React SPA) ------------------------------------------
app.all("*", (c) => {
  if (!c.env.ASSETS) {
    return c.text("Frontend assets not built. Run `npm run build:web` first.", 503);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

// --- Error handler -------------------------------------------------------
app.onError((err, c) => {
  console.error("unhandled", err);
  return c.json({ error: { code: "internal", message: "unexpected error" } }, 500);
});

export default app;
