"use client";

// MOHD.HMS ENTERPRISE — QR Scanner module (dedicated page, route /scan).
//
// Opened from the mobile bottom-navigation center button (and directly via
// /scan). Provides REAL live camera scanning:
//
//   bottom nav ─▶ /scan ─▶ camera permission ─▶ rear camera (facingMode:
//   environment) ─▶ live preview ─▶ jsQR decode on a downscaled canvas
//   ─▶ scan lock (one result per scan) ─▶ camera stops ─▶ existing QR
//   routing (resolve.ts) ─▶ existing record page opens through the SPA router.
//
// Reuse policy: this module does NOT invent a second QR system. It reuses the
// application's existing QR formats (equipment deep links + IRMS report URLs
// + in-app module URLs), the existing token lookup endpoint
// (/api/v1/equipment/-/qr?token= — RBAC + customer scoping enforced server
// side), and the existing SPA router destinations.
//
// Camera lifecycle (spec §22): every exit path — successful scan, Back,
// cancel, route change, logout, unmount, session expiry — stops ALL media
// tracks. No duplicate streams are ever created (Scan Again / switch camera
// stop the previous stream first).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import {
  ArrowLeft, CameraOff, Flashlight, FlashlightOff, Loader2, RefreshCw,
  ScanLine, ShieldAlert, SwitchCamera, VideoOff, WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { MODULES } from "@/components/hms/registry";
import { navigateTo } from "@/lib/hms/router";
import { resolveQrValue } from "./resolve";
import { cn } from "@/lib/utils";

type Phase =
  | { s: "starting" }
  | { s: "active" }
  | { s: "processing" }
  | { s: "denied" }
  | { s: "unavailable"; cause: "insecure" | "unsupported" | "none" | "in-use" | "generic" }
  | { s: "error"; title: string; message: string };

type Facing = "environment" | "user";

/** Target width of the down-scaled decode canvas — keeps per-frame decoding
 *  cheap (~10-20 ms) on low-end phones while QR codes stay fully resolvable. */
const DECODE_WIDTH = 440;
/** Decode cadence: ~7-8 fps is plenty for handheld scanning (spec §39). */
const DECODE_INTERVAL_MS = 130;

export function ScanModule() {
  const { user } = useSession();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  /** Scan lock — one detection per scan; the loop stops decoding immediately. */
  const lockedRef = useRef(false);
  const facingRef = useRef<Facing>("environment");

  const [phase, setPhase] = useState<Phase>({ s: "starting" });
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [switchSupported, setSwitchSupported] = useState(false);

  // Module visibility (same RBAC filter the shell applies) — used by the
  // resolver as a UX hint; the backend remains authoritative on arrival.
  const allModuleKeys = useMemo(
    () => MODULES.filter((m) => m.key !== "scan").map((m) => m.key),
    []
  );
  const visibleModuleKeys = useMemo(() => {
    if (!user) return [];
    return MODULES.filter((m) => {
      if (m.key === "scan") return false;
      if (m.roles && !m.roles.includes(user.role)) return false;
      if (m.permissions && m.permissions.length) return m.permissions.some((p) => hasPerm(user, p));
      return true;
    }).map((m) => m.key);
  }, [user]);

  /** Stop every media track and detach the preview (idempotent). */
  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    const video = videoRef.current;
    if (video?.srcObject) video.srcObject = null;
  }, []);

  /** Resolve a detected payload to an EXISTING destination (resolve.ts). */
  const resolveScanned = useCallback(
    async (raw: string) => {
      const resolution = resolveQrValue(raw, allModuleKeys, visibleModuleKeys);

      if (resolution.kind === "unsupported") {
        lockedRef.current = false;
        setPhase({
          s: "error",
          title: "Unsupported QR Code",
          message: "Please scan a valid MOHD.HMS QR code.",
        });
        return;
      }

      // Existing in-app module page — navigate through the SPA router.
      if (resolution.kind === "route") {
        navigateTo(
          resolution.module,
          resolution.seg,
          Object.keys(resolution.query).length ? resolution.query : undefined
        );
        return; // route change unmounts the scanner → cleanup stops the camera
      }

      // Equipment token → the existing lookup endpoint (RBAC + customer
      // scoping enforced server-side), then the same detail page the
      // equipment deep-link resolver opens.
      if (typeof navigator.onLine === "boolean" && !navigator.onLine) {
        lockedRef.current = false;
        setPhase({
          s: "error",
          title: "No internet connection",
          message: "An internet connection is required to open this QR record.",
        });
        return;
      }
      try {
        const res = await api.get<{ equipmentId: string; assetTag: string; name: string }>(
          `/api/v1/equipment/-/qr?token=${encodeURIComponent(resolution.token)}`
        );
        if (!res.data?.equipmentId) throw new Error("This QR code could not be found.");
        navigateTo("equipment", [res.data.equipmentId]);
      } catch (err) {
        lockedRef.current = false;
        setPhase({
          s: "error",
          title: "QR code could not be opened",
          message:
            err instanceof Error && err.message
              ? err.message
              : "This QR code could not be found.",
        });
      }
    },
    [allModuleKeys, visibleModuleKeys]
  );

  /** First detection wins; camera stops BEFORE processing (spec §23). */
  const handleDetected = useCallback(
    (raw: string) => {
      if (lockedRef.current) return;
      lockedRef.current = true;
      stopStream();
      setTorchOn(false);
      setPhase({ s: "processing" });
      void resolveScanned(raw);
    },
    [stopStream, resolveScanned]
  );

  /** Start (or restart) the camera — always after stopping the previous stream. */
  const startCamera = useCallback(async () => {
    stopStream();
    setTorchSupported(false);
    setTorchOn(false);

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setPhase({ s: "unavailable", cause: "insecure" });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setPhase({ s: "unavailable", cause: "unsupported" });
      return;
    }
    setPhase({ s: "starting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // Rear camera preferred where available (spec §11) — `ideal` keeps
          // it soft so devices without an environment camera still open one.
          facingMode: { ideal: facingRef.current },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch {
          /* muted + playsInline covers autoplay policies; the loop retries */
        }
      }

      // Flash only when the REAL camera track supports torch (spec §13).
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      setTorchSupported(!!caps?.torch);

      // Camera switch only when several cameras exist (spec §12).
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setSwitchSupported(devices.filter((d) => d.kind === "videoinput").length > 1);
      } catch {
        setSwitchSupported(false);
      }

      lockedRef.current = false;
      setPhase({ s: "active" });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPhase({ s: "denied" });
      } else if (name === "NotReadableError" || name === "AbortError") {
        setPhase({ s: "unavailable", cause: "in-use" });
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setPhase({ s: "unavailable", cause: "none" });
      } else {
        setPhase({ s: "unavailable", cause: "generic" });
      }
    }
  }, [stopStream]);

  // Mount: start the camera. Unmount / route change / logout: stop ALL tracks.
  useEffect(() => {
    void startCamera();
    return () => stopStream();
  }, [startCamera, stopStream]);

  // Decode loop — only while actively scanning. Chained timeouts (never
  // overlapping decodes), stopped the moment a code is detected.
  useEffect(() => {
    if (phase.s !== "active") return;
    let cancelled = false;
    let timer: number | undefined;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0 && ctx) {
        const scale = DECODE_WIDTH / video.videoWidth;
        canvas.width = DECODE_WIDTH;
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          handleDetected(code.data);
          return;
        }
      }
      timer = window.setTimeout(tick, DECODE_INTERVAL_MS);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [phase.s, handleDetected]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setTorchSupported(false); // track lied about torch — hide the control
    }
  }

  async function switchCamera() {
    facingRef.current = facingRef.current === "environment" ? "user" : "environment";
    await startCamera(); // stops the previous stream first — never two streams
  }

  function scanAgain() {
    lockedRef.current = false;
    void startCamera();
  }

  function goBack() {
    stopStream();
    if (typeof window !== "undefined" && window.history.length > 1) window.history.back();
    else navigateTo("dashboard");
  }

  const platformHint = useMemo(() => {
    if (typeof navigator === "undefined") return null;
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/i.test(ua)) {
      return "On iPhone / iPad: Settings › Safari › Camera › Allow (or Settings › [this app] › Camera for the installed app), then try again.";
    }
    if (/Android/i.test(ua)) {
      return "On Android: tap the ⋮ or ⓘ icon in the address bar › Permissions › Camera › Allow, then try again.";
    }
    return "Check the camera permission for this site in your browser's address-bar settings, then try again.";
  }, []);

  const live = phase.s === "active" || phase.s === "processing";

  return (
    <div
      data-testid="scan-page"
      role="region"
      aria-label="QR code scanner"
      className="fixed inset-0 z-50 flex flex-col overscroll-contain bg-black text-white"
    >
      {/* Top bar — respects the notch / Dynamic Island (spec §27) */}
      <header className="flex items-center gap-2 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          data-testid="scan-back"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="text-base font-semibold tracking-tight">Scan QR Code</h1>
        <span className="ml-auto pr-2 text-[10px] font-medium uppercase tracking-[0.16em] text-white/40">
          MOHD.HMS
        </span>
      </header>

      {/* Live camera viewport */}
      <div className="relative flex-1 overflow-hidden" data-testid="scan-camera-area">
        <video
          ref={videoRef}
          muted
          playsInline
          autoPlay
          data-testid="scan-video"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300",
            live ? "opacity-100" : "opacity-0"
          )}
        />

        {/* Scan frame — green corner markers, never covering the code */}
        {live ? (
          <>
            <div className="pointer-events-none absolute inset-0 bg-black/35" aria-hidden />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center" data-testid="scan-frame">
              <div className="relative aspect-square w-[min(70vw,270px)]">
                <span className="absolute left-0 top-0 h-9 w-9 rounded-tl-2xl border-l-[3px] border-t-[3px] border-primary" aria-hidden />
                <span className="absolute right-0 top-0 h-9 w-9 rounded-tr-2xl border-r-[3px] border-t-[3px] border-primary" aria-hidden />
                <span className="absolute bottom-0 left-0 h-9 w-9 rounded-bl-2xl border-b-[3px] border-l-[3px] border-primary" aria-hidden />
                <span className="absolute bottom-0 right-0 h-9 w-9 rounded-br-2xl border-b-[3px] border-r-[3px] border-primary" aria-hidden />
                {phase.s === "active" ? (
                  <span className="absolute inset-x-5 top-1/2 h-0.5 -translate-y-1/2 animate-pulse rounded-full bg-primary/70 motion-reduce:animate-none" aria-hidden />
                ) : null}
              </div>
            </div>
            {phase.s === "processing" ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center px-6">
                <span
                  className="flex items-center gap-2 rounded-full bg-background/95 px-4 py-2 text-sm font-medium text-foreground shadow-lg"
                  role="status"
                  data-testid="scan-processing"
                >
                  <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden />
                  QR detected — opening the record…
                </span>
              </div>
            ) : null}
          </>
        ) : null}

        {phase.s === "starting" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" role="status">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-hidden />
            <p className="text-sm text-white/80">Starting camera…</p>
          </div>
        ) : null}
      </div>

      {/* Instruction + camera controls — above the home indicator (spec §27) */}
      <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-3">
        <p
          aria-live="polite"
          data-testid="scan-status"
          className="flex min-h-[24px] items-center justify-center gap-2 text-center text-sm text-white/85"
        >
          {phase.s === "active" ? (
            <>
              <ScanLine className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              Point your camera at a MOHD.HMS QR code.
            </>
          ) : null}
          {phase.s === "starting" ? "Starting camera…" : null}
          {phase.s === "processing" ? "QR detected — opening the record…" : null}
          {phase.s === "denied" ? "Camera access is blocked for this site." : null}
          {phase.s === "unavailable" ? "Camera is not available right now." : null}
          {phase.s === "error" ? "This QR code could not be opened." : null}
        </p>

        {phase.s === "active" && (torchSupported || switchSupported) ? (
          <div className="mt-3 flex items-center justify-center gap-3">
            {torchSupported ? (
              <Button
                type="button"
                onClick={() => void toggleTorch()}
                aria-pressed={torchOn}
                aria-label={torchOn ? "Turn flash off" : "Turn flash on"}
                data-testid="scan-torch"
                className="min-h-[44px] rounded-full border-white/25 bg-white/10 px-5 text-white hover:bg-white/20 hover:text-white"
              >
                {torchOn ? <FlashlightOff className="h-4 w-4" aria-hidden /> : <Flashlight className="h-4 w-4" aria-hidden />}
                Flash {torchOn ? "off" : "on"}
              </Button>
            ) : null}
            {switchSupported ? (
              <Button
                type="button"
                onClick={() => void switchCamera()}
                aria-label="Switch camera"
                data-testid="scan-switch"
                className="min-h-[44px] rounded-full border-white/25 bg-white/10 px-5 text-white hover:bg-white/20 hover:text-white"
              >
                <SwitchCamera className="h-4 w-4" aria-hidden />
                Switch
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Blocking states — permission / availability / scan failure cards */}
      {phase.s === "denied" || phase.s === "unavailable" || phase.s === "error" ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/85 px-5 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-neutral-900 p-5 text-center shadow-2xl"
            role="alertdialog"
            aria-label={phase.s === "denied" ? "Camera Access Required" : phase.s === "unavailable" ? "Camera unavailable" : "QR code could not be opened"}
          >
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/15 text-destructive">
              {phase.s === "denied" ? (
                <CameraOff className="h-6 w-6" aria-hidden />
              ) : phase.s === "unavailable" ? (
                <VideoOff className="h-6 w-6" aria-hidden />
              ) : (
                <ShieldAlert className="h-6 w-6" aria-hidden />
              )}
            </span>
            <h2 className="mt-3 text-base font-semibold">
              {phase.s === "denied"
                ? "Camera Access Required"
                : phase.s === "unavailable"
                  ? UNAVAILABLE_COPY[phase.cause].title
                  : phase.title}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-white/70">
              {phase.s === "denied"
                ? "MOHD.HMS needs access to your camera to scan QR codes."
                : phase.s === "unavailable"
                  ? UNAVAILABLE_COPY[phase.cause].message
                  : phase.message}
            </p>
            {phase.s === "denied" ? (
              <p className="mt-2 rounded-lg bg-white/5 px-3 py-2 text-left text-xs leading-relaxed text-white/60">
                {platformHint}
              </p>
            ) : null}
            {phase.s === "error" && /connection|network/i.test(phase.message) ? (
              <WifiOff className="mx-auto mt-2 h-4 w-4 text-white/40" aria-hidden />
            ) : null}
            <div className="mt-4 flex flex-col gap-2">
              {phase.s === "denied" ? (
                <Button
                  type="button"
                  onClick={() => void startCamera()}
                  data-testid="scan-deny-retry"
                  className="min-h-[44px] rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Allow Camera
                </Button>
              ) : null}
              {phase.s === "unavailable" && phase.cause === "in-use" ? (
                <Button
                  type="button"
                  onClick={() => void startCamera()}
                  data-testid="scan-deny-retry"
                  className="min-h-[44px] rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Try Again
                </Button>
              ) : null}
              {phase.s === "error" ? (
                <Button
                  type="button"
                  onClick={scanAgain}
                  data-testid="scan-scan-again"
                  className="min-h-[44px] rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <ScanLine className="h-4 w-4" aria-hidden />
                  Scan Again
                </Button>
              ) : null}
              <Button
                type="button"
                onClick={goBack}
                data-testid="scan-error-back"
                variant="outline"
                className="min-h-[44px] rounded-full border-white/25 bg-transparent text-white hover:bg-white/10 hover:text-white"
              >
                Back
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Honest, human copy for every camera-availability failure (spec §8/§34). */
const UNAVAILABLE_COPY: Record<Extract<Phase, { s: "unavailable" }>["cause"], { title: string; message: string }> = {
  insecure: {
    title: "Secure connection required",
    message: "Camera access requires a secure (HTTPS) connection. Open MOHD.HMS at https://www.mohdhms.com and try again.",
  },
  unsupported: {
    title: "Camera is not available on this device.",
    message: "This browser does not support camera access. You can scan with your phone's camera app and paste the code using the QR button in the header.",
  },
  none: {
    title: "Camera is not available on this device.",
    message: "No usable camera was found. You can scan with your phone's camera app and paste the code using the QR button in the header.",
  },
  "in-use": {
    title: "Camera is busy",
    message: "The camera is already in use by another app or tab. Close it and try again.",
  },
  generic: {
    title: "Unable to access your camera.",
    message: "Please check camera permissions and try again.",
  },
};
