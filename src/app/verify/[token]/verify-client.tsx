"use client";

// MOHD.HMS ENTERPRISE — public verification client (ch.35 §6/§7/§41/§42/§48).
// Mobile-first (QR scanning happens on phones): fast, responsive, readable,
// no app install, no forced login. Visual states map 1:1 to the backend's
// deterministic verification results (§7) — the page never invents a status.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Verification = {
  result: string;
  entityType?: string;
  label?: string;
  number?: string;
  numberLabel?: string;
  recordStatus?: string;
  statusLabel?: string;
  fields?: Array<[string, string]>;
  message?: string;
  revokedReason?: string;
  verifiedAt?: string;
  access?: { requiresLogin: boolean; note: string } | null;
};

type State =
  | { phase: "loading" }
  | { phase: "offline" }
  | { phase: "error"; message: string }
  | { phase: "done"; verification: Verification };

const BRAND = "MOHD.HMS ENTERPRISE";

/** Per-result presentation tokens (§7/§41): icon, color family, headline. */
function presentation(result: string): { icon: string; ring: string; text: string; bg: string; headline: string; sub: string } {
  switch (result) {
    case "VERIFIED":
      return { icon: "✓", ring: "border-emerald-600/30", text: "text-emerald-700", bg: "bg-emerald-50", headline: "VERIFIED", sub: "This record is authentic and active." };
    case "REVOKED":
      return { icon: "⚠", ring: "border-red-600/30", text: "text-red-700", bg: "bg-red-50", headline: "DOCUMENT NOT VALID", sub: "This QR code has been revoked." };
    case "EXPIRED":
      return { icon: "⚠", ring: "border-amber-600/30", text: "text-amber-700", bg: "bg-amber-50", headline: "QR EXPIRED", sub: "This QR code's validity period has ended." };
    case "CANCELLED":
      return { icon: "✕", ring: "border-red-600/30", text: "text-red-700", bg: "bg-red-50", headline: "DOCUMENT CANCELLED", sub: "The underlying record is cancelled — treat as invalid." };
    case "SUPERSEDED":
      return { icon: "⚠", ring: "border-amber-600/30", text: "text-amber-700", bg: "bg-amber-50", headline: "SUPERSEDED", sub: "This document has been replaced by a newer version." };
    case "RESTRICTED":
      return { icon: "🔒", ring: "border-stone-400/40", text: "text-stone-600", bg: "bg-stone-100", headline: "NOT PUBLICLY VERIFIABLE", sub: "This record is not available for public verification." };
    default:
      return { icon: "✕", ring: "border-red-600/30", text: "text-red-700", bg: "bg-red-50", headline: "INVALID QR", sub: "This QR code could not be verified." };
  }
}

export function VerifyClient({ token }: { token: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  /** Fetch + resolve. All setState calls happen AFTER await — this is only
   *  ever invoked from async contexts (effect async body / event handlers). */
  const fetchVerify = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/public/verify/${encodeURIComponent(token)}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (res.status === 429) {
        setState({ phase: "done", verification: { result: "RATE_LIMITED", message: body?.message || "Too many verification attempts. Please wait a moment and try again." } });
        return;
      }
      if (!res.ok || !body?.verification) {
        setState({ phase: "error", message: "The verification service could not process this request. Please try again later." });
        return;
      }
      setState({ phase: "done", verification: body.verification });
    } catch {
      // §48 — offline is an honest, explicit state. Never claim authenticity.
      setState({ phase: "offline" });
    }
  }, [token]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // initial state is already "loading" — the first setState happens
      // strictly after the await below (external-system sync, not cascading)
      await Promise.resolve();
      if (!alive) return;
      await fetchVerify();
    })();
    return () => {
      alive = false;
    };
  }, [fetchVerify]);

  const retry = useCallback(() => {
    setState({ phase: "loading" });
    void fetchVerify();
  }, [fetchVerify]);

  return (
    <main className="min-h-screen flex flex-col bg-stone-50 text-stone-900">
      {/* Brand header (§41 — official green branding, no new branding system) */}
      <header className="bg-[#0c2414] text-white">
        <div className="mx-auto max-w-md px-4 py-5 text-center">
          <div className="text-[11px] tracking-[0.3em] text-emerald-300/80 font-medium">MOHD.HMS</div>
          <div className="text-lg font-semibold tracking-wide">ENTERPRISE</div>
          <div className="mt-1 text-[11px] text-emerald-100/60">Online Document &amp; Equipment Verification</div>
        </div>
      </header>

      <div className="flex-1 mx-auto w-full max-w-md px-4 py-6">
        {state.phase === "loading" && (
          <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm" role="status" aria-live="polite">
            <div className="mx-auto h-10 w-10 animate-spin rounded-full border-[3px] border-emerald-600/25 border-t-emerald-700" aria-hidden />
            <p className="mt-4 text-sm text-stone-500">Verifying against the live MOHD.HMS registry…</p>
            <p className="mt-1 text-[11px] text-stone-400">Do not close this page — verification is online-only.</p>
          </div>
        )}

        {state.phase === "offline" && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 p-8 text-center shadow-sm" role="alert">
            <div className="text-3xl" aria-hidden>📡</div>
            <h1 className="mt-3 text-base font-semibold text-amber-900">Unable to connect</h1>
            <p className="mt-2 text-sm text-amber-800">
              Unable to connect to the online verification service.
              <br />
              Please connect to the internet and try again.
            </p>
            <Button onClick={retry} className="mt-5 bg-emerald-700 hover:bg-emerald-800 text-white">
              Retry verification
            </Button>
          </div>
        )}

        {state.phase === "error" && (
          <div className="rounded-2xl border border-stone-200 bg-white p-8 text-center shadow-sm" role="alert">
            <div className="text-3xl text-stone-400" aria-hidden>✕</div>
            <h1 className="mt-3 text-base font-semibold text-stone-800">Verification temporarily unavailable</h1>
            <p className="mt-2 text-sm text-stone-500">{state.message}</p>
            <Button onClick={retry} className="mt-5 bg-emerald-700 hover:bg-emerald-800 text-white">
              Try again
            </Button>
          </div>
        )}

        {state.phase === "done" && <ResultCard verification={state.verification} onRetry={retry} />}
      </div>

      <footer className="mt-auto pb-[max(env(safe-area-inset-bottom),1rem)]">
        <p className="text-center text-[11px] leading-relaxed text-stone-400 px-6">
          Verified online at {brandTime()} · {BRAND}
          <br />
          Authenticity is confirmed by the MOHD.HMS server — never by the printed code alone.
        </p>
      </footer>
    </main>
  );
}

function brandTime(): string {
  try {
    return new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date().toISOString().slice(0, 16).replace("T", " ");
  }
}

function ResultCard({ verification, onRetry }: { verification: Verification; onRetry: () => void }) {
  if (verification.result === "RATE_LIMITED") {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-8 text-center shadow-sm" role="alert">
        <div className="text-3xl" aria-hidden>⏳</div>
        <h1 className="mt-3 text-base font-semibold text-amber-900">Too many attempts</h1>
        <p className="mt-2 text-sm text-amber-800">{verification.message}</p>
        <Button onClick={onRetry} className="mt-5 bg-emerald-700 hover:bg-emerald-800 text-white">Try again</Button>
      </div>
    );
  }

  const p = presentation(verification.result);
  const positive = verification.result === "VERIFIED";
  const fields = verification.fields ?? [];

  return (
    <article className={`rounded-2xl border ${p.ring} bg-white shadow-sm overflow-hidden`} aria-live="polite">
      <div className={`${p.bg} px-5 py-6 text-center`}>
        <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full border-2 ${p.ring} ${p.bg} text-3xl ${p.text}`} aria-hidden>
          {p.icon}
        </div>
        <h1 className={`mt-3 text-xl font-bold tracking-wide ${p.text}`}>{p.headline}</h1>
        <p className="mt-1 text-sm text-stone-600">{verification.message || p.sub}</p>
      </div>

      <div className="px-5 py-5">
        {(verification.label || verification.number) && (
          <div className="rounded-xl bg-stone-50 border border-stone-200 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wider text-stone-400">{verification.label || "Record"}</div>
            <div className="text-base font-semibold text-stone-900">{verification.number || "—"}</div>
          </div>
        )}

        {fields.length > 0 && (
          <dl className="mt-4 divide-y divide-stone-100">
            {fields.map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4 py-2.5">
                <dt className="text-[13px] text-stone-500">{k}</dt>
                <dd className="text-[13px] font-medium text-stone-800 text-right">{v}</dd>
              </div>
            ))}
          </dl>
        )}

        {verification.revokedReason && (
          <p className="mt-4 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[13px] text-red-800">
            <span className="font-semibold">Reason:</span> {verification.revokedReason}
          </p>
        )}

        <div className="mt-5 space-y-1 text-center">
          <p className="text-[12px] text-stone-400">
            Verified online · {brandTime()}
          </p>
          {verification.access?.requiresLogin && (
            <p className="text-[12px] text-stone-500 px-3">{verification.access.note}</p>
          )}
          <a href="/" className="mt-2 inline-block text-[12px] font-medium text-emerald-700 hover:text-emerald-800 underline underline-offset-2">
            Open MOHD.HMS ENTERPRISE
          </a>
        </div>
      </div>
    </article>
  );
}
