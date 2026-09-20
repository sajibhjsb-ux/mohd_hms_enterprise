import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
