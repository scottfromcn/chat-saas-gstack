// Shared types between Worker backend and React frontend.
// 回合3: extended with auth types (User, AuthApi, JWT_SECRET env).
// 回合4: extended with billing types (Subscription, Plan, mock checkout/webhook).

// Cloudflare Env shape, shared by Worker + DO. The ASSETS binding type comes
// from the wrangler config; we type it loosely as Fetcher to avoid generating
// a worker-configuration.d.ts for this slice.
// JWT_SECRET is loaded from .dev.vars (dev) / wrangler secret (prod). Empty
// string means "not configured" — auth routes will 500 in that case.
// BILLING_WEBHOOK_SECRET signs the mock checkout→webhook handoff. Real Stripe
// would sign the webhook with the Stripe webhook signing secret; the mock
// uses an HMAC-SHA256 of {session_id}.{user_id} so the flow is exercisable
// end-to-end without external dependencies.
export interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  BILLING_WEBHOOK_SECRET: string;
}

// Authenticated user, server-authoritative. The frontend never sees
// password_hash.
export interface User {
  id: string;
  email: string;
  created_at: number;
}

// JWT payload — minimal: just the user id + iat/exp (hono/jwt fills iat/exp).
export interface JwtPayload {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
}

// --- Auth API contracts (shared by curl tests + frontend) ---
//
// POST /api/auth/register {email,password} → 201 {token, user}
// POST /api/auth/login    {email,password} → 200 {token, user}
// All return the same envelope so the frontend handles one shape.

export interface AuthResponse {
  token: string;
  user: User;
}

// --- Billing types (回合4 mock slice) ---
//
// Entitlement model: free vs pro. The Subscription row records the current
// state; the worker reads it on every message post to enforce the quota.
//
//   free → capped at FREE_DAILY_LIMIT messages per UTC day, single implicit
//          quota (no separate "rooms" limit in the MVP — the per-day message
//          count is the cleanest single lever and avoids a second counter).
//   pro  → unlimited, current_period_end is when the mock subscription
//          "renews" (real Stripe would emit renewal webhooks; mock just
//          sets +30d at checkout).
export type PlanStatus = "free" | "paid";
export type PlanCode = "free" | "pro";

export interface Subscription {
  user_id: string;
  status: PlanStatus;
  plan: PlanCode;
  current_period_end: number | null; // ms since epoch; null on free tier
  // checkout_session_id is set when a mock checkout is opened and cleared on
  // upgrade; exposed on the type because the webhook correlates by it.
  // The frontend never needs to render it, but it rides along in /status.
  checkout_session_id: string | null;
  created_at: number;
  updated_at: number;
}

// Free-tier daily message cap (UTC day). Picked as "enough to try the product,
// hits fast enough in a manual test to demonstrate the wall". Tunable.
export const FREE_DAILY_LIMIT = 50;

// Pro plan period (mock): 30 days from checkout. Real Stripe subscription
// interval lives on the price object; we hard-code here to keep the mock
// dependency-free.
export const MOCK_PRO_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// --- Billing API contracts ---
//
// GET  /api/billing/status [auth]                → 200 { subscription, usage: { used, limit } }
// POST /api/billing/checkout [auth]              → 200 { session_id, url, user_id, signature }
//        - creates/refreshes a checkout_session_id on the row
//        - url is a fake "Stripe-hosted" URL pointing back at our own
//          /billing/return page; the frontend "completes checkout" by hitting
//          the webhook with the signed payload
//        - signature is the HMAC the server would normally hand to the hosted
//          checkout page. The mock returns it here so the SPA can replay it
//          to /webhook — this is safe because checkout is itself an authed
//          server route, so only an authenticated owner can mint a signature
//          for their own user_id. A forged signature for someone else's
//          session still fails at the webhook's row-correlation check.
// POST /api/billing/webhook { session_id, user_id, signature }
//        - mock verifies signature = HMAC-SHA256(secret, `${session_id}.${user_id}`)
//        - on success: status='paid', plan='pro', current_period_end=now+30d
//        - returns 200 { ok: true } (matches Stripe's expected 2xx ack)

export interface CheckoutResponse {
  session_id: string;
  url: string;
  user_id: string;
  signature: string;
}

export interface BillingStatusResponse {
  subscription: Subscription;
  usage: { used: number; limit: number | null }; // limit null = unlimited
}

export interface ChatMessage {
  id: string;
  room: string;
  user: string;
  text: string;
  created_at: number; // ms since epoch
}

// Wire format for a WS frame sent by the server.
export interface WsOutgoing {
  type: "message";
  message: ChatMessage;
}

// Wire format for a WS frame sent by the client to post a message.
export interface WsIncoming {
  type: "message";
  user: string;
  text: string;
}

export const MAX_MESSAGE_TEXT = 4096;
