"use client";

// MOHD.HMS ENTERPRISE — Files Back button (spec §2).
// Real navigation history: every in-app navigation pushes a browser history
// entry, so history.back() returns to the EXACT origin — the previous folder,
// a shared view, the file list — never a hardcoded Dashboard. Cold deep links
// (no in-app history, e.g. a bookmark opened in a new tab) fall back to the
// caller-provided module path. The browser's/PWA's native Back gesture keeps
// working independently (popstate is handled by the app shell).

import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasInAppHistory, navigateTo } from "@/lib/hms/router";

export function FilesBackButton({ fallback, label = "Back" }: { fallback: string[]; label?: string }) {
  const onBack = () => {
    if (hasInAppHistory()) {
      window.history.back();
      return;
    }
    navigateTo("files", fallback);
  };
  return (
    <Button variant="ghost" size="sm" onClick={onBack} aria-label={`Go back — ${label}`}>
      <ArrowLeft className="h-4 w-4 mr-1" aria-hidden /> {label}
    </Button>
  );
}
