// MOHD.HMS ENTERPRISE — native deep-link validation (pure, testable).
//
// Push payloads and app links are UNTRUSTED input. The server computes a
// relative application route (e.g. "/complaints/abc"), but the native shell
// still re-validates it on the device before navigating. Only the production
// app origin, the app's custom scheme, and in-app paths are accepted — never
// javascript:/data:/file:/foreign origins.

const APP_HOST = "app.mohdhms.com";
const APP_SCHEME = "facilitypro";
const RESERVED = /^\/(?:api|_next|socket\.io|verify)(?:\/|$)/i;

/**
 * Reduce a push/link target to a same-origin application path.
 * Returns null when the value is missing, external, or not an SPA route.
 */
export function sanitizeAppPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;

  let path = value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol === `${APP_SCHEME}:`) {
      // facilitypro://open/complaints/x  →  /complaints/x
      if (url.hostname && url.hostname !== "open") return null;
      path = url.pathname || "/";
    } else if (url.protocol === "https:" && url.hostname.toLowerCase() === APP_HOST) {
      path = url.pathname || "/";
      if (url.search) path += url.search;
    } else {
      return null;
    }
  }

  // In-app routes never use a fragment; dropping it also prevents a crafted
  // "#..." from being decoded as part of a route id.
  path = path.split("#")[0];
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  if (RESERVED.test(path)) return null;
  // The SPA router only understands /<module>[/...][?query]. A bare "/" is
  // the auth gate, not a notification destination.
  const [pathname] = path.split(/[?#]/);
  if (!/^\/[a-z][a-z0-9-]*(?:\/|$)/i.test(pathname)) return null;
  return path;
}
