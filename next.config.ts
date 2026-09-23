import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin Turbopack's root to this project so stray lockfiles in parent dirs
  // (e.g. /home/hasan/package-lock.json) can never hijack the build — otherwise
  // the standalone server.js lands nested under .next/standalone/<rel-app>/
  // instead of .next/standalone/server.js and release slots cannot start.
  turbopack: { root: process.cwd() },
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
