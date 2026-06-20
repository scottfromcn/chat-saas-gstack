import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type {
  ChatMessage,
  WsIncoming,
  WsOutgoing,
  AuthResponse,
  User,
  Subscription,
  CheckoutResponse,
  BillingStatusResponse,
} from "../../../shared/types";

// =========================================================
// Convoy frontend (回合4 billing slice)
//
// State machine (extends 回合3):
//
//   [unauthed]  ──register/login──>  [authed]
//                                       │
//                                       ├── GET /api/billing/status
//                                       ▼
//                                 [knows plan + usage]
//                                       │
//           ┌───────────────────────────┴───────────────────────────┐
//           ▼                                                           ▼
//   [free, under cap]                                            [free, cap reached]
//   POST /api/messages → 201                                   POST /api/messages → 402
//           │                                                           │
//           │                                                  paywall modal opens
//           │                                                           │
//           │                                                  user clicks "Upgrade"
//           │                                                           │
//           │                                                  POST /api/billing/checkout
//           │                                                           │
//           │                                                  (mock) auto-complete:
//           │                                                  POST /api/billing/webhook
//           │                                                  with signature from checkout
//           │                                                           │
//           │                                                  refresh status → paid
//           ▼                                                           ▼
//   [paid: unlimited] ◄────────────────────────────────────  cap no longer applies
//
// Mock flow note: real Stripe would redirect the user to a hosted page that
// POSTs the event to our webhook on success. In the mock, /billing/checkout
// returns the signature the hosted page would have carried, and the SPA
// replays it to /webhook immediately — same security shape, no external hop.
// =========================================================

const TOKEN_KEY = "convoy.token";
const USER_KEY = "convoy.user";

function readStoredAuth(): { token: string; user: User } | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    const u = localStorage.getItem(USER_KEY);
    if (!t || !u) return null;
    return { token: t, user: JSON.parse(u) as User };
  } catch {
    return null;
  }
}

function wsUrl(room: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws/${encodeURIComponent(room)}`;
}

// ---- Auth form -----------------------------------------------------------

const AuthForm: React.FC<{ onAuthed: (a: { token: string; user: User }) => void }> = ({
  onAuthed,
}) => {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Server envelope: { error: { code, message } }
        const msg = (data as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
        setError(msg);
        return;
      }
      const { token, user } = data as AuthResponse;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      onAuthed({ token, user });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={authStyles.shell}>
      <h2 style={authStyles.title}>{mode === "login" ? "Sign in" : "Create account"}</h2>
      <form style={authStyles.form} onSubmit={submit}>
        <input
          style={authStyles.input}
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          style={authStyles.input}
          type="password"
          placeholder="password (8-72 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={8}
          maxLength={72}
        />
        <button style={authStyles.button} type="submit" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Register"}
        </button>
        {error && <div style={authStyles.error}>{error}</div>}
      </form>
      <button style={authStyles.switch} onClick={() => setMode(mode === "login" ? "register" : "login")}>
        {mode === "login" ? "No account? Register" : "Already have an account? Sign in"}
      </button>
    </div>
  );
};

// ---- Chat (authed) -------------------------------------------------------

const Chat: React.FC<{
  auth: { token: string; user: User };
  onLogout: () => void;
}> = ({ auth, onLogout }) => {
  const [room, setRoom] = useState<string>("general");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [connState, setConnState] = useState<"connecting" | "open" | "closed">("connecting");
  const [authError, setAuthError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Billing state (回合4). Null = not loaded yet. Kept separate from messages
  // so a quota refresh after upgrade doesn't re-trigger the WS reconnect effect.
  const [billing, setBilling] = useState<BillingStatusResponse | null>(null);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const fetchHistory = useCallback(
    async (targetRoom: string): Promise<ChatMessage[]> => {
      const res = await fetch(`/api/messages?room=${encodeURIComponent(targetRoom)}`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (res.status === 401) {
        // Token expired or revoked — force re-login.
        setAuthError("session expired");
        onLogout();
        throw new Error("401");
      }
      if (!res.ok) throw new Error(`history failed: ${res.status}`);
      const data = (await res.json()) as { messages: ChatMessage[] };
      return data.messages;
    },
    [auth.token, onLogout]
  );

  // Pull subscription + usage once on mount, and after every successful send
  // so the badge stays accurate. Cheap (1 SELECT + 1 COUNT) — fine to do per
  // message at MVP volume. We deliberately do NOT poll on a timer: an upgrade
  // in another tab will be observed on next send / next manual refresh.
  const refreshBilling = useCallback(async () => {
    try {
      const res = await fetch(`/api/billing/status`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (res.ok) {
        setBilling((await res.json()) as BillingStatusResponse);
      }
    } catch (err) {
      // Non-fatal: if billing status fails to load we just don't show the
      // badge. The quota check still happens server-side on POST.
      console.error("billing status", err);
    }
  }, [auth.token]);

  useEffect(() => {
    refreshBilling();
  }, [refreshBilling]);

  const handleIncoming = useCallback((frame: WsOutgoing) => {
    if (frame.type === "message") {
      setMessages((prev) => {
        if (prev.some((m) => m.id === frame.message.id)) return prev;
        return [...prev, frame.message];
      });
    }
  }, []);

  useEffect(() => {
    let closed = false;
    setConnState("connecting");
    const ws = new WebSocket(wsUrl(room));
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      if (!closed) setConnState("open");
    });
    ws.addEventListener("message", (ev) => {
      try {
        handleIncoming(JSON.parse(ev.data) as WsOutgoing);
      } catch (err) {
        console.error("bad ws frame", err);
      }
    });
    ws.addEventListener("close", () => {
      if (!closed) setConnState("closed");
    });
    ws.addEventListener("error", () => {
      if (!closed) setConnState("closed");
    });

    fetchHistory(room)
      .then((msgs) => {
        if (!closed) setMessages(msgs);
      })
      .catch((err) => console.error("history", err));

    return () => {
      closed = true;
      ws.close();
    };
  }, [room, handleIncoming, fetchHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // POST via REST (not WS) so the server-side quota check actually runs.
  // 回合2/3 sent via WS to demo live broadcast; 回合4 routes the user-facing
  // send through REST because WS has no auth/quota yet (architecture-review
  // Issue 4). The server still fans out to live WS subscribers via the DO
  // relay, so other tabs see the message in real time.
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setUpgradeError(null);
    const res = await fetch(`/api/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ room, text }),
    });
    if (res.status === 402) {
      // Free limit hit — surface the paywall. Refresh billing first so the
      // modal shows the real "12/50" instead of a stale count.
      await refreshBilling();
      setPaywallOpen(true);
      return;
    }
    if (res.status === 401) {
      setAuthError("session expired");
      onLogout();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = (data as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`;
      setUpgradeError(msg);
      return;
    }
    setDraft("");
    // Keep the badge current — fire-and-forget; failure just means a stale
    // number until the next send.
    void refreshBilling();
  }, [draft, room, auth.token, onLogout, refreshBilling]);

  // Mock checkout → webhook → refresh. In real Stripe this is split across
  // a hosted page and a server-side webhook receiver; the mock collapses it
  // into one click because /checkout returns the signature the hosted page
  // would carry. We never touch BILLING_WEBHOOK_SECRET on the client.
  const upgrade = useCallback(async () => {
    setUpgrading(true);
    setUpgradeError(null);
    try {
      const coRes = await fetch(`/api/billing/checkout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (!coRes.ok) throw new Error(`checkout failed: ${coRes.status}`);
      const co = (await coRes.json()) as CheckoutResponse;

      // "Customer completed checkout" → replay the signed event.
      const whRes = await fetch(`/api/billing/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: co.session_id,
          user_id: co.user_id,
          signature: co.signature,
        }),
      });
      if (!whRes.ok) {
        const data = await whRes.json().catch(() => ({}));
        const msg = (data as { error?: { message?: string } }).error?.message ?? `webhook ${whRes.status}`;
        throw new Error(msg);
      }
      await refreshBilling();
      setPaywallOpen(false);
    } catch (err) {
      setUpgradeError((err as Error).message);
    } finally {
      setUpgrading(false);
    }
  }, [auth.token, refreshBilling]);

  const plan = billing?.subscription.status ?? "free";
  const usageText =
    billing == null
      ? ""
      : billing.usage.limit == null
      ? "Pro · unlimited"
      : `Free · ${billing.usage.used}/${billing.usage.limit} today`;

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <strong>Convoy</strong>
        <span style={styles.muted}>— {auth.user.email}</span>
        <span
          style={
            plan === "paid" ? { ...styles.badge, ...styles.badgePaid } : styles.badge
          }
        >
          {usageText || "…"}
        </span>
        {plan === "free" && (
          <button style={styles.upgradeBtn} onClick={() => setPaywallOpen(true)}>
            Upgrade
          </button>
        )}
        <button style={styles.logout} onClick={onLogout}>Sign out</button>
      </header>

      <div style={styles.bar}>
        <label style={styles.label}>
          room&nbsp;
          <input
            style={styles.input}
            value={room}
            onChange={(e) => setRoom(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
          />
        </label>
        <span style={{ ...styles.muted, marginLeft: "auto" }}>ws: {connState}</span>
      </div>

      <div style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.empty}>No messages yet — say hi.</div>
        )}
        {messages.map((m) => (
          <div key={m.id} style={styles.row}>
            <span style={styles.user}>{m.user}</span>
            <span style={styles.time}>{new Date(m.created_at).toLocaleTimeString()}</span>
            <div style={styles.text}>{m.text}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        style={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          style={styles.textinput}
          placeholder={`Message #${room}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
        />
        <button style={styles.button} type="submit">
          Send
        </button>
      </form>
      {authError && <div style={styles.error}>{authError}</div>}
      {upgradeError && !paywallOpen && (
        <div style={styles.error}>{upgradeError}</div>
      )}

      {paywallOpen && (
        <PaywallModal
          billing={billing}
          upgrading={upgrading}
          error={upgradeError}
          onUpgrade={upgrade}
          onClose={() => setPaywallOpen(false)}
        />
      )}
    </div>
  );
};

// ---- Paywall modal -------------------------------------------------------

const PaywallModal: React.FC<{
  billing: BillingStatusResponse | null;
  upgrading: boolean;
  error: string | null;
  onUpgrade: () => void;
  onClose: () => void;
}> = ({ billing, upgrading, error, onUpgrade, onClose }) => {
  const used = billing?.usage.used ?? 0;
  const limit = billing?.usage.limit;
  return (
    <div style={modalStyles.overlay} onClick={onClose}>
      <div style={modalStyles.card} onClick={(e) => e.stopPropagation()}>
        <h3 style={modalStyles.title}>You've hit the free plan limit</h3>
        <p style={modalStyles.body}>
          {limit == null
            ? "You're on Pro — messaging is unlimited."
            : `You've sent ${used} of ${limit} messages today. Upgrade to Pro for unlimited messaging.`}
        </p>
        <ul style={modalStyles.list}>
          <li>Unlimited messages</li>
          <li>Unlimited rooms</li>
          <li>$0 in this mock — no real card charged</li>
        </ul>
        <div style={modalStyles.actions}>
          <button
            style={modalStyles.cta}
            onClick={onUpgrade}
            disabled={upgrading}
          >
            {upgrading ? "Processing…" : "Upgrade to Pro"}
          </button>
          <button style={modalStyles.dismiss} onClick={onClose} disabled={upgrading}>
            Maybe later
          </button>
        </div>
        {error && <div style={modalStyles.error}>{error}</div>}
        <p style={modalStyles.note}>
          Mock Stripe checkout — no real payment. Clicking upgrade runs the
          full checkout → webhook → refresh loop locally.
        </p>
      </div>
    </div>
  );
};

// ---- Root ----------------------------------------------------------------

const App: React.FC = () => {
  const [auth, setAuth] = useState<{ token: string; user: User } | null>(() =>
    readStoredAuth()
  );

  const handleLogout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setAuth(null);
  }, []);

  if (!auth) return <AuthForm onAuthed={setAuth} />;
  return <Chat auth={auth} onLogout={handleLogout} />;
};

// ---- Styles --------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    maxWidth: 720,
    margin: "0 auto",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#1f2328",
  },
  header: { display: "flex", gap: 8, alignItems: "center", padding: "12px 0", borderBottom: "1px solid #e5e7eb" },
  bar: {
    display: "flex",
    gap: 16,
    alignItems: "center",
    padding: "8px 0",
    borderBottom: "1px solid #e5e7eb",
  },
  label: { fontSize: 13, display: "flex", alignItems: "center" },
  input: { border: "1px solid #d0d7de", borderRadius: 4, padding: "4px 6px", fontSize: 13, width: 120 },
  muted: { color: "#6b7280", fontSize: 13 },
  messages: { flex: 1, overflowY: "auto", padding: "12px 0" },
  empty: { color: "#9ca3af", padding: 16, fontSize: 14 },
  row: { padding: "6px 0", borderBottom: "1px solid #f3f4f6" },
  user: { fontWeight: 600, marginRight: 8 },
  time: { color: "#9ca3af", fontSize: 12 },
  text: { marginTop: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  form: { display: "flex", gap: 8, padding: "12px 0", borderTop: "1px solid #e5e7eb" },
  textinput: { flex: 1, border: "1px solid #d0d7de", borderRadius: 4, padding: "8px 10px", fontSize: 14 },
  button: { background: "#1f6feb", color: "white", border: "none", borderRadius: 4, padding: "8px 16px", cursor: "pointer" },
  logout: { marginLeft: "auto", background: "transparent", border: "1px solid #d0d7de", borderRadius: 4, padding: "4px 10px", cursor: "pointer", fontSize: 13 },
  error: { color: "#dc2626", fontSize: 13, padding: "8px 0" },
  // Plan badge in the header. Grey on free, green on paid — the same visual
  // language most SaaS apps settle on, so the wedge demo reads instantly.
  badge: {
    fontSize: 12,
    padding: "2px 8px",
    borderRadius: 10,
    background: "#f3f4f6",
    color: "#6b7280",
    border: "1px solid #e5e7eb",
  },
  badgePaid: {
    background: "#ecfdf5",
    color: "#047857",
    borderColor: "#a7f3d0",
  },
  upgradeBtn: {
    marginLeft: 4,
    background: "#7c3aed",
    color: "white",
    border: "none",
    borderRadius: 4,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
  },
};

const modalStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(15, 23, 42, 0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
  },
  card: {
    background: "white",
    borderRadius: 8,
    padding: 24,
    maxWidth: 420,
    width: "calc(100% - 32px)",
    fontFamily: "system-ui, sans-serif",
    boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
  },
  title: { margin: 0, fontSize: 18, marginBottom: 8 },
  body: { marginTop: 0, marginBottom: 12, fontSize: 14, color: "#374151", lineHeight: 1.5 },
  list: { fontSize: 14, color: "#374151", margin: "0 0 16px 0", paddingLeft: 20, lineHeight: 1.7 },
  actions: { display: "flex", gap: 8, marginBottom: 12 },
  cta: {
    background: "#7c3aed",
    color: "white",
    border: "none",
    borderRadius: 4,
    padding: "10px 16px",
    cursor: "pointer",
    fontSize: 14,
    flex: 1,
  },
  dismiss: {
    background: "transparent",
    color: "#6b7280",
    border: "1px solid #d0d7de",
    borderRadius: 4,
    padding: "10px 12px",
    cursor: "pointer",
    fontSize: 14,
  },
  error: { color: "#dc2626", fontSize: 13, marginTop: 8 },
  note: { fontSize: 12, color: "#9ca3af", margin: "8px 0 0 0", lineHeight: 1.4 },
};

const authStyles: Record<string, React.CSSProperties> = {
  shell: { maxWidth: 360, margin: "80px auto", fontFamily: "system-ui, sans-serif", color: "#1f2328" },
  title: { fontSize: 18, marginBottom: 12 },
  form: { display: "flex", flexDirection: "column", gap: 8 },
  input: { border: "1px solid #d0d7de", borderRadius: 4, padding: "8px 10px", fontSize: 14 },
  button: { background: "#1f6feb", color: "white", border: "none", borderRadius: 4, padding: "10px", fontSize: 14, cursor: "pointer" },
  switch: { marginTop: 12, background: "transparent", border: "none", color: "#1f6feb", cursor: "pointer", fontSize: 13 },
  error: { color: "#dc2626", fontSize: 13, marginTop: 8 },
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
