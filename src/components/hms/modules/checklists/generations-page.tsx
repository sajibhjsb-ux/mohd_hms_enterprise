"use client";

// MOHD.HMS ENTERPRISE — AI generation log (spec §38/§80). Safe metadata only —
// prompts are never exposed, even to template managers.

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { humanize } from "@/lib/hms/constants";
import { Badge } from "@/components/ui/badge";

type GenRow = {
  id: string; sourceType: string; sourceId: string; workOrderId: string | null;
  templateId: string | null; templateVersion: number | null; promptVersion: number;
  provider: string; model: string; status: string; itemCount: number; error: string | null;
  contextSummary: string | null; instanceId: string | null; createdAt: string;
};

export function GenerationsPage() {
  const [rows, setRows] = useState<GenRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<GenRow[]>("/api/v1/checklists/generations" + qs({ pageSize: 100 }));
      setRows(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load the generation log.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <PageShell backLabel="Back to Checklists" backHref="/checklists" title="AI generation log" description="Metadata for every AI checklist generation across the platform.">
      {loading && !rows ? (
        <LoadingState label="Loading generation log…" rows={4} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState title="No generations yet" hint="AI checklist drafts will be logged here." />
      ) : (
        <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Items</th>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Prompt</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-b last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap text-xs">{new Date(g.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-2">{humanize(g.sourceType)}{g.workOrderId ? <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">WO{`…${g.workOrderId.slice(-6)}`}</span> : null}</td>
                  <td className="px-3 py-2"><Badge variant="outline" className="text-[10px]">{g.status}</Badge></td>
                  <td className="px-3 py-2 tabular-nums">{g.itemCount}</td>
                  <td className="px-3 py-2 text-xs">{g.provider} / {g.model}</td>
                  <td className="px-3 py-2 text-xs">v{g.promptVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}