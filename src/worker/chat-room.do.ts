// =========================================================
// ChatRoom Durable Object
//
//  State machine (Hibernation API):
//
//    [idle / hibernating]  ──acceptWebSocket──>  [active]
//            ▲                                       │
//            │                                       ├── webSocketClose (last socket)
//            │                                       ▼
//            └──────── webSocketMessage wakes DO ────┘
//
//  Persistence model (architecture-review.md Issue 5 / EUREKA):
//    incoming WS message → write D1 (strong, recoverable) → broadcast to all sockets.
//    DO storage holds no message buffer; D1 is the single source of truth.
//    In-memory cost = 0 per hibernated DO, message durability = D1 durability.
//
//  Per-socket broadcast safety (architecture-review.md failure modes — critical gap):
//    each ws.send() is wrapped in try/catch so one dead socket cannot break
//    delivery to the others.
// =========================================================

import { DurableObject } from "cloudflare:workers";
import type { WsIncoming, WsOutgoing, ChatMessage, Env } from "../../shared/types";
import { MAX_MESSAGE_TEXT } from "../../shared/types";

export type { Env };

export class ChatRoom extends DurableObject<Env> {
  // HTTP entrypoint used for two purposes:
  //   1. WS upgrade — Workers forwards the upgrade request here; we create the
  //      pair, accept the server side with Hibernation API, and return 101.
  //   2. Relay — POST /relay from the HTTP /api/messages route so a message
  //      written via REST also fans out to live WS subscribers.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const server = pair[1];

      // Room is encoded in the DO id name (Worker uses idFromName(room)), so we
      // read it back here to tag the socket and use it when persisting.
      const room =
        (this.ctx.id as unknown as { name?: string }).name ??
        url.pathname.replace(/^\/(ws|room)\//, "").replace(/\/.+$/, "");

      server.serializeAttachment({ room });

      // Hibernation API: state owns the socket set; we keep nothing in memory.
      this.ctx.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (request.method === "POST" && url.pathname === "/relay") {
      let message: ChatMessage;
      try {
        message = (await request.json()) as ChatMessage;
      } catch {
        return new Response("bad json", { status: 400 });
      }

      // Broadcast only — the HTTP route already persisted to D1.
      const payload = JSON.stringify({
        type: "message",
        message,
      } satisfies WsOutgoing);
      for (const peer of this.ctx.getWebSockets()) {
        try {
          peer.send(payload);
        } catch {
          // ignore dead socket
        }
      }
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  // New WS frame arrives from a client.
  async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string): Promise<void> {
    const room = (ws.deserializeAttachment() as { room?: string } | undefined)?.room;
    if (!room) {
      ws.close(1011, "missing room attachment");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    } catch {
      ws.close(1003, "invalid json");
      return;
    }

    const incoming = parsed as Partial<WsIncoming>;
    if (
      incoming.type !== "message" ||
      typeof incoming.user !== "string" ||
      typeof incoming.text !== "string" ||
      incoming.user.trim().length === 0 ||
      incoming.text.length === 0 ||
      incoming.text.length > MAX_MESSAGE_TEXT
    ) {
      ws.close(1003, "invalid payload");
      return;
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      room,
      user: incoming.user.slice(0, 64),
      text: incoming.text,
      created_at: Date.now(),
    };

    // Persist-then-broadcast: write D1 first. If the write fails we do NOT
    // broadcast — losing a message is a data-integrity incident for a paid
    // chat product, while a 30ms write latency is invisible to the user.
    try {
      await this.env.DB.prepare(
        `INSERT INTO messages (id, room, "user", text, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(message.id, message.room, message.user, message.text, message.created_at)
        .run();
    } catch (err) {
      console.error("D1 insert failed", err);
      ws.send(
        JSON.stringify({ type: "error", message: "failed to persist" } satisfies {
          type: "error";
          message: string;
        })
      );
      return;
    }

    // Broadcast to every connected socket in this DO (= this room).
    const frame: WsOutgoing = { type: "message", message };
    const payload = JSON.stringify(frame);
    for (const peer of this.ctx.getWebSockets()) {
      try {
        peer.send(payload);
      } catch {
        // Per-socket safety: ignore a dead socket; it will be cleaned up by
        // webSocketClose. Other peers still get the message.
      }
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Hibernation API: nothing to clean manually. Once the last socket is gone
    // the DO will be evicted and its state discarded. We keep no in-memory set.
    console.debug("ws closed", { code, reason, wasClean });
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("ws error", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      // socket may already be dead
    }
  }
}
