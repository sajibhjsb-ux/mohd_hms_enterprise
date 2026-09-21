"use client";

// MOHD.HMS ENTERPRISE — Files module shared types + display helpers.

import {
  File as FileIcon, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText,
  FileVideo, Folder as FolderIcon, FileCode,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type FileRow = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  checksum?: string;
  currentVersion?: number;
  createdAt?: string;
  updatedAt?: string;
  ownerId?: string;
  owner?: { id: string; name: string } | null;
  permission?: string;
  expiresAt?: string | null;
  sharedBy?: { id: string; name: string } | null;
  sharedAt?: string;
  trashedAt?: string | null;
  originalFolderId?: string | null;
};

export type FolderRow = {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  ownerId?: string;
  owner?: { id: string; name: string } | null;
  permission?: string;
  expiresAt?: string | null;
  sharedBy?: { id: string; name: string } | null;
  trashedAt?: string | null;
};

export type Crumb = { id: string; name: string; parentId?: string | null };

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function extOfName(name: string): string {
  const m = /\.[A-Za-z0-9]{1,12}$/.exec(name);
  return m ? m[0].slice(1).toLowerCase() : "";
}

/** File-type icon by name/MIME (compact tables §58). */
export function fileIcon(name: string, mime?: string | null): LucideIcon {
  const ext = extOfName(name);
  const m = mime ?? "";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return FileImage;
  if (m.startsWith("video/") || ["mp4", "webm", "avi", "mov"].includes(ext)) return FileVideo;
  if (m.startsWith("audio/") || ["mp3", "ogg", "wav", "m4a"].includes(ext)) return FileAudio;
  if (m === "application/pdf" || ext === "pdf") return FileText;
  if (["xlsx", "xls", "csv"].includes(ext) || m.includes("spreadsheet")) return FileSpreadsheet;
  if (["doc", "docx", "txt", "md", "rtf"].includes(ext) || m.startsWith("text/")) return FileText;
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext) || m.includes("zip") || m.includes("rar")) return FileArchive;
  if (["js", "ts", "json", "html", "css"].includes(ext)) return FileCode;
  return FileIcon;
}

export const folderIcon = FolderIcon;

/** Actions the granted permission level allows (VIEW ⊆ DOWNLOAD ⊆ EDIT ⊆ MANAGE). */
export const PERM_RANK: Record<string, number> = { VIEW: 0, DOWNLOAD: 1, EDIT: 2, MANAGE: 3 };
export function permAtLeast(level: string | undefined | null, need: keyof typeof PERM_RANK): boolean {
  if (!level) return false;
  return (PERM_RANK[level] ?? -1) >= PERM_RANK[need];
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
