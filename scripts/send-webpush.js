/* eslint-disable @typescript-eslint/no-require-imports */
// QA helper — send a REAL web-push message to a stored subscription.
// Same VAPID keys + encryption as the production worker; the endpoint host is
// switched to Google's FCM ingress because the sandbox egress breaks POST
// bodies to jmt17.google.com (hard 502). Production code never does this —
// it posts to the endpoint exactly as the browser registered it.
//
// Usage: node scripts/send-webpush.js '<json payload>'
// Reads the subscription from /tmp/push-sub.json.

const fs = require("fs");
const webpush = require("web-push");

// Keys live in the project .env (gitignored) — node subprocesses don't inherit
// the Next.js env, so read it directly.
function envKey(name) {
  if (process.env[name]) return process.env[name];
  const line = fs.readFileSync("/home/z/my-project/.env", "utf8")
    .split("\n")
    .find((l) => l.startsWith(name + "="));
  return line ? line.split("=").slice(1).join("=").trim() : undefined;
}

const PUBLIC_KEY = envKey("VAPID_PUBLIC_KEY");
const PRIVATE_KEY = envKey("VAPID_PRIVATE_KEY");
if (!PUBLIC_KEY || !PRIVATE_KEY) {
  console.error("VAPID keys missing in env");
  process.exit(2);
}
webpush.setVapidDetails("mailto:it@mohdhms.com", PUBLIC_KEY, PRIVATE_KEY);

const payload = process.argv[2] || JSON.stringify({ title: "test", body: "test", url: "/dashboard" });
const raw = JSON.parse(fs.readFileSync("/tmp/push-sub.json", "utf8"));

// Rewrite ONLY the ingress host; the token path (device identity) is untouched.
const u = new URL(raw.endpoint);
if (u.hostname.endsWith("google.com") && u.hostname !== "fcm.googleapis.com") {
  u.hostname = "fcm.googleapis.com";
}

(async () => {
  try {
    const res = await webpush.sendNotification(
      { endpoint: u.href, keys: raw.keys },
      payload,
      { TTL: 3600 }
    );
    console.log(`DELIVERED: HTTP ${res.statusCode} message-id=${res.headers.location || "?"}`);
    process.exit(0);
  } catch (e) {
    console.error(`SEND FAILED: statusCode=${e.statusCode} body=${String(e.body || "").slice(0, 200)}`);
    process.exit(1);
  }
})();
