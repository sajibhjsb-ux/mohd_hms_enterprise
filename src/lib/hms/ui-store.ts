"use client";

import { create } from "zustand";

type UiState = {
  activeModule: string;
  deepLink: { type: string; token: string } | null;
  consumeDeepLink: () => { type: string; token: string } | null;
  setActiveModule: (m: string) => void;
  setDeepLink: (l: { type: string; token: string } | null) => void;
  /** Complaints module sub-view: "list" (default) or "new" (dedicated entry page). */
  complaintsView: "list" | "new";
  setComplaintsView: (v: "list" | "new") => void;
  /** When set, the complaints list opens the detail dialog for this complaint id (e.g. right after creation). */
  complaintsFocusId: string | null;
  setComplaintsFocusId: (id: string | null) => void;
  /** True while the complaint entry form has unsaved changes — the shell guards module switches. */
  complaintFormDirty: boolean;
  setComplaintFormDirty: (d: boolean) => void;
};

export const useUi = create<UiState>((set, get) => ({
  activeModule: "dashboard",
  deepLink: null,
  consumeDeepLink: () => {
    const l = get().deepLink;
    if (l) set({ deepLink: null });
    return l;
  },
  setActiveModule: (m) => set({ activeModule: m }),
  setDeepLink: (l) => set({ deepLink: l }),
  complaintsView: "list",
  setComplaintsView: (v) => set({ complaintsView: v }),
  complaintsFocusId: null,
  setComplaintsFocusId: (id) => set({ complaintsFocusId: id }),
  complaintFormDirty: false,
  setComplaintFormDirty: (d) => set({ complaintFormDirty: d }),
}));
