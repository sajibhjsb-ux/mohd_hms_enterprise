"use client";

// MOHD.HMS ENTERPRISE — Draft protection (mandatory enterprise feature).
// FORM → DIRTY STATE → DEBOUNCED DRAFT SAVE (localStorage + safe server draft)
//                     → UNEXPECTED INTERRUPTION → RESTORE DRAFT.
// Never store passwords or authentication secrets in drafts.

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/hms/api-client";

export type DraftOptions<T> = {
  formKey: string;       // unique per form, e.g. "complaint.create"
  initial: T;
  onSave?: (draft: T) => void; // when the draft is auto-saved
  restoreOnMount?: boolean;
};

export type DraftState<T> = {
  value: T;
  setValue: (patch: Partial<T>) => void;
  dirty: boolean;
  draftExists: boolean;
  restore: () => void;
  discard: () => void;
  reset: (next: T) => void;
  lastSavedAt: Date | null;
  /** Explicitly flush the current form state to localStorage + server draft backup right now. */
  saveNow: () => void;
};

/**
 * Debounced local-draft autosave with server backup.
 * - `value` always reflects current form state (never resets on remount).
 * - Draft is restored only with explicit user consent (restore()).
 */
export function useDraft<T extends object>(opts: DraftOptions<T>): DraftState<T> {
  const { formKey, initial } = opts;
  const localKey = `hms:draft:${formKey}`;
  const [value, setFull] = useState<T>(initial);
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(opts);
  const valueRef = useRef<T>(initial);
  useEffect(() => {
    optsRef.current = opts;
  });
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Load an existing draft once (client-only; never auto-overwrites user typing)
  const [savedDraft, setSavedDraft] = useState<T | null>(() => {
    try {
      const raw = localStorage.getItem(localKey);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch { /* ignore corrupt drafts */
      return null;
    }
  });
  const [draftExists, setDraftExists] = useState<boolean>(() => savedDraft !== null);

  function persist(data: T) {
    try {
      localStorage.setItem(localKey, JSON.stringify(data));
    } catch { /* storage full/unavailable */ }
    // Safe server-side draft backup (best-effort, silent failure)
    api.post("/api/v1/drafts", { formKey, data: JSON.stringify(data) }).catch(() => undefined);
    setLastSavedAt(new Date());
    optsRef.current.onSave?.(data);
  }

  function schedule(data: T) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(data), 1200);
  }

  function setValue(patch: Partial<T>) {
    setFull((prev) => {
      const next = { ...prev, ...patch };
      setDirty(true);
      schedule(next);
      return next;
    });
  }

  function restore() {
    if (savedDraft) {
      setFull({ ...initial, ...savedDraft });
      setDirty(true);
      setDraftExists(false);
      setSavedDraft(null);
    }
  }

  function discard() {
    try { localStorage.removeItem(localKey); } catch { /* noop */ }
    api.del(`/api/v1/drafts?formKey=${encodeURIComponent(formKey)}`).catch(() => undefined);
    setSavedDraft(null);
    setDraftExists(false);
    setDirty(false);
    setLastSavedAt(null);
  }

  function reset(next: T) {
    if (timer.current) clearTimeout(timer.current);
    try { localStorage.removeItem(localKey); } catch { /* noop */ }
    api.del(`/api/v1/drafts?formKey=${encodeURIComponent(formKey)}`).catch(() => undefined);
    setSavedDraft(null);
    setDraftExists(false);
    setDirty(false);
    setLastSavedAt(null);
    setFull(next);
  }

  /** Explicit flush: cancel the pending debounce and persist the current state now. */
  function saveNow() {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    persist(valueRef.current);
    setDirty(false);
  }

  // Warn on accidental navigation while dirty (browser-level protection)
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return { value, setValue, dirty, draftExists, restore, discard, reset, lastSavedAt, saveNow };
}

/** Route-leave guard for in-app navigation while a form is dirty. */
export function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onPop = () => {
      const leave = window.confirm("You have unsaved changes. Leave anyway?\nYour draft has been auto-saved and can be restored.");
      if (!leave) history.pushState(null, "", location.href);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [dirty]);
}
