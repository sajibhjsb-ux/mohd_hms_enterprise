import assert from "node:assert/strict";
import { sanitizeAppPath } from "./deep-link";

assert.equal(sanitizeAppPath("/complaints/c1"), "/complaints/c1");
assert.equal(sanitizeAppPath("/complaints/c1?tab=media"), "/complaints/c1?tab=media");
assert.equal(sanitizeAppPath("https://app.mohdhms.com/work-orders/wo1?tab=before"), "/work-orders/wo1?tab=before");
assert.equal(sanitizeAppPath("facilitypro://open/irms/abc"), "/irms/abc");
assert.equal(sanitizeAppPath("/complaints/c1#fragment"), "/complaints/c1");

for (const bad of [
  "",
  "   ",
  "/",
  "complaints/c1",
  "//evil.example/x",
  "/api/v1/auth/session",
  "/_next/static/chunk.js",
  "/socket.io/",
  "/verify/abc",
  "javascript:alert(1)",
  "data:text/html,x",
  "file:///etc/passwd",
  "https://evil.example/complaints/c1",
  "http://app.mohdhms.com/complaints/c1",
  "facilitypro://evil/complaints/c1",
  "/%2F%2Fevil",
  `/complaints/${"a".repeat(2100)}`,
]) {
  assert.equal(sanitizeAppPath(bad), null, `should reject: ${bad.slice(0, 40)}`);
}

console.log("native-deep-link: ok");
