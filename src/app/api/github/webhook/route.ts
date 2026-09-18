import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { spawn } from "child_process";
import { readFileSync } from "fs";

// MOHD.HMS ENTERPRISE — GitHub push webhook → auto-deploy.
// Receives the GitHub webhook through the tunnel (HTTPS), verifies the
// X-Hub-Signature-256 HMAC, and hands off to the deploy worker
// (/home/hasan/hms-deploy/deploy.sh). A failed deploy never takes the app
// down: the worker builds in a staging clone and restores the previous
// .next + restarts on any failure.

const SECRET_PATH = "/home/hasan/hms-deploy/secret";
const DEPLOY = "/home/hasan/hms-deploy/deploy.sh";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  const event = req.headers.get("x-github-event") ?? "";

  let secret: string;
  try {
    secret = readFileSync(SECRET_PATH, "utf8").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "deploy secret unavailable" }, { status: 500 });
  }

  const body = await req.text();
  const expect = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expect, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (!sig || a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: "bad signature" }, { status: 400 });
  }

  if (event !== "push") return NextResponse.json({ ok: true, ignored: "not a push" });

  let payload: { ref?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  if (payload.ref !== "refs/heads/main") {
    return NextResponse.json({ ok: true, ignored: "not refs/heads/main" });
  }

  spawn("/usr/bin/setsid", ["bash", DEPLOY], { detached: true, stdio: "ignore" }).unref();

  return NextResponse.json({ ok: true, deployed: true });
}