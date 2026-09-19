// MOHD.HMS ENTERPRISE — Template rendering (§10/§11/§43).
//   • Substitutes {{VARIABLES}} from the server-resolved map — values are
//     HTML-escaped so data can never inject markup (no XSS, no template
//     injection: unknown variables are DROPPED, never executed).
//   • Validates the result (§11): unresolved variable names are reported as
//     warnings; subjects cannot contain raw markup.
//   • Wraps the sanitized body in the branded shell (layout.ts).

import "server-only";
import { htmlToText, sanitizeEmailHtml, wrapBrandedEmail } from "./layout";
import type { RenderedEmail } from "./types";

const VAR_RE = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

function escapeValue(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render a template subject + body against resolved data.
 * `sample` marks preview renders (PORTAL_URL fallbacks etc. still real data).
 */
export async function renderTemplate(params: {
  subject: string;
  bodyHtml: string;
  data: Record<string, string>;
  logoSrc?: string; // defaults to cid:mohd-hms-logo; previews may pass a URL
  preheader?: string;
}): Promise<RenderedEmail> {
  const warnings: string[] = [];
  const usedVariables: string[] = [];

  // ── Subject: plain text only — strip markup and any {{VAR}} that is unknown.
  const subjectMissing = new Set<string>();
  const subject = (params.subject || "").replace(VAR_RE, (_m, name: string) => {
    const v = params.data[name];
    if (v === undefined || v === "") {
      subjectMissing.add(name);
      return "";
    }
    return v.replace(/<[^>]*>/g, "").trim();
  }).replace(/\s{2,}/g, " ").trim();
  if (subjectMissing.size) warnings.push(`Subject variables not resolved: ${[...subjectMissing].join(", ")}`);
  if (!subject) warnings.push("Subject is empty after rendering");

  // ── Body: substitute → sanitize → brand-wrap.
  const unknown = new Set<string>();
  let body = params.bodyHtml || "";
  body = body.replace(VAR_RE, (_m, name: string) => {
    const v = params.data[name];
    if (v === undefined) {
      unknown.add(name);
      return ""; // drop — never render raw placeholders, never execute (§11)
    }
    usedVariables.push(name);
    return v === "" ? "" : escapeValue(v);
  });
  if (unknown.size) warnings.push(`Unknown or unresolved variables dropped: ${[...unknown].join(", ")}`);

  const safe = sanitizeEmailHtml(body);
  // Empty PORTAL_LINK_TEXT means the template's button line collapses cleanly.
  const html = await wrapBrandedEmail(safe, { preheader: params.preheader ?? subject, logoSrc: params.logoSrc });

  return { subject, html, text: htmlToText(safe), warnings, usedVariables };
}

/** Validate a template BEFORE activation (§11 TEMPLATE VALIDATION). */
export function validateTemplate(params: { subject: string; bodyHtml: string; allowedVariables: readonly string[] }): string[] {
  const errors: string[] = [];
  const subject = (params.subject || "").trim();
  if (!subject) errors.push("Subject is required.");
  if (subject.length > 300) errors.push("Subject must be 300 characters or fewer.");
  const body = (params.bodyHtml || "").trim();
  if (!body) errors.push("Email body is required.");
  if (body.length > 200_000) errors.push("Email body is too large (max 200k characters).");
  // Unknown variables must be declared so administrators see what is available.
  const declared = new Set(params.allowedVariables);
  for (const m of body.matchAll(VAR_RE)) {
    const name = m[1];
    if (!declared.has(name)) errors.push(`Unknown variable {{${name}}} — add it to the template's variable list or remove it.`);
  }
  for (const m of subject.matchAll(VAR_RE)) {
    const name = m[1];
    if (!declared.has(name)) errors.push(`Subject uses undeclared variable {{${name}}}.`);
  }
  // Script injection must never pass validation.
  if (/<\s*(script|iframe|object|embed|form|svg)\b/i.test(body)) {
    errors.push("Script, iframe, object, embed, form and svg tags are not allowed in emails.");
  }
  if (/javascript\s*:/i.test(body)) errors.push("javascript: URLs are not allowed.");
  return errors;
}
