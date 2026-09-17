"use client";

import { create } from "zustand";

type UiState = {
  activeModule: string;
  deepLink: { type: string; token: string } | null;
  consumeDeepLink: () => { type: string; token: string } | null;
  setActiveModule: (m: string) => void;
  setDeepLink: (l: { type: string; token: string } | null) => void;
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
}));
