import type { MetadataRoute } from "next";

// MOHD.HMS ENTERPRISE — Web App Manifest (served at /manifest.webmanifest).
// Installable on Android/iOS/desktop. `start_url` is the safe application root:
// the SPA gate shows login when unauthenticated, dashboard when authenticated.
// Icons derive from the official company logo — maskable variants carry the
// badge-field dark green so device masks never clip the mark.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "MOHD.HMS ENTERPRISE",
    short_name: "MOHD.HMS",
    description: "Smart Facility Maintenance Management",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    theme_color: "#0c2414",
    background_color: "#ffffff",
    lang: "en-BN",
    dir: "ltr",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/logo-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/brand/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/brand/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
