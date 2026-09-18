"use client";

// MOHD.HMS ENTERPRISE — KPI drill-down query hook.
//
// Dashboard KPI cards navigate to feature pages with hash query params
// (e.g. /complaints?status=active). The shell parses the query on every
// hashchange and stores it per module (ui-store queries). List pages use this
// hook to read + validate those params, apply them as initial filters, and
// render/refresh filter chips (see DrilldownChips in shared/ui-bits).

import { useCallback, useMemo } from "react";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, parseQueryParams } from "@/lib/hms/router";

export type ModuleQuery = {
  /** Raw query string exactly as it appears in the hash ("" when none). */
  raw: string;
  /** Parsed params (empty object when no query). */
  params: Record<string, string>;
  /** True when the URL carried at least one param. */
  hasQuery: boolean;
  /**
   * Navigate back to this module's list merging/removing params.
   * `undefined` (or "") removes the key; an empty object clears everything.
   */
  apply: (next: Record<string, string | undefined>) => void;
  /** Navigate to the unfiltered module list (/module). */
  clear: () => void;
};

export function useModuleQuery(module: string): ModuleQuery {
  const raw = useUi((s) => s.queries[module] ?? "");
  const params = useMemo(() => parseQueryParams(raw), [raw]);

  const apply = useCallback(
    (next: Record<string, string | undefined>) => {
      const merged: Record<string, string> = { ...params };
      for (const [k, v] of Object.entries(next)) {
        if (v === undefined || v === "") delete merged[k];
        else merged[k] = v;
      }
      navigateTo(module, [], Object.keys(merged).length ? merged : undefined);
    },
    [module, params]
  );

  const clear = useCallback(() => navigateTo(module), [module]);

  return { raw, params, hasQuery: raw.length > 0, apply, clear };
}
