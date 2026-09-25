import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Realtime transport rides the app's single production origin: the
  // standalone proxies BOTH engine.io HTTP polling and the WebSocket upgrade
  // (upgradeHandler → proxyRequest → proxy.ws) to the external realtime
  // service. Replaces the Caddy-only `?XTransformPort=3003` query transform,
  // which production's TCP router never applied (see worklog STEP 29/30).
  async rewrites() {
    return [
      {
        source: "/socket.io/:path*",
        // Strip the `/socket.io` prefix: the realtime service's socket.io server
        // mounts at ROOT (path: "/", NOT "/socket.io" — see realtime-service
        // index.ts:253-255), so engine.io traffic must land on `/?EIO=...`.
        destination: "http://127.0.0.1:3003/:path*",
      },
    ];
  },
  // Pin Turbopack's root to this project so stray lockfiles in parent dirs
  // (e.g. /home/hasan/package-lock.json) can never hijack the build — otherwise
  // the standalone server.js lands nested under .next/standalone/<rel-app>/
  // instead of .next/standalone/server.js and release slots cannot start.
  turbopack: { root: process.cwd() },
  experimental: {
    // Dev-box stability: Turbopack's default budget (8 GB) lets the dev server
    // RSS balloon past 2.4 GB on the 4 GB sandbox and get OOM-killed (14+ kills
    // on 2026-09-23, each taking the app AND the realtime dashboard down with
    // it). A 1.2 GB budget makes Turbopack GC aggressively instead. Production
    // standalone builds are unaffected (this only applies to `next dev`).
    turbopackMemoryLimit: 1_200_000_000,
  },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Keep crypto-dependent server packages OUT of the bundler: web-push signs
  // VAPID JWTs with node:crypto internals and firebase-admin loads its
  // credentials dynamically — bundling them breaks request signing/auth
  // (push deliveries failed with 401 when Turbopack rewrote the modules).
  serverExternalPackages: ["web-push", "firebase-admin"],
};

export default nextConfig;
