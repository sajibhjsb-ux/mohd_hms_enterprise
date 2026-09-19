// Realtime E2E scripted socket test (bun).
// Usage: bun scripts/rt-test.ts "hms_session=<token>" [auth|event]
import { io } from "socket.io-client";

const cookie = process.argv[2] ?? "";
const mode = process.argv[3] ?? "event";

const socket = io("http://127.0.0.1:3003", {
  path: "/",
  transports: ["websocket", "polling"],
  extraHeaders: cookie ? { cookie } : {},
  reconnection: false,
  timeout: 8000,
});

socket.on("connect", () => {
  console.log(JSON.stringify({ ok: true, phase: "connected", socketId: socket.id }));
  if (mode === "auth") process.exit(0);
});

socket.on("connect_error", (err) => {
  console.log(JSON.stringify({ ok: false, phase: "connect_error", message: err.message }));
  process.exit(1);
});

socket.on("realtime:event", (ev: unknown) => {
  console.log(JSON.stringify({ ok: true, phase: "event", event: ev }));
  process.exit(0);
});

setTimeout(() => {
  console.log(JSON.stringify({ ok: false, phase: "timeout", mode }));
  process.exit(2);
}, mode === "auth" ? 8000 : 20000);
