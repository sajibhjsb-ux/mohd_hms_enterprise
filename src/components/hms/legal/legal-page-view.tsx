"use client";

// MOHD.HMS ENTERPRISE — canonical legal document renderer.
// One component renders the Terms & Conditions and the Privacy Policy from the
// canonical API (GET /api/v1/legal/{terms|privacy}). Used by:
//   • the standalone public view (logged-out visitors — /terms, /privacy)
//   • the in-app legal modules (authenticated — footer/profile entry points)
//   • (the consent gate renders its own compact summary)
//
// Content arrives as PLAIN TEXT sections and is rendered with
// whitespace-pre-line — no HTML is ever injected (XSS-safe by construction).
// Print support reuses the existing @media print / .no-print globals.

import { useCallback, useEffect, useState } from "react";
import { FileWarning, Loader2, Printer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ClientApiError } from "@/lib/hms/api-client";
import {
  legalApiPath,
  legalTitle,
  type CompanyIdentity,
  type LegalKind,
  type PublicLegalDoc,
} from "@/lib/hms/legal/types";
import { cn } from "@/lib/utils";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function LegalPageView({
  kind,
  className,
  onNavigate,
}: {
  kind: LegalKind;
  className?: string;
  /** When provided (in-app), cross-document links navigate through the SPA
   *  router; otherwise plain <a> navigation is used (public pages). */
  onNavigate?: (path: string) => void;
}) {
  const [doc, setDoc] = useState<PublicLegalDoc | null>(null);
  const [company, setCompany] = useState<CompanyIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [docRes, companyRes] = await Promise.all([
        api.get<PublicLegalDoc | null>(legalApiPath(kind)),
        api.get<CompanyIdentity>("/api/v1/legal/company"),
      ]);
      setDoc(docRes.data);
      setCompany(companyRes.data);
    } catch (e) {
      setError(
        e instanceof ClientApiError ? e.message : "Unable to load the document. Please try again."
      );
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const other: LegalKind = kind === "TERMS" ? "PRIVACY" : "TERMS";
  const otherPath = other === "TERMS" ? "/terms" : "/privacy";

  const CrossLink = onNavigate
    ? ({ href, children }: { href: string; children: React.ReactNode }) => (
        <button
          type="button"
          onClick={() => onNavigate(href)}
          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {children}
        </button>
      )
    : ({ href, children }: { href: string; children: React.ReactNode }) => (
        <a
          href={href}
          className="font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          {children}
        </a>
      );

  if (loading) {
    return (
      <div className={cn("flex items-center justify-center gap-3 py-24 text-muted-foreground", className)}>
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        <span className="text-sm">Loading {legalTitle(kind).toLowerCase()}…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("py-16 text-center", className)}>
        <FileWarning className="mx-auto h-8 w-8 text-muted-foreground/60" aria-hidden />
        <p role="alert" className="mt-3 text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className={cn("py-16 text-center", className)}>
        <FileWarning className="mx-auto h-8 w-8 text-muted-foreground/60" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold">{legalTitle(kind)}</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          This document has not been published yet. Once the company publishes it, it will appear here.
        </p>
      </div>
    );
  }

  return (
    <article className={cn("mx-auto w-full max-w-3xl", className)}>
      {/* ── Title block ── */}
      <header className="border-b pb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{legalTitle(kind)}</h1>
            <p className="mt-1 text-sm font-semibold uppercase tracking-wide text-primary">
              MOHD.HMS Enterprise
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="no-print shrink-0"
            onClick={() => window.print()}
            aria-label="Print this document"
          >
            <Printer className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Print</span>
          </Button>
        </div>

        {/* Version / dates — real values from the canonical document; no
            effective date is invented when the company has not approved one. */}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="bg-muted/50">Version {doc.version}</Badge>
          {doc.effectiveDate ? (
            <Badge variant="outline" className="bg-muted/50">Effective {formatDate(doc.effectiveDate)}</Badge>
          ) : (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
              Effective date pending company approval
            </Badge>
          )}
          {doc.publishedAt ? (
            <Badge variant="outline" className="bg-muted/50">Last updated {formatDate(doc.publishedAt)}</Badge>
          ) : null}
        </div>

        {doc.changeSummary ? (
          <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">About this version: </span>
            {doc.changeSummary}
          </p>
        ) : null}
      </header>

      {/* ── On this page ── */}
      <nav aria-label="On this page" className="no-print border-b py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">On this page</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {doc.sections.map((s, i) => (
            <a
              key={s.id || i}
              href={`#${s.id || `section-${i + 1}`}`}
              className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
            >
              {s.title}
            </a>
          ))}
        </div>
      </nav>

      {/* ── Sections (plain text, no HTML) ── */}
      <div className="divide-y">
        {doc.sections.map((s, i) => (
          <section
            key={s.id || i}
            id={s.id || `section-${i + 1}`}
            className="scroll-mt-24 py-6"
            aria-labelledby={`${s.id || `section-${i + 1}`}-heading`}
          >
            <h2 id={`${s.id || `section-${i + 1}`}-heading`} className="text-base font-semibold text-foreground sm:text-lg">
              {i + 1}. {s.title}
            </h2>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground/90">{s.body}</p>
          </section>
        ))}
      </div>

      {/* ── Company details (live from Company Settings — never hardcoded) ── */}
      {company ? (
        <Card className="mt-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Company details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <p className="font-medium">{company.name}</p>
            {company.address ? <p className="whitespace-pre-line text-muted-foreground">{company.address}</p> : null}
            {company.country ? <p className="text-muted-foreground">{company.country}</p> : null}
            {company.phone ? (
              <p className="text-muted-foreground">
                Telephone: <a href={`tel:${company.phone.replace(/\s+/g, "")}`} className="text-primary underline-offset-4 hover:underline">{company.phone}</a>
              </p>
            ) : null}
            {company.email ? (
              <p className="text-muted-foreground">
                Email: <a href={`mailto:${company.email}`} className="text-primary underline-offset-4 hover:underline">{company.email}</a>
              </p>
            ) : null}
            {company.website ? (
              <p className="text-muted-foreground">
                Website:{" "}
                <a href={company.website} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-4 hover:underline">
                  {company.website.replace(/^https?:\/\//, "")}
                </a>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Cross links to the other canonical legal document ── */}
      <p className="mt-6 border-t pt-4 text-sm text-muted-foreground">
        {kind === "TERMS" ? (
          <>
            See also our <CrossLink href={otherPath}>Privacy Policy</CrossLink>.
          </>
        ) : (
          <>
            See also our <CrossLink href={otherPath}>Terms &amp; Conditions</CrossLink>.
          </>
        )}
      </p>
    </article>
  );
}
