"use client";

// Shared profile-photo rendering. User.avatarUrl stores an OBJECT-STORAGE KEY
// (e.g. "avatars/{userId}/x.jpg"), served via the authenticated avatar API.
// Anything else (e.g. legacy external Google URLs once written by the Google
// callback) is NOT a photo reference — render the initials fallback instead of
// a dead <img>. onError is the safety net for a reference whose object was
// removed from the bucket.

import { useState } from "react";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/hms/format";

export function isAvatarRef(key: string | null | undefined): boolean {
  return !!key && key.startsWith("avatars/") && !key.includes("..") && !key.includes("//");
}

export function avatarUrlFor(key: string): string {
  return `/api/v1/profile/avatar?v=${encodeURIComponent(key)}`;
}

export function UserAvatar({ url, name, className }: { url: string | null | undefined; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!isAvatarRef(url) || failed) {
    return (
      <span className={cn("rounded-full bg-primary/10 text-primary font-semibold flex items-center justify-center", className)}>
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      src={avatarUrlFor(url as string)}
      alt=""
      className={cn("rounded-full object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}