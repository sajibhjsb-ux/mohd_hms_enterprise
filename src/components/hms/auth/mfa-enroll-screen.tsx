"use client";
// SCREEN — first-time MFA enrolment: QR + manual key + confirmation + recovery codes.

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { ArrowRight, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { AuthError, AuthPrimaryButton, BackButton } from "./auth-ui";

type EnrollData = { secret: string; otpauthUri: string; qrDataUrl: string; expiresAt: string };

export function AuthMfaEnrollScreen({
  graceDeadline,
  onBack,
  onAuthenticated,
}: {
  expiresAt: string;
  graceDeadline: string | null;
  onBack: () => void;
  onAuthenticated: () => Promise<void>;
}) {
  const [data, setData] = useState<EnrollData | null>(null);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const requested = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await api.post<EnrollData>("/api/v1/auth/mfa/enroll");
      setData(res.data);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Unable to start enrolment. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    void load();
  }, [load]);

  async function abandon() {
    try {
      await api.post("/api/v1/auth/mfa/abandon");
    } catch {
      /* best effort */
    }
    onBack();
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ recoveryCodes: string[] }>("/api/v1/auth/mfa/confirm-enrollment", { code });
      setRecoveryCodes(res.data.recoveryCodes);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function copyCodes() {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the codes and copy them manually.");
    }
  }

  function downloadCodes() {
    if (!recoveryCodes) return;
    const blob = new Blob([recoveryCodes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mohd-hms-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (recoveryCodes) {
    return (
      <>
        <div className="mt-5 space-y-1.5">
          <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">Save your recovery codes</h1>
          <p className="text-sm text-muted-foreground">Each code can be used once. Store them somewhere safe — they are the only way back in if you lose your authenticator.</p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-4 font-mono text-sm">
          {recoveryCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>

        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" className="flex-1" onClick={copyCodes}>
            <Copy className="mr-2 h-4 w-4" aria-hidden /> {copied ? "Copied" : "Copy"}
          </Button>
          <Button type="button" variant="outline" className="flex-1" onClick={downloadCodes}>
            <Download className="mr-2 h-4 w-4" aria-hidden /> Download
          </Button>
        </div>

        <div className="mt-6 flex items-start gap-2">
          <Checkbox id="mfa-codes-saved" checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
          <Label htmlFor="mfa-codes-saved" className="text-sm font-normal">
            I have saved these recovery codes
          </Label>
        </div>

        <div className="mt-5">
          <AuthPrimaryButton type="button" disabled={!saved} onClick={() => void onAuthenticated()}>
            Continue
            <ArrowRight className="ml-1 h-4 w-4" aria-hidden />
          </AuthPrimaryButton>
        </div>
      </>
    );
  }

  return (
    <form onSubmit={confirm} noValidate>
      <div className="flex items-center gap-3">
        <BackButton onClick={abandon} label="Back to login" />
      </div>

      <div className="mt-5 space-y-1.5">
        <h1 className="text-[1.65rem] font-bold leading-tight tracking-tight text-foreground">Set up two-factor authentication</h1>
        <p className="text-sm text-muted-foreground">Scan the QR code with Microsoft Authenticator, Google Authenticator or any TOTP app.</p>
      </div>

      {graceDeadline ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm font-medium text-amber-900">
          Two-factor authentication becomes mandatory for your role on {new Date(graceDeadline).toLocaleDateString()}.
        </p>
      ) : null}

      {loading ? (
        <p className="mt-7 text-sm text-muted-foreground">Preparing your QR code…</p>
      ) : data ? (
        <>
          <div className="mt-6 flex justify-center">
            <Image src={data.qrDataUrl} alt="Authenticator enrolment QR code" width={240} height={240} unoptimized className="rounded-xl border bg-white p-2" />
          </div>
          <div className="mt-4 rounded-lg bg-muted/50 p-3">
            <p className="text-xs font-medium text-muted-foreground">Can&apos;t scan? Enter this key manually:</p>
            <p className="mt-1 break-all font-mono text-sm font-semibold tracking-wider">{data.secret}</p>
          </div>

          <div className="mt-6">
            <InputOTP
              maxLength={6}
              value={code}
              onChange={(v) => {
                setCode(v);
                setError(null);
              }}
              disabled={busy}
              pattern={REGEXP_ONLY_DIGITS}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="6-digit authentication code"
              containerClassName="justify-center gap-1.5 sm:gap-2.5"
            >
              <InputOTPGroup className="flex items-center gap-1.5 sm:gap-2.5">
                {Array.from({ length: 6 }, (_, i) => (
                  <InputOTPSlot key={i} index={i} className="h-12 w-[2.6rem] rounded-xl border bg-background text-lg font-semibold shadow-sm sm:h-14 sm:w-12" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </div>

          <div aria-live="polite" className="mt-4">
            <AuthError message={error} />
          </div>

          <div className="mt-5">
            <AuthPrimaryButton loading={busy} loadingLabel="Confirming…" disabled={code.length !== 6}>
              {busy ? "Confirming…" : "Confirm"}
              {!busy && <ArrowRight className="ml-1 h-4 w-4" aria-hidden />}
            </AuthPrimaryButton>
          </div>
        </>
      ) : (
        <>
          <div aria-live="polite" className="mt-6">
            <AuthError message={error} />
          </div>
          <div className="mt-5">
            <Button type="button" variant="outline" className="h-12 w-full rounded-xl" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
