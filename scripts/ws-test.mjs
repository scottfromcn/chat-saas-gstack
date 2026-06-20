// Manual WS verification: open two clients in the same room, alice sends a
// message, bob should receive the broadcast. Also verify alice receives her
// own echo. Prints structured results to stdout for the report.
//
// Usage: node scripts/ws-test.mjs [url-prefix]
//   default url-prefix: ws://localhost:8787

const prefix = process.argv[2] || "ws://localhost:8788";
const room = "ws-test-" + Date.now();

function open(name) {
  const ws = new WebSocket(`${prefix}/ws/${room}`);
  const received = [];
  ws.onopen = () => console.log(`[${name}] open`);
  ws.onclose = (e) => console.log(`[${name}] close`, e.code, e.reason);
  ws.onerror = (e) => console.log(`[${name}] error`, e.message ?? e);
  ws.onmessage = (e) => {
    received.push(e.data);
    console.log(`[${name}] recv: ${e.data}`);
  };
  return { ws, received };
}

const alice = open("alice");
const bob = open("bob");

// Wait for both opens, then alice sends.
await new Promise((r) => setTimeout(r, 500));

console.log(`--- alice sends "ping" ---`);
alice.ws.send(JSON.stringify({ type: "message", user: "alice", text: "ping" }));

// Give the broadcast time to round-trip.
await new Promise((r) => setTimeout(r, 800));

console.log("--- summary ---");
console.log("alice received:", alice.received.length);
console.log("bob   received:", bob.received.length);

let ok = true;
if (alice.received.length !== 1) {
  console.error("FAIL: alice should have received exactly 1 broadcast");
  ok = false;
}
if (bob.received.length !== 1) {
  console.error("FAIL: bob should have received exactly 1 broadcast");
  ok = false;
}
for (const r of [...alice.received, ...bob.received]) {
  const f = JSON.parse(r);
  if (f.type !== "message" || f.message.text !== "ping" || f.message.user !== "alice") {
    console.error("FAIL: unexpected frame", f);
    ok = false;
  }
}

alice.ws.close();
bob.ws.close();

console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
