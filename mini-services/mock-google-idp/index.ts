// Mock Google IdP — LOCAL TESTING DOUBLE ONLY.
// Lets the sandbox verify the full OAuth round-trip without real Google
// credentials. Never point a production deployment at this service.
//
// Endpoints:
//   GET  /auth    — consent screen stand-in: 302s back to redirect_uri with
//                   ?code=mock-<b64(email)>&state=<echo>. Identity chosen via
//                   the login_hint param (default: admin@mohdhms.com).
//   POST /token   — validates the mock code (form-encoded), returns an access
//                   token encoding the identity.
//   GET  /userinfo — decodes the Bearer token into an OpenID Connect-style
//                   profile {sub, email, email_verified, name, picture}.
//
// Run: bun run dev  (port 3060, auto-restart via --hot)

const PORT = 3060;

const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const dec = (s: string) => {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return "";
  }
};

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/auth") {
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (!redirect) return new Response("missing redirect_uri", { status: 400 });
      const email = (url.searchParams.get("login_hint") ?? "admin@mohdhms.com").trim().toLowerCase();
      const target = new URL(redirect);
      target.searchParams.set("code", `mock-${enc(email)}`);
      target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    }

    if (url.pathname === "/token") {
      const form = await req.formData().catch(() => null);
      const code = String(form?.get("code") ?? "");
      if (!form || form.get("grant_type") !== "authorization_code" || !code.startsWith("mock-")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: `mockat-${code.slice(5)}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
      });
    }

    if (url.pathname === "/userinfo") {
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer mockat-") ? auth.slice("Bearer mockat-".length) : "";
      const email = dec(token);
      if (!email || !email.includes("@")) {
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }
      return Response.json({
        sub: `mock-sub-${email.replace(/[^a-z0-9]+/g, "-")}`,
        email,
        email_verified: true,
        name: email === "admin@mohdhms.com" ? "Admin (Google)" : `Google User (${email})`,
        picture: "",
      });
    }

    return new Response("mock-google-idp: /auth /token /userinfo", { status: 404 });
  },
});

console.log(`mock-google-idp listening on http://127.0.0.1:${PORT}`);
