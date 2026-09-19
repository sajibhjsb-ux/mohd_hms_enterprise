"use client";

// MOHD.HMS ENTERPRISE — Terms & Conditions consent gate (customer portal).
// Rendered by the shell INSTEAD of module content when the backend
// (session payload → user.terms.requiresAcceptance) says the current version
// has not been accepted yet. Covers both first-time acceptance and the
// "Terms & Conditions Updated" re-acceptance flow after a new version is
// published — existing users are NEVER silently marked as accepted.
//
// The checkbox starts UNCHECKED (spec §21). Acceptance is persisted only by
// POST /api/v1/legal/terms/accept (server decides the version and records an
// append-only acceptance row + audit event). Declining = sign out.

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Loader2, LogOut, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { legalApiPath, legalTitle, type PublicLegalDoc } from "@/lib/hms/legal/types";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

export function TermsConsentGate() {
  const { user, refresh, signOut } = useSession();
  const [doc, setDoc] = useState<PublicLegalDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<PublicLegalDoc | null>(legalApiPath("TERMS"));
      setDoc(res.data);
    } catch (e) {
      setLoadError(e instanceof ClientApiError ? e.message : "Unable to load the document.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isUpdate = !!user?.terms?.acceptedVersion && user.terms.acceptedVersion !== user.terms.version;

  async function accept() {
    if (busy || !agreed) return;
    setBusy(true);
    setError(null);
    try {
      // Server-authoritative: the backend picks the current published version.
      await api.post("/api/v1/legal/terms/accept");
      await refresh(); // session comes back with requiresAcceptance=false
    } catch (e) {
      setError(
        e instanceof ClientApiError
          ? e.message
          : "We could not record your acceptance. Please check your connection and try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="splash-viewport mx-auto flex w-full max-w-2xl flex-col justify-center px-4 py-8">
      <div className="flex flex-col items-center text-center">
        <Image
          src="/brand/logo-128.png"
          alt="MOHD.HMS Enterprise logo"
          width={64}
          height={64}
          className="h-16 w-16 rounded-full ring-1 ring-border/40"
          priority
        />
        <h1 className="mt-4 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {isUpdate ? "Terms & Conditions Updated" : legalTitle("TERMS")}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {isUpdate
            ? `Version ${user?.terms?.version ?? ""} replaced version ${user?.terms?.acceptedVersion ?? ""}. Please review the changes to continue.`
            : "Please review and accept the Terms & Conditions to continue to your portal."}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {user?.terms?.version ? (
            <Badge variant="outline" className="bg-muted/50">Version {user.terms.version}</Badge>
          ) : null}
          {user?.terms?.effectiveDate ? (
            <Badge variant="outline" className="bg-muted/50">Effective {formatDate(user.terms.effectiveDate)}</Badge>
          ) : null}
        </div>
      </div>

      {/* What changed (update notice) */}
      {isUpdate && user?.terms?.changeSummary ? (
        <p className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">What changed: </span>
          {user.terms.changeSummary}
        </p>
      ) : null}

      {/* Compact document preview */}
      <Card className="mt-4">
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              <span className="text-sm">Loading the document…</span>
            </div>
          ) : loadError ? (
            <div className="py-10 text-center">
              <p role="alert" className="text-sm text-muted-foreground">{loadError}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : doc ? (
            <div className="max-h-64 overflow-y-auto px-5 py-4 sm:max-h-72">
              <div className="space-y-4">
                {doc.sections.map((s, i) => (
                  <div key={s.id || i}>
                    <p className="text-xs font-semibold text-foreground">
                      {i + 1}. {s.title}
                    </p>
                    <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                      {s.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              The Terms & Conditions have not been published yet. If you believe this is an error, contact the company.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="mt-2 text-center text-xs text-muted-foreground">
        Prefer the full page?{" "}
        <a
          href="/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          Open the full Terms &amp; Conditions
        </a>
        .
      </p>

      {/* Consent checkbox — deliberately UNCHECKED; acceptance is recorded
          server-side only after an explicit user action. Wrapping native
          <label> (implicit association, touch-friendly full-row target);
          the text lives in a <span> because shadcn Label is itself a flex
          container and would squeeze plain text runs into narrow columns. */}
      <label
        htmlFor="terms-consent"
        className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border bg-background p-4"
      >
        <Checkbox
          id="terms-consent"
          checked={agreed}
          onCheckedChange={(v) => setAgreed(v === true)}
          className="mt-0.5 h-[1.15rem] w-[1.15rem] shrink-0"
          disabled={loading || !!loadError}
        />
        <span className="min-w-0 flex-1 text-sm font-normal leading-relaxed text-foreground/90">
          I have read and agree to the{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary">
            Terms &amp; Conditions
          </a>{" "}
          and the{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary">
            Privacy Policy
          </a>
          .
        </span>
      </label>

      {error ? (
        <p role="alert" className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={() => void signOut()} disabled={busy}>
          <LogOut className="h-4 w-4" aria-hidden />
          Sign out
        </Button>
        <Button onClick={() => void accept()} disabled={!agreed || busy || loading || !!loadError} aria-busy={busy || undefined}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Recording acceptance…
            </>
          ) : (
            <>
              <ScrollText className="h-4 w-4" aria-hidden />
              Agree and continue
            </>
          )}
        </Button>
      </div>

      <p className="mt-4 text-center text-[0.7rem] text-muted-foreground/80">
        Your acceptance (version, date and time) is recorded and kept as evidence of consent.
      </p>
    </div>
  );
}
