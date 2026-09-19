// MOHD.HMS ENTERPRISE — Email design system (§12/§13/§14).
// ONE branded wrapper used by EVERY email (no per-template duplication):
//   • table-based layout (Gmail/Outlook/Apple Mail/Android/iOS compatible)
//   • official MOHD.HMS green branding + logo (inline CID image when sending,
//     same /brand asset the login screen, header and PDFs use)
//   • centralized footer from the canonical company settings (company_*) —
//     contact data is never duplicated across templates
//   • allowlist HTML sanitizer — scripts, event handlers and unsafe URLs can
//     never enter an email (§11 TEMPLATE VALIDATION / §38 SECURITY).

import "server-only";
import { getBranding } from "@/lib/hms/pdf/branding";

// ─── HTML sanitizer (allowlist; admin-authored templates only) ──────────────

const ALLOWED_TAGS = new Set([
  "a", "p", "div", "span", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "sub", "sup", "ul", "ol", "li",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "img", "blockquote", "center", "small", "font",
]);
/** Tags whose entire content is removed (not just the tag). */
const STRIP_WITH_CONTENT = ["script", "style", "iframe", "object", "embed", "noscript", "svg", "form", "link", "meta", "title", "base"];

function sanitizeUrl(raw: string, allowImg: boolean): string | null {
  const url = raw.trim().replace(/[\\"'\r\n\s]/g, "");
  if (/^(https?:|mailto:|tel:)/i.test(url)) return url;
  if (allowImg && url.startsWith("cid:")) return url;
  if (allowImg && url.startsWith("/brand/")) return url; // same-origin brand assets in previews
  return null;
}

/**
 * Allowlist-based sanitizer for email HTML. Not a full DOM parser — templates
 * are authored by authorized administrators, and the admin preview renders in a
 * sandboxed iframe as defense-in-depth. Removes scripts/styles/event handlers
 * and any URL that is not http(s)/mailto/tel (plus cid:/brand for images).
 */
export function sanitizeEmailHtml(input: string): string {
  let html = input ?? "";
  // 1. Drop dangerous tags with their content, repeatedly (nested cases).
  for (const tag of STRIP_WITH_CONTENT) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    html = html.replace(re, "");
    html = html.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), "");
  }
  // 2. Strip comments, doctype, CDATA.
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  // 3. Filter tags: keep only allowlisted; drop on* attributes; sanitize URLs.
  html = html.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)(\/?)>/g, (_m, rawTag: string, rawAttrs: string, selfClose: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    // Parse attributes safely.
    const attrs: string[] = [];
    const attrRe = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase();
      const value = m[3] ?? m[4] ?? m[5] ?? "";
      if (name.startsWith("on")) continue; // no event handlers, ever
      if (tag === "a" && name === "href") {
        const safe = sanitizeUrl(value, false);
        if (safe) attrs.push(`href="${safe}" rel="noopener noreferrer"`);
        continue;
      }
      if (tag === "img") {
        if (name === "src") {
          const safe = sanitizeUrl(value, true);
          if (safe) attrs.push(`src="${safe}"`);
          continue;
        }
        if (name === "alt") { attrs.push(`alt="${value.replace(/"/g, "&quot;")}"`); continue; }
        if (name === "width" || name === "height" || name === "style" || name === "align") {
          attrs.push(`${name}="${value.replace(/["<>]/g, "")}"`);
          continue;
        }
        continue; // drop everything else on img
      }
      if (name === "style") {
        // Inline styles allowed (email clients need them); strip url()/expression().
        const style = value.replace(/url\s*\([^)]*\)/gi, "").replace(/expression\s*\([^)]*\)/gi, "").replace(/["<>]/g, "");
        if (style.trim()) attrs.push(`style="${style.trim()}"`);
        continue;
      }
      if (name === "colspan" || name === "rowspan" || name === "align" || name === "valign" || name === "width" || name === "bgcolor" || name === "color" || name === "size" || name === "face") {
        attrs.push(`${name}="${value.replace(/["<>`]/g, "")}"`);
        continue;
      }
    }
    return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}${selfClose ? "/" : ""}>`;
  });
  // 4. Balance stray closing tags of disallowed elements.
  html = html.replace(/<\/(script|style|iframe|object|embed|svg|form|link|meta|title|base)>/gi, "");
  return html;
}

/** Convert sanitized HTML into a readable plain-text alternative. */
export function htmlToText(html: string): string {
  return (html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "  • ")
    .replace(/<td[^>]*>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Branded wrapper (table layout, §13) ────────────────────────────────────

const BRAND_GREEN = "#16a34a";
const BRAND_DARK = "#14532d";
const BRAND_INK = "#111827";
const BRAND_MUTED = "#6b7280";
const BRAND_BG = "#f4f6f4";

/**
 * Wrap body HTML (already sanitized) in the official MOHD.HMS email shell.
 * `logoSrc` is `cid:mohd-hms-logo` when sending through SMTP (inline attachment)
 * or a URL when previewing.
 */
export async function wrapBrandedEmail(bodyHtml: string, opts?: { preheader?: string; logoSrc?: string }): Promise<string> {
  const brand = await getBranding().catch(() => null);
  const company = brand?.company || "MOHD.HMS Enterprise";
  const address = (brand?.address || "").replace(/\n/g, ", ");
  const phone = brand?.phone || "";
  const email = brand?.email || "";
  const website = (await import("@/lib/db")).db.setting
    .findUnique({ where: { key: "public_url" } })
    .then((r) => r?.value ?? "")
    .catch(() => "");
  const site = await website;
  const preheader = opts?.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(opts.preheader)}</div>`
    : "";
  const logoSrc = escapeHtml(opts?.logoSrc || "cid:mohd-hms-logo");

  const contactParts = [address, phone, email].filter(Boolean).map(escapeHtml);
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<title>${escapeHtml(company)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_BG};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND_BG};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
    <!-- Header band: logo + company -->
    <tr><td style="background-color:#ffffff;padding:22px 28px 14px 28px;border-bottom:3px solid ${BRAND_GREEN};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="vertical-align:middle;">
            <img src="${logoSrc}" width="44" height="44" alt="${escapeHtml(company)} logo" style="display:block;width:44px;height:44px;border-radius:50%;" />
          </td>
          <td style="vertical-align:middle;padding-left:12px;">
            <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;color:${BRAND_INK};letter-spacing:-0.2px;">MOHD.HMS</div>
            <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:10px;font-weight:600;color:${BRAND_MUTED};letter-spacing:2.4px;text-transform:uppercase;">Enterprise</div>
          </td>
        </tr>
      </table>
    </td></tr>
    <!-- Body slot (per-template content, already sanitized) -->
    <tr><td style="padding:26px 28px 8px 28px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.65;color:${BRAND_INK};">
      ${bodyHtml}
    </td></tr>
    <!-- Centralized footer (§14 — company settings, never duplicated) -->
    <tr><td style="padding:20px 28px 24px 28px;border-top:1px solid #e5e7eb;">
      <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:${BRAND_MUTED};">
        <span style="color:${BRAND_DARK};font-weight:700;">${escapeHtml(company)}</span>
        ${contactParts.length ? " — " + contactParts.join(" · ") : ""}
        ${site ? `<br /><a href="${escapeHtml(site)}" style="color:${BRAND_GREEN};text-decoration:none;">${escapeHtml(site)}</a>` : ""}
        <br />This is an automated message from the MOHD.HMS Enterprise facility maintenance system.
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

export function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
