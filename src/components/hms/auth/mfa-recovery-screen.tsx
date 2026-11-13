"use client";
// SCREEN — single-use recovery code entry for a pending login challenge.

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { AuthError, AuthPrimaryButton, BackButton } from "./auth-ui";

export function AuthMfaRecoveryScreen({
  onBack,
  onAuthenticated,
}: {
  expiresAt: string;
  onBack: () => void;
  onAuthenticated: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function abandon() {
    try {
      await api.post("/api/v1/auth/mfa/abandon");
    } catch {
      /* best effort */
    }
    onBack();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api.post("/api/v1/auth/mfa/recovery", { code });
      await onAuthenticated();
    } catch (err) {
      setError(err instanceof ClientApiError && err.code === "NETWORK" ? "Unable to connect. Please check your connection and try again." : err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="flex items-center gap-3">
        <BackButton onClick={abandon} label="Back to authentication code" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">Recovery code</h1>
        <p className="text-sm text-muted-foreground">Enter one of the recovery codes you saved when you set up two-factor authentication.</p>
      </div>

      <div className="mt-7 space-y-1.5">
        <Label htmlFor="mfa-recovery-code" className="text-sm font-medium">
          Recovery code
        </Label>
        <Input
          id="mfa-recovery-code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError(null);
          }}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="XXXXX-XXXXX"
          className="h-12 rounded-xl bg-background font-mono text-base tracking-wider"
        />
      </div>

      <div aria-live="polite" className="mt-4">
        <AuthError message={error} />
      </div>

      <div className="mt-5">
        <AuthPrimaryButton loading={busy} loadingLabel="Verifying…" disabled={code.trim().length < 8}>
          {busy ? "Verifying…" : "Use recovery code"}
          {!busy && <ArrowRight className="ml-1 h-4 w-4" aria-hidden />}
        </AuthPrimaryButton>
      </div>
    </form>
  );
}
