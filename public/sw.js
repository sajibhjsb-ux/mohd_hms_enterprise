/*
 * MOHD.HMS ENTERPRISE — Service Worker (production-grade, framework-free).
 *
 * Strategies (deliberately conservative — enterprise data must never leak
 * into uncontrolled persistent storage):
 *
 *   Navigations (GET, mode=navigate)
 *       network-first (3.5s timeout) → shell cache → /offline.html.
 *       The SPA shell HTML is role-agnostic (no business data in markup),
 *       so caching it is safe; ALL business data arrives via /api/* which
 *       is NEVER cached.
 *
 *   Immutable static (/_next/static, brand icons, fonts, manifest)
 *       stale-while-revalidate — instant loads, background freshness,
 *       no stale-chunk risk during development either.
 *
 *   Everything else (APIs, socket.io / realtime, cross-origin, non-GET)
 *       BYPASS — the service worker does not touch them. WebSocket and
 *       polling transports are explicitly excluded so realtime is unaffected.
 *
 * Push: validated payloads only; notification click routes into the
 * existing application route supplied by the server (RBAC applied server-side).
 */

const VERSION = "v2";
const STATIC_CACHE = `hms-static-${VERSION}`;
const SHELL_CACHE = `hms-shell-${VERSION}`;
const OFFLINE_URL = "/offline.html";

const PRECACHE_URLS = [
  OFFLINE_URL,
  "/brand/icon-192.png",
  "/brand/logo-512.png",
  "/brand/icon-maskable-192.png",
  "/brand/icon-maskable-512.png",
];

/** Requests that must never be intercepted (sensitive APIs + realtime). */
function isBypassed(url) {
  if (url.origin !== self.location.origin) return true;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return true;
  if (url.searchParams.has("XTransformPort")) return true; // gateway relay (socket.io etc.)
  if (url.searchParams.has("EIO") || url.pathname === "/engine.io") return true;
  if (url.pathname.startsWith("/_next/webpack-hmr")) return true;
  return false;
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/brand/") ||
    url.pathname === "/logo.svg" ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname.startsWith("/_next/image") ||
    url.pathname.startsWith("/_next/fonts") ||
    /\.(?:woff2?|ttf|otf|png|jpg|jpeg|svg|webp|ico|css|js)$/.test(url.pathname)
  );
}

/** Fetch with a hard timeout so offline navigations fall back quickly. */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function trimCache(name, maxEntries) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  for (const key of keys.slice(0, keys.length - maxEntries)) {
    await cache.delete(key);
  }
}

/**
 * Store a cacheable copy. NOTE: the put is awaited by the caller BEFORE
 * respondWith resolves — Chromium discards pending writes that only hang
 * off event.waitUntil() once the response settles.
 */
async function storeResponse(cacheName, request, res) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, storableResponse(res.clone()));
  } catch { /* storage full / quota — caching is best-effort */ }
}

/**
 * Clone a response into one that the Cache API accepts. Dev-server assets
 * (and some HTML) are sent with `Cache-Control: no-store`; the stored copy
 * gets a sane header instead so offline caching works without touching the
 * live response delivered to the page.
 */
function storableResponse(res) {
  const headers = new Headers(res.headers);
  const cc = headers.get("cache-control");
  if (cc && cc.includes("no-store")) headers.set("cache-control", "public, max-age=0, must-revalidate");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function handleNavigation(event) {
  const request = event.request;
  try {
    const res = await fetchWithTimeout(request, 3500);
    if (res && res.ok && res.type === "basic") {
      await storeResponse(SHELL_CACHE, request, res);
      await trimCache(SHELL_CACHE, 10);
    }
    return res;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;
    const offline = await caches.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

/**
 * Static assets: fresh-first with cache fallback. When the network fails
 * (offline), the cached copy is served so the app shell can fully boot.
 */
async function handleStatic(event) {
  const request = event.request;
  const cached = await caches.match(request);
  try {
    const res = await fetchWithTimeout(request, 8000);
    if (res && res.ok && res.type === "basic") {
      await storeResponse(STATIC_CACHE, request, res);
    }
    return res;
  } catch {
    if (cached) return cached;
    return Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(new Request(u, { cache: "reload" }))));
      // No skipWaiting() here — activation is user-consented (update flow).
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith("hms-") && ![STATIC_CACHE, SHELL_CACHE].includes(n))
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isBypassed(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(handleStatic(event));
    return;
  }
  // Everything else: default browser behavior (no interception).
});

/* ─────────────────────────── Update protocol ───────────────────────────
 * The page decides when the waiting worker may activate (never mid-form):
 * it sends { type: "SKIP_WAITING" } after the user clicks Refresh.        */

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ──────────────────────────── Web Push ───────────────────────────────── */

function safePayload(raw) {
  let data = {};
  if (raw) {
    try {
      data = raw.json();
    } catch {
      data = { body: raw.text() || "" };
    }
  }
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title.trim().slice(0, 120)
      : "MOHD.HMS ENTERPRISE";
  const body = typeof data.body === "string" ? data.body.slice(0, 300) : "";
  const url =
    typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//")
      ? data.url
      : "/dashboard";
  const tag = typeof data.tag === "string" && data.tag ? data.tag.slice(0, 80) : url;
  return { title, body, url, tag };
}

self.addEventListener("push", (event) => {
  const payload = safePayload(event.data);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/brand/icon-192.png",
      badge: "/brand/icon-maskable-192.png",
      tag: payload.tag,
      data: { url: payload.url },
      renotify: false,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    (async () => {
      const target = new URL(url, self.location.origin).href;
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url === target) {
          await client.focus();
          return;
        }
      }
      if (clientList.length > 0) {
        // App already open on another page — focus it and route in-app
        // (History API router listens for this event via the PWA runtime).
        const client = clientList[0];
        await client.focus();
        client.postMessage({ type: "hms:navigate", url: target });
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});

/* ─────────────────────── Background Sync (drafts) ──────────────────────
 * Only re-flushes locally-saved form drafts through an open client.
 * Authoritative business mutations are NEVER queued here.                */

self.addEventListener("sync", (event) => {
  if (event.tag !== "hms-draft-flush") return;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({ type: "hms:flush-drafts" });
      }
    })()
  );
});
