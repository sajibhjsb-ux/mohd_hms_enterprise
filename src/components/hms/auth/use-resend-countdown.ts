"use client";
// MOHD.HMS ENTERPRISE — server-authoritative resend countdown for OTP screens.
// The seconds come from the backend response (never hardcoded client-side);
// this hook only ticks them down once per second and can be re-seeded with a
// fresh server value (resend success or a 429 cooldown mirror).

import { useEffect, useRef, useState } from "react";

export function useResendCountdown(initialSeconds: number) {
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.floor(initialSeconds)));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const counting = secondsLeft > 0;

  // Ticks only while > 0; interval is cleaned up on every state change/unmount.
  useEffect(() => {
    if (!counting) return;
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [counting]);

  /** Re-seed from a server-authoritative value (always ≥ 1s). */
  function restart(seconds: number) {
    setSecondsLeft(Math.max(1, Math.floor(seconds)));
  }

  return { secondsLeft, counting, restart };
}

/** "Resend in 00:59" formatting shared by every OTP screen. */
export function fmtResendCountdown(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
