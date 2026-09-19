"use client";

// MOHD.HMS ENTERPRISE — Realtime React hooks.
// useRealtimeEvent(types, handler): subscribe to specific server events.
//   • Targeted cache invalidation (STEP 19): subscribers pass only the event
//     types that affect their view — never "refetch the world".
//   • Draft/unsaved-form safety (STEP 36): while a page form is dirty the
//     automatic refetch is suppressed so live updates can never clobber user
//     input; the next navigation/save reconciles from the authoritative DB.
// useRealtimeResync(handler): refetch the active view after a reconnect.

import { useEffect, useRef } from "react";
import { onRealtimeEvents, onRealtimeResync, type RealtimeEvent } from "./bus";
import { useUi } from "@/lib/hms/ui-store";

export function useRealtimeEvent(types: string[], handler: (ev: RealtimeEvent) => void): void {
  const handlerRef = useRef(handler);
  const key = types.join("|");

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const off = onRealtimeEvents(types, (payload) => {
      // STEP 36: never destroy unsaved user input with a background refresh.
      if (useUi.getState().pageDirty) return;
      handlerRef.current(payload as RealtimeEvent);
    });
    return off;
  }, [key]);
}

export function useRealtimeResync(handler: () => void): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(
    () => onRealtimeResync(() => handlerRef.current()),
    []
  );
}

/** Debounced wildcard subscription — used by the dashboard KPI panel (STEP 35). */
export function useRealtimeEventDebounced(types: string[], handler: () => void, debounceMs = 800): void {
  const handlerRef = useRef(handler);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = types.join("|");

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const off = onRealtimeEvents(types, () => {
      if (useUi.getState().pageDirty) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => handlerRef.current(), debounceMs);
    });
    return () => {
      off();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, debounceMs]);
}
