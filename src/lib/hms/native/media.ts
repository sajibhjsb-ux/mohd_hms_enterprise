"use client";

// MOHD.HMS ENTERPRISE — native camera/gallery bridge (Capacitor Camera 8).
//
// Returns ordinary File objects, so every existing upload workflow keeps its
// own validation, staging preview, retry queue and authenticated API route.
// The plugin never uploads anything itself and never bypasses the web rules.

import { isNativeApp } from "./platform";

type NativeMedia = {
  type?: number;
  uri?: string;
  webPath?: string;
  metadata?: { format?: string; size?: number };
};

function isCancel(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err ?? "");
  return /cancel/i.test(text);
}

function friendlyError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err ?? "");
  if (/permission|denied|not authorized|restricted/i.test(text)) {
    return new Error("Camera or photo access was denied. Allow it in your device settings and try again.");
  }
  return new Error(text || "The camera could not be opened.");
}

async function toFile(media: NativeMedia): Promise<File> {
  const { Capacitor } = await import("@capacitor/core");
  const direct = media.webPath || "";
  const convert = () => (media.uri ? Capacitor.convertFileSrc(media.uri) : "");
  const src = direct && !direct.startsWith("file:") && !direct.startsWith("content:") ? direct : convert();
  if (!src) throw new Error("The camera returned no photo. Please try again.");
  let res = await fetch(src).catch(() => null);
  if ((!res || !res.ok) && convert() && convert() !== src) res = await fetch(convert());
  if (!res || !res.ok) throw new Error("The photo could not be read from the device.");
  const blob = await res.blob();
  if (!blob.size) throw new Error("The captured photo is empty. Please try again.");
  const format = (media.metadata?.format || blob.type.split("/")[1] || "jpg").toLowerCase();
  const ext = format === "jpeg" ? "jpg" : format;
  const type = blob.type || (ext === "png" ? "image/png" : "image/jpeg");
  return new File([blob], `photo-${Date.now()}.${ext}`, { type, lastModified: Date.now() });
}

/** Open the native camera. Returns null when the user cancels. */
export async function takeNativePhoto(): Promise<File | null> {
  if (!isNativeApp()) throw new Error("Native camera is not available here.");
  try {
    const { Camera, EncodingType, CameraDirection } = await import("@capacitor/camera");
    const photo = await Camera.takePhoto({
      quality: 90,
      encodingType: EncodingType.JPEG,
      correctOrientation: true,
      saveToGallery: false,
      cameraDirection: CameraDirection.Rear,
      includeMetadata: true,
    });
    return await toFile(photo as NativeMedia);
  } catch (err) {
    if (isCancel(err)) return null;
    throw friendlyError(err);
  }
}

/** Open the native gallery. Returns [] when the user cancels. */
export async function pickNativePhotos(multiple: boolean): Promise<File[]> {
  if (!isNativeApp()) throw new Error("Native gallery is not available here.");
  try {
    const { Camera, EncodingType, MediaTypeSelection } = await import("@capacitor/camera");
    const picked = await Camera.chooseFromGallery({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: multiple,
      limit: multiple ? 0 : 1,
      quality: 90,
      editable: "no",
      correctOrientation: true,
      includeMetadata: true,
    });
    const files: File[] = [];
    for (const media of picked.results ?? []) files.push(await toFile(media as NativeMedia));
    return files;
  } catch (err) {
    if (isCancel(err)) return [];
    throw friendlyError(err);
  }
}
