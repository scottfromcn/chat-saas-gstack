// =========================================================
// Auth utilities — hashing + JWT (回合3 MVP slice)
//
//  Why PBKDF2 and not scrypt/bcrypt:
//    Workers Web Crypto exposes PBKDF2 natively (crypto.subtle.deriveBits).
//    bcrypt/scrypt need wasm or polyfills and would blow the 1MB bundle for
//    no real security gain at this wedge stage. PBKDF2-SHA256 @ 100k iters is
//    the OWASP-recommended floor.
//
//  Hash format (single string column — no separate salt column):
//    "pbkdf2$<iters>$<saltB64>$<hashB64>"
//
//  Token format:
//    JWT HS256 via hono/jwt. Payload: { sub, email, iat, exp }.
//    Lifetime: 7 days. Refresh tokens are out of scope for this slice.
//
//  Failure modes:
//    - JWT_SECRET missing → sign()/verify() throw, caller returns 500.
//    - tampered token → verify throws JwtTokenSignatureMismatched.
//    - expired token → verify throws JwtTokenExpired.
//    - both surface as 401 in the middleware.
// =========================================================

import { sign, verify } from "hono/jwt";
import type { JwtPayload } from "../../shared/types";

// Re-exported so callers can cast hono's loosely-typed verify result.
export type { JwtPayload };

const PBKDF2_ITERATIONS = 100_000;
const HASH_BITS = 256; // 32 bytes
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// --- Hashing ------------------------------------------------------------

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function hashPassword(password: string): Promise<string> {
  // 16-byte salt — cryptographically random, unique per password.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    HASH_BITS
  );
  // Stable textual format so the column is plain TEXT in D1.
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bufferToBase64(salt.buffer)}$${bufferToBase64(derived)}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = stored.split("$");
  // Malformed rows are treated as "wrong password" — never throw out of auth
  // path; throwing here would leak whether the hash format was wrong.
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iters = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(iters) || iters <= 0) return false;
  const saltBuf = base64ToBuffer(parts[2]);
  const expected = parts[3];

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new Uint8Array(saltBuf), iterations: iters, hash: "SHA-256" },
    keyMaterial,
    HASH_BITS
  );

  // Constant-time-ish comparison: we compare base64 strings char-by-char.
  // Not strictly constant time, but PBKDF2 is the slow part and online
  // attackers can't time this through the network jitter anyway.
  const actual = bufferToBase64(derived);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// --- JWT -----------------------------------------------------------------

export async function issueToken(
  user: { id: string; email: string },
  secret: string
): Promise<string> {
  if (!secret) throw new Error("JWT_SECRET not configured");
  const now = Math.floor(Date.now() / 1000);
  // hono/jwt's sign requires its own JWTPayload shape (extra index signature
  // + optional claims). We spread into a fresh object so TS is happy.
  const payload = {
    sub: user.id,
    email: user.email,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, "HS256");
}

export async function verifyToken(
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  if (!secret) return null;
  try {
    // hono/jwt throws on bad signature / expired / malformed; we swallow all
    // of them as "invalid → 401". The caller distinguishes nothing here.
    const payload = (await verify(token, secret, "HS256")) as Partial<JwtPayload>;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return payload as JwtPayload;
  } catch {
    return null;
  }
}

// --- Email validation ----------------------------------------------------
//
// Minimal-but-real email regex. Not RFC-perfect (RFC 5322 is a monster) but
// rejects the common junk: spaces, missing @, missing TLD. The UNIQUE
// constraint on D1 is the real guard against duplicate accounts; this regex
// only stops garbage at the door.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && EMAIL_RE.test(email) && email.length <= 320;
}

// 8..72 chars. < 8 is weak; > 72 is the bcrypt limit (we use PBKDF2 so we could
// accept more, but capping at 72 keeps a future migration to bcrypt trivial).
export function isValidPassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    password.length <= 72
  );
}
