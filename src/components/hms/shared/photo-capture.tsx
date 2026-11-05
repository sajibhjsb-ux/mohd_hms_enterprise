"use client";

// MOHD.HMS ENTERPRISE — shared camera + photo capture surface.
// One component for every photo workflow: live camera preview where the
// browser supports it, native camera fallback, file picker, staged review
// (preview / retake / remove), and an honest per-file upload queue. Bytes
// always go through the caller's authenticated API route; this component only
// builds the request context (stable uploadId for safe retries).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle, Camera, CheckCircle2, FileVideo, ImagePlus, Loader2, RefreshCw, Trash2,
  Upload, X, Zap, ZapOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isNativeApp } from "@/lib/hms/native/platform";
import { pickNativePhotos, takeNativePhoto } from "@/lib/hms/native/media";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const HEIC_RE = /\.(heic|heif|avif)$/i;

export type MediaKind = "image" | "video";

export type PhotoUploadContext = {
  uploadId: string;
  signal: AbortSignal;
  onProgress: (pct: number) => void;
};

export type PhotoUploaderProps = {
  onUpload: (file: File, ctx: PhotoUploadContext) => Promise<unknown>;
  onUploaded?: () => void | Promise<void>;
  multiple?: boolean;
  maxBytes?: number;
  videoMaxBytes?: number;
  disabled?: boolean;
  className?: string;
  hint?: string;
  uploadLabel?: string;
  /** Whether video capture/upload is enabled. Defaults to true. */
  videoEnabled?: boolean;
};

type Staged = {
  key: string;
  uploadId: string;
  file: File;
  kind: MediaKind;
  previewUrl: string;
  status: "staged" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
};

function newUploadId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function validatePhoto(file: File, maxBytes: number): string | null {
  if (!file.size) return "This file is empty. Please choose another photo.";
  if (file.size > maxBytes) {
    return `Photo is too large. Maximum allowed size is ${Math.floor(maxBytes / (1024 * 1024))} MB.`;
  }
  if (HEIC_RE.test(file.name) || file.type === "image/heic" || file.type === "image/heif" || file.type === "image/avif") {
    return "HEIC/HEIF isn't supported. Set your phone camera to JPEG (Most Compatible) or choose another photo.";
  }
  if (file.type && !(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return "Unsupported file type. Please use a JPEG, PNG or WebP photo.";
  }
  return null;
}

function validateVideo(file: File, maxBytes: number): string | null {
  if (!file.size) return "This file is empty. Please choose another video.";
  if (file.size > maxBytes) {
    return `Video is too large. Maximum allowed size is ${Math.floor(maxBytes / (1024 * 1024))} MB.`;
  }
  if (file.type && !(VIDEO_TYPES as readonly string[]).includes(file.type)) {
    return "Unsupported video type. Please use MP4, MOV or WebM.";
  }
  return null;
}

function kindOf(file: File): MediaKind {
  return file.type.startsWith("video/") ? "video" : "image";
}

export function PhotoUploader({
  onUpload,
  onUploaded,
  multiple = true,
  maxBytes = DEFAULT_MAX_BYTES,
  videoMaxBytes = DEFAULT_VIDEO_MAX_BYTES,
  disabled = false,
  className,
  hint,
  uploadLabel = "Upload photo",
  videoEnabled = true,
}: PhotoUploaderProps) {
  const browseRef = useRef<HTMLInputElement>(null);
  const nativeCameraRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const stagedRef = useRef<Staged[]>([]);
  const abortRef = useRef(new Map<string, AbortController>());
  const [staged, setStaged] = useState<Staged[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);

  stagedRef.current = staged;

  useEffect(() => () => {
    for (const item of stagedRef.current) URL.revokeObjectURL(item.previewUrl);
    for (const ac of abortRef.current.values()) ac.abort();
  }, []);

  const addFiles = useCallback((files: File[]) => {
    if (disabled || files.length === 0) return;
    const chosen = multiple ? files : files.slice(0, 1);
    const next: Staged[] = [];
    for (const file of chosen) {
      const key = newUploadId();
      const kind = kindOf(file);
      const error = kind === "video" ? validateVideo(file, videoMaxBytes) : validatePhoto(file, maxBytes);
      next.push({
        key,
        uploadId: newUploadId(),
        file,
        kind,
        previewUrl: URL.createObjectURL(file),
        status: error ? "error" : "staged",
        progress: 0,
        error: error ?? undefined,
      });
    }
    setStaged((prev) => (multiple ? [...prev, ...next] : next));
  }, [disabled, maxBytes, videoMaxBytes, multiple]);

  const remove = useCallback((key: string) => {
    setStaged((prev) => {
      const item = prev.find((s) => s.key === key);
      if (item) URL.revokeObjectURL(item.previewUrl);
      abortRef.current.get(key)?.abort();
      abortRef.current.delete(key);
      return prev.filter((s) => s.key !== key);
    });
  }, []);

  const clearDone = useCallback(() => {
    setStaged((prev) => {
      for (const item of prev) if (item.status === "done") URL.revokeObjectURL(item.previewUrl);
      return prev.filter((s) => s.status !== "done");
    });
  }, []);

  const uploadOne = useCallback(async (item: Staged) => {
    setStaged((prev) => prev.map((s) => (s.key === item.key ? { ...s, status: "uploading", progress: 0, error: undefined } : s)));
    const ac = new AbortController();
    abortRef.current.set(item.key, ac);
    try {
      await onUpload(item.file, {
        uploadId: item.uploadId,
        signal: ac.signal,
        onProgress: (pct) => {
          setStaged((prev) => prev.map((s) => (s.key === item.key ? { ...s, progress: Math.max(0, Math.min(100, pct)) } : s)));
        },
      });
      setStaged((prev) => prev.map((s) => (s.key === item.key ? { ...s, status: "done", progress: 100 } : s)));
      return true;
    } catch (e) {
      if (ac.signal.aborted) {
        setStaged((prev) => prev.filter((s) => s.key !== item.key));
        return false;
      }
      setStaged((prev) => prev.map((s) => (
        s.key === item.key
          ? { ...s, status: "error", error: e instanceof Error ? e.message : "Upload failed. Please retry." }
          : s
      )));
      return false;
    } finally {
      abortRef.current.delete(item.key);
    }
  }, [onUpload]);

  const uploadPending = useCallback(async () => {
    const pending = stagedRef.current.filter((s) => s.status === "staged" || s.status === "error");
    if (pending.length === 0 || busy || disabled) return;
    setBusy(true);
    let any = false;
    for (const item of pending) {
      if (await uploadOne(item)) any = true;
    }
    setBusy(false);
    if (any) await onUploaded?.();
  }, [busy, disabled, onUploaded, uploadOne]);

  // Native shell: Capacitor Camera (system camera UI, correct EXIF rotation).
  // Browser: existing live preview, then the file-capture fallback.
  const openCamera = async () => {
    if (isNativeApp()) {
      setNativeError(null);
      try {
        const file = await takeNativePhoto();
        if (file) addFiles([file]);
      } catch (e) {
        setNativeError(e instanceof Error ? e.message : "The camera could not be opened.");
      }
      return;
    }
    const supported = typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
    if (supported) setCameraOpen(true);
    else nativeCameraRef.current?.click();
  };

  const choosePhotos = async () => {
    if (!isNativeApp()) {
      browseRef.current?.click();
      return;
    }
    setNativeError(null);
    try {
      addFiles(await pickNativePhotos(multiple));
    } catch (e) {
      setNativeError(e instanceof Error ? e.message : "Photos could not be selected.");
    }
  };

  const pendingCount = staged.filter((s) => s.status === "staged" || s.status === "error").length;
  const uploadingCount = staged.filter((s) => s.status === "uploading").length;
  const doneCount = staged.filter((s) => s.status === "done").length;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" className="min-h-[44px]" disabled={disabled || busy} onClick={() => void openCamera()}>
          <Camera className="h-4 w-4" aria-hidden /> Take Photo
        </Button>
        {videoEnabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-[44px]"
            disabled={disabled || busy}
            onClick={() => void videoInputRef.current?.click()}
          >
            <FileVideo className="h-4 w-4" aria-hidden /> Record Video
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-[44px]"
          disabled={disabled || busy}
          onClick={() => void choosePhotos()}
        >
          <ImagePlus className="h-4 w-4" aria-hidden /> {multiple ? "Choose Photos" : "Choose Photo"}
        </Button>
        {videoEnabled && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-[44px]"
            disabled={disabled || busy}
            onClick={() => void videoInputRef.current?.click()}
          >
            <ImagePlus className="h-4 w-4" aria-hidden /> {multiple ? "Choose Videos" : "Choose Video"}
          </Button>
        )}
        <input
          ref={browseRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple={multiple}
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose existing photos"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {videoEnabled && (
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm"
            multiple={multiple}
            className="sr-only"
            tabIndex={-1}
            aria-label="Choose existing videos"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        )}
        <input
          ref={nativeCameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-label="Open device camera"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) {
              addFiles([file]);
            }
          }}
        />
      </div>

      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {nativeError ? <p className="text-xs text-destructive" role="alert">{nativeError}</p> : null}

      {staged.length > 0 ? (
        <div className="space-y-2">
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Selected media">
            {staged.map((item) => (
              <li key={item.key} className="relative overflow-hidden rounded-lg border bg-muted/30">
                <div className="aspect-square relative">
                  {item.kind === "video" ? (
                    <video
                      src={item.previewUrl}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="none"
                      poster={item.previewUrl}
                    />
                  ) : (
                    <img src={item.previewUrl} alt={item.file.name} className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="flex items-center justify-between gap-1 border-t bg-card px-1.5 py-1">
                  <span className="min-w-0 truncate text-[10px] text-muted-foreground" title={item.file.name}>{item.file.name}</span>
                  {item.status === "uploading" ? <span className="shrink-0 text-[10px] tabular-nums">{item.progress}%</span> : null}
                  {item.status === "done" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Uploaded" /> : null}
                  {item.status === "error" ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" aria-label="Upload failed" /> : null}
                </div>
                {item.status === "uploading" ? (
                  <div className="absolute inset-x-0 bottom-0 h-1 bg-muted">
                    <div className="h-full bg-primary transition-all" style={{ width: `${item.progress}%` }} />
                  </div>
                ) : null}
                {item.status !== "uploading" ? (
                  <button
                    type="button"
                    onClick={() => remove(item.key)}
                    aria-label={`Remove ${item.file.name}`}
                    className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
                {item.status === "error" && item.error ? (
                  <p className="border-t bg-destructive/5 px-1.5 py-1 text-[10px] leading-tight text-destructive">{item.error}</p>
                ) : null}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="min-h-[44px]" disabled={disabled || busy || pendingCount === 0} onClick={() => void uploadPending()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
              {busy ? "Uploading…" : `${uploadLabel}${pendingCount > 1 ? ` (${pendingCount})` : ""}`}
            </Button>
            {uploadingCount > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-[44px]"
                onClick={() => {
                  for (const ac of abortRef.current.values()) ac.abort();
                }}
              >
                Cancel
              </Button>
            ) : null}
            {doneCount > 0 ? (
              <Button type="button" size="sm" variant="ghost" className="min-h-[44px]" onClick={clearDone}>
                <Trash2 className="h-4 w-4" aria-hidden /> Clear uploaded
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <CameraCaptureDialog
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => {
          addFiles([file]);
          setCameraOpen(false);
        }}
      />
    </div>
  );
}

// ── Live camera dialog ───────────────────────────────────────────────────────

export function CameraCaptureDialog({
  open,
  onClose,
  onCapture,
  title = "Take photo",
}: {
  open: boolean;
  onClose: () => void;
  onCapture: (file: File) => void;
  title?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotUrlRef = useRef<string | null>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string>("");
  const [torchOn, setTorchOn] = useState(false);
  const [canTorch, setCanTorch] = useState(false);
  const nativeOpenedRef = useRef(false);
  const captureRef = useRef(onCapture);
  const closeRef = useRef(onClose);
  captureRef.current = onCapture;
  closeRef.current = onClose;

  const stopStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchOn(false);
    setCanTorch(false);
  }, []);

  const start = useCallback(async (constraints: MediaStreamConstraints["video"]) => {
    stopStream();
    setError(null);
    setStarting(true);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("unsupported");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
      setCanTorch(!!caps?.torch);
      setActiveDeviceId(track?.getSettings().deviceId ?? "");
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      setDevices(list);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("Camera permission was denied. Allow camera access in your browser, or use your device camera below.");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No camera was found on this device. Use your device camera or choose an existing photo.");
      } else if (name === "NotReadableError") {
        setError("The camera is already in use by another app. Close it and try again.");
      } else if (e instanceof Error && e.message === "unsupported") {
        setError("Live camera preview isn't available in this browser. Use your device camera instead.");
      } else {
        setError("Could not start the camera. Use your device camera or choose an existing photo.");
      }
    } finally {
      setStarting(false);
    }
  }, [stopStream]);

  // Native shell: the system camera replaces the WebView preview (WebView
  // getUserMedia needs extra native permission plumbing and is less reliable).
  useEffect(() => {
    if (!open) {
      nativeOpenedRef.current = false;
      return;
    }
    if (!isNativeApp() || nativeOpenedRef.current) return;
    nativeOpenedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const file = await takeNativePhoto();
        if (cancelled) return;
        if (file) captureRef.current(file); else closeRef.current();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "The camera could not be opened.");
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) {
      stopStream();
      if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
      shotUrlRef.current = null;
      setShot(null);
      setError(null);
      setDevices([]);
      return;
    }
    if (isNativeApp()) return;
    void start({ facingMode: { ideal: "environment" } });
    return () => stopStream();
  }, [open, start, stopStream]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const switchCamera = async () => {
    if (devices.length < 2) return;
    const idx = devices.findIndex((d) => d.deviceId === activeDeviceId);
    const next = devices[(idx + 1) % devices.length];
    await start({ deviceId: { exact: next.deviceId } });
  };

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] } as unknown as MediaTrackConstraints);
      setTorchOn((v) => !v);
    } catch {
      setCanTorch(false);
    }
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setError("The camera is still starting. Try again in a moment.");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("Could not capture the photo. Use your device camera instead.");
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      setError("Could not capture the photo. Use your device camera instead.");
      return;
    }
    if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
    const url = URL.createObjectURL(blob);
    shotUrlRef.current = url;
    setShot({ blob, url });
    stopStream();
  };

  const retake = async () => {
    if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
    shotUrlRef.current = null;
    setShot(null);
    await start({ facingMode: { ideal: "environment" } });
  };

  const useShot = () => {
    if (!shot) return;
    const file = new File([shot.blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
    if (shotUrlRef.current) URL.revokeObjectURL(shotUrlRef.current);
    shotUrlRef.current = null;
    setShot(null);
    onCapture(file);
  };

  const close = () => {
    stopStream();
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <p className="text-sm font-medium">{title}</p>
          <button type="button" onClick={close} aria-label="Close camera" className="rounded-full p-1.5 hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative flex min-h-[240px] items-center justify-center bg-black">
          {shot ? (
            <img src={shot.url} alt="Captured preview" className="max-h-[65vh] w-full object-contain" />
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="max-h-[65vh] w-full object-contain" aria-label="Camera preview" />
          )}
          {starting && !shot ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
              <Loader2 className="h-6 w-6 animate-spin" aria-label="Starting camera" />
            </div>
          ) : null}
          {error && !shot ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-5 text-center">
              <AlertCircle className="h-7 w-7 text-amber-600" aria-hidden />
              <p className="max-w-md text-sm text-muted-foreground">{error}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => nativeRef.current?.click()}>
                  <Camera className="h-4 w-4" aria-hidden /> Use device camera
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={close}>Choose an existing photo</Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 border-t px-3 py-3">
          {shot ? (
            <>
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => void retake()}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Retake
              </Button>
              <Button type="button" className="min-h-[44px]" onClick={useShot}>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Use Photo
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" className="min-h-[44px]" onClick={close}>Cancel</Button>
              {canTorch ? (
                <Button type="button" variant="outline" size="icon" className="size-11" onClick={() => void toggleTorch()} aria-label={torchOn ? "Turn torch off" : "Turn torch on"}>
                  {torchOn ? <ZapOff className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
                </Button>
              ) : null}
              {devices.length > 1 ? (
                <Button type="button" variant="outline" size="icon" className="size-11" onClick={() => void switchCamera()} aria-label="Switch camera">
                  <RefreshCw className="h-4 w-4" />
                </Button>
              ) : null}
              <Button type="button" className="min-h-[44px] min-w-[130px]" disabled={starting || !!error} onClick={() => void capture()}>
                <Camera className="h-4 w-4" aria-hidden /> Capture
              </Button>
            </>
          )}
          <input
            ref={nativeRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            tabIndex={-1}
            aria-label="Use device camera"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) {
                close();
                onCapture(file);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
