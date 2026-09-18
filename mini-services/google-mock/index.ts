// MOHD.HMS ENTERPRISE — local Google OAuth testing double (dev/QA only).
// Implements just enough of Google's OIDC surface for the app's
// GOOGLE_*_ENDPOINT overrides (see src/lib/hms/google-auth.ts):
//
//   GET  /auth      → 302 straight back to redirect_uri with ?code&state
//   POST /token     → { access_token } carrying the current mock identity
//   GET  /userinfo  → verified Google-style identity from the Bearer token
//   POST /mock/user → set the current mock identity { email, name? } (control)
//   GET  /mock/user → inspect the current identity / health
//
// The `sub` is deterministic per email, so repeat sign-ins exercise the
// googleId lookup path exactly like the real provider.

type MockIdentity = { email: string; name: string; sub: string };

const current: MockIdentity = {
  email: "qa.google.new@gmail.com",
  name: "QA Google New",
  sub: "",
};

function subFor(email: string): string {
  // Stable pseudo-sub derived from the verified email (deterministic, unique).
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `mock-sub-${h.toString(16).padStart(8, "0")}`;
}

function identity(): MockIdentity {
  return { ...current, sub: current.sub || subFor(current.email) };
}

const server = Bun.serve({
  port: 3040,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({ ok: true, who: identity() });
    }

    // Control endpoint: choose the identity the next sign-in will present.
    if (path === "/mock/user" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { email?: string; name?: string };
      if (!body.email || !body.email.includes("@")) {
        return Response.json({ ok: false, error: "email required" }, { status: 400 });
      }
      current.email = body.email.toLowerCase().trim();
      current.name = (body.name ?? current.email.split("@")[0]).trim();
      current.sub = subFor(current.email);
      return Response.json({ ok: true, who: identity() });
    }
    if (path === "/mock/user" && req.method === "GET") {
      return Response.json({ ok: true, who: identity() });
    }

    // Authorization endpoint: consent is auto-approved, redirect immediately.
    if (path === "/auth") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (!redirectUri) return new Response("missing redirect_uri", { status: 400 });
      const target = new URL(redirectUri);
      target.searchParams.set("code", `mock-code-${Date.now()}`);
      target.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    }

    // Token endpoint: exchange any code for a token carrying the identity.
    if (path === "/token" && req.method === "POST") {
      const form = await req.formData().catch(() => null);
      if (!form || !form.get("code")) return Response.json({ error: "invalid_request" }, { status: 400 });
      const payload = Buffer.from(JSON.stringify(identity())).toString("base64url");
      return Response.json({
        access_token: `at-${payload}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    // Userinfo endpoint: decode the Bearer token back into the identity.
    if (path === "/userinfo") {
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token.startsWith("at-")) return Response.json({ error: "invalid_token" }, { status: 401 });
      try {
        const who = JSON.parse(Buffer.from(token.slice(3), "base64url").toString("utf8")) as MockIdentity;
        return Response.json({
          sub: who.sub,
          email: who.email,
          email_verified: true,
          name: who.name,
          picture: null,
        });
      } catch {
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`google-mock listening on http://localhost:${server.port}`);
