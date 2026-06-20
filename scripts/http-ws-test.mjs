// Mixed-path test: a WS subscriber receives a message posted via HTTP POST.
// Validates the /relay DO fetch path used by POST /api/messages.
//
// Usage: node scripts/http-ws-test.mjs [http-origin] [ws-origin]

const http = process.argv[2] || "http://localhost:8788";
const ws = process.argv[3] || "ws://localhost:8788";
const room = "mixed-" + Date.now();

const sock = new WebSocket(`${ws}/ws/${room}`);
const received = [];
sock.onopen = () => console.log("[sub] open");
sock.onmessage = (e) => {
  received.push(e.data);
  console.log("[sub] recv:", e.data);
};

await new Promise((r) => setTimeout(r, 400));

console.log("--- POST message via HTTP ---");
const res = await fetch(`${http}/api/messages`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ room, user: "carol", text: "via-http" }),
});
console.log("HTTP status:", res.status);
const body = await res.json();
console.log("HTTP body:", JSON.stringify(body));

await new Promise((r) => setTimeout(r, 600));

sock.close();

let ok = true;
if (received.length !== 1) {
  console.error(`FAIL: expected 1 ws frame, got ${received.length}`);
  ok = false;
} else {
  const f = JSON.parse(received[0]);
  if (f.type !== "message" || f.message.text !== "via-http" || f.message.user !== "carol") {
    console.error("FAIL: frame mismatch", f);
    ok = false;
  } else {
    console.log("PASS: WS subscriber received HTTP-posted message");
  }
}

console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
