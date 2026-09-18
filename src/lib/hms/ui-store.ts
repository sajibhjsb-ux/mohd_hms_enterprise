"use client";

// MOHD.HMS ENTERPRISE — UI store.
// activeModule: which module is mounted. pages: per-module "page route" as raw
// path segments ([] = list view, ["new"], [id], [id, "edit"], …) so every
// business form/detail lives on its own dedicated full page (no popup CRUD).
// The path router (lib/hms/router.ts) keeps pages in sync with the URL
// pathname so browser Back/Forward and direct URLs work.

import { create } from "zustand";

/** Empty segment list = the module's list page. */
export const LIST_SEG: string[] = [];

type UiState = {
  activeModule: string;
  setActiveModule: (m: string) => void;
  /** Current page per module as hash segments, e.g. complaints → ["CPT-1","edit"]. */
  pages: Record<string, string[]>;
  pageOf: (module: string) => string[];
  setPage: (module: string, seg: string[]) => void;
  /** Raw hash query string per module (KPI drill-down filters), e.g. "status=active". */
  queries: Record<string, string>;
  setQuery: (module: string, query: string) => void;
  /** True while ANY dedicated form page has unsaved changes — the shell guards navigation. */
  pageDirty: boolean;
  setPageDirty: (d: boolean) => void;
  /** QR deep link ({ type: module, token }) consumed by the target module. */
  deepLink: { type: string; token: string } | null;
  setDeepLink: (l: { type: string; token: string } | null) => void;
  consumeDeepLink: () => { type: string; token: string } | null;
  /** Open the shared Change Password dialog (header menu + profile page). */
  changePwOpen: boolean;
  setChangePwOpen: (o: boolean) => void;
};

export const useUi = create<UiState>((set, get) => ({
  activeModule: "dashboard",
  setActiveModule: (m) => set({ activeModule: m }),
  pages: {},
  pageOf: (module) => get().pages[module] ?? LIST_SEG,
  setPage: (module, seg) => set((s) => ({ pages: { ...s.pages, [module]: seg } })),
  queries: {},
  setQuery: (module, query) =>
    set((s) => ({ queries: { ...s.queries, [module]: query } })),
  pageDirty: false,
  setPageDirty: (d) => set({ pageDirty: d }),
  deepLink: null,
  setDeepLink: (l) => set({ deepLink: l }),
  consumeDeepLink: () => {
    const l = get().deepLink;
    if (l) set({ deepLink: null });
    return l;
  },
  changePwOpen: false,
  setChangePwOpen: (o) => set({ changePwOpen: o }),
}));
