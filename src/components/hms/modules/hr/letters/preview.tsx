"use client";

// MOHD.HMS ENTERPRISE — LetterPaper: HTML preview of a rendered letter (§26).
//
// Renders the EXACT structure the final PDF is built from (same
// LetterPreviewModel from the server) on an A4-proportioned paper so the
// preview matches the issued document as closely as the web allows:
// letterhead → recipient → subject → salutation → body → closing → signature.

import type { LetterPreviewModel } from "@/lib/hms/letters/shared";
import { cn } from "@/lib/utils";

export function LetterPaper({ model, className }: { model: LetterPreviewModel; className?: string }) {
  const c = model.company;
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[760px] rounded-lg border bg-white text-black shadow-sm",
        className
      )}
      aria-label={`Preview of ${model.typeLabel} ${model.referenceNo}`}
    >
      <div className="p-5 sm:p-9" style={{ aspectRatio: "auto" }}>
        {/* ── Letterhead ── */}
        <div className="flex items-start justify-between gap-4 border-b-2 pb-4" style={{ borderColor: "#155e38" }}>
          <div className="flex items-start gap-3 min-w-0">
                  <img src="/brand/logo-256.png" alt="MOHD.HMS ENTERPRISE logo" className="h-12 w-12 shrink-0 object-contain" />
            <div className="min-w-0">
              <div className="text-[15px] font-bold leading-tight" style={{ color: "#0d4d2c" }}>
                {c.name}
              </div>
              {c.addressLines.map((l, i) => (
                <div key={i} className="text-[10.5px] leading-snug text-neutral-600">
                  {l}
                </div>
              ))}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[13px] font-bold uppercase tracking-wide" style={{ color: "#0d4d2c" }}>
              {model.typeLabel}
            </div>
            <div className="text-[11px] text-neutral-700">Ref: {model.referenceNo}</div>
            <div className="text-[11px] text-neutral-700">Dated {model.letterDate}</div>
          </div>
        </div>

        {/* ── Recipient ── */}
        {model.recipientLines.length > 0 && (
          <div className="mt-6 mb-4">
            {model.recipientLines.map((l, i) => (
              <div key={i} className="text-[12.5px] leading-snug">
                {l}
              </div>
            ))}
          </div>
        )}

        {/* ── Subject ── */}
        {model.subject && (
          <div className="mt-4 mb-4 text-[12.5px] font-bold">Subject: {model.subject}</div>
        )}

        {/* ── Salutation ── */}
        <div className="mt-3 mb-3 text-[12.5px]">{model.salutation}</div>

        {/* ── Body ── */}
        <div className="space-y-3">
          {model.paragraphs.length === 0 ? (
            <p className="text-[12px] italic text-neutral-400">
              (No content yet — generate an AI draft or write the letter body.)
            </p>
          ) : (
            model.paragraphs.map((p, i) => (
              <p key={i} className="whitespace-pre-line text-[12.5px] leading-relaxed">
                {p}
              </p>
            ))
          )}
        </div>

        {/* ── Closing + signature ── */}
        <div className="mt-6">
          <div className="text-[12.5px]">{model.closing}</div>
          <div className="mt-10 max-w-[280px]">
            {model.signatory.hasSignatureImage ? (
              <img
                src={model.signatory.signatureUrl}
                alt={`Signature of ${model.signatory.name}`}
                className="mb-1 h-12 w-auto object-contain"
              />
            ) : null}
            <div className="border-t border-neutral-500 pt-1">
              {model.signatory.name && <div className="text-[12px] font-semibold">{model.signatory.name}</div>}
              {model.signatory.position && <div className="text-[11px] text-neutral-600">{model.signatory.position}</div>}
            </div>
          </div>
        </div>

        {/* ── Enclosures ── */}
        {model.enclosures.length > 0 && (
          <div className="mt-8 text-[10.5px] text-neutral-600">Encl: {model.enclosures.join("; ")}</div>
        )}
      </div>
    </div>
  );
}

/** Compact loading skeleton that reserves the paper shape. */
export function LetterPaperSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[760px] rounded-lg border bg-white p-9 shadow-sm" aria-hidden>
      <div className="flex items-start justify-between border-b-2 pb-4">
        <div className="h-12 w-12 animate-pulse rounded bg-neutral-200" />
        <div className="space-y-1.5 text-right">
          <div className="h-3 w-28 animate-pulse rounded bg-neutral-200" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-neutral-200" />
        </div>
      </div>
      <div className="mt-6 space-y-2.5">
        <div className="h-2.5 w-1/2 animate-pulse rounded bg-neutral-200" />
        <div className="h-2.5 w-2/3 animate-pulse rounded bg-neutral-200" />
        <div className="h-2.5 w-full animate-pulse rounded bg-neutral-200" />
        <div className="h-2.5 w-5/6 animate-pulse rounded bg-neutral-200" />
      </div>
    </div>
  );
}
