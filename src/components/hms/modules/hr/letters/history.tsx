"use client";

// MOHD.HMS ENTERPRISE — Letter History (page, hr/letters/history, §29/§30).
// Full list with search + filters (type, status, date range) — every row links
// to the workspace; finalized letters download/preview their immutable PDF.

import { useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo, parsePath } from "@/lib/hms/router";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { PageShell } from "@/components/hms/shared/page-shell";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";
import { LETTER_STATUSES } from "@/lib/hms/constants";
import { LETTER_TYPES, letterTypeLabel, type LetterListItemDto } from "@/lib/hms/letters/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus } from "lucide-react";

type Filters = { status: string; letterType: string; from: string; to: string };

const readQueryPreset = (): Filters => {
  if (typeof window === "undefined") return { status: "ALL", letterType: "ALL", from: "", to: "" };
  const parsed = parsePath(window.location.pathname + window.location.search);
  const sp = new URLSearchParams(parsed?.query ?? "");
  const status = sp.get("status") ?? "ALL";
  const letterType = sp.get("letterType") ?? "ALL";
  return {
    status: (LETTER_STATUSES as readonly string[]).includes(status) ? status : "ALL",
    letterType: (LETTER_TYPES as readonly string[]).includes(letterType) ? letterType : "ALL",
    from: sp.get("from") ?? "",
    to: sp.get("to") ?? "",
  };
};

export function LetterHistoryPage() {
  const { user } = useSession();
  const canView = hasPerm(user, PERMISSIONS.letters_view);

  const [rows, setRows] = useState<LetterListItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(readQueryPreset);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .get<LetterListItemDto[]>(
        `/api/v1/hr/letters${qs({
          pageSize: "200",
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(filters.status !== "ALL" ? { status: filters.status } : {}),
          ...(filters.letterType !== "ALL" ? { letterType: filters.letterType } : {}),
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
        })}`
      )
      .then((res) => {
        if (!alive) return;
        setRows(res.data ?? []);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Unable to load letters.");
      });
    return () => {
      alive = false;
    };
  }, [search, filters, reloadTick]);

  const columns: Column<LetterListItemDto>[] = [
    { key: "number", header: "Letter No", value: (l) => l.letterNumber, className: "font-medium whitespace-nowrap font-mono text-xs" },
    { key: "type", header: "Type", value: (l) => l.letterType, render: (l) => <span className="text-xs">{letterTypeLabel(l.letterType)}</span> },
    { key: "recipient", header: "Recipient", value: (l) => l.recipientName || l.recipientCompany || "", render: (l) => (
      <span className="truncate block max-w-[180px]">{l.recipientName || l.recipientCompany || "—"}</span>
    ) },
    { key: "subject", header: "Subject", value: (l) => l.subject, render: (l) => <span className="truncate block max-w-[220px] text-muted-foreground">{l.subject || "—"}</span>, hideOnMobile: true },
    { key: "date", header: "Date", value: (l) => l.letterDate, render: (l) => <span className="whitespace-nowrap">{fmtDate(l.letterDate)}</span>, hideOnMobile: true },
    { key: "status", header: "Status", value: (l) => l.status, render: (l) => <StatusBadge status={l.status} /> },
    { key: "createdBy", header: "Created By", value: (l) => l.createdByName, hideOnMobile: true },
    { key: "approvedBy", header: "Approved By", value: (l) => l.approvedByName, render: (l) => l.approvedByName || <span className="text-muted-foreground">—</span>, hideOnMobile: true },
    {
      key: "actions", header: "", sortable: false,
      render: (l) => (
        <div className="flex items-center gap-1.5">
          {l.hasPdf ? <PdfButtons type="letter" id={l.id} label={l.letterNumber} iconOnly /> : null}
          <Button variant="outline" size="sm" onClick={() => navigateTo("hr", ["letters", l.id])} aria-label={`Open letter ${l.letterNumber}`}>
            Open
          </Button>
        </div>
      ),
    },
  ];

  if (!canView) {
    return (
      <PageShell backLabel="Back" backHref="/hr/letters" title="Letter History">
        <EmptyState title="Not authorized" hint="You need the letters.view permission." />
      </PageShell>
    );
  }

  return (
    <PageShell
      backLabel="Back to Letters"
      backHref="/hr/letters"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Letters", href: "/hr/letters" }, { label: "History" }]}
      title="Letter History"
      description="Every letter with its number, workflow state and final document."
      actions={
        <Button size="sm" variant="outline" onClick={() => navigateTo("hr", ["letters", "new"])}>
          <Plus className="h-4 w-4 mr-1.5" /> Create Letter
        </Button>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        <div className="col-span-2 md:col-span-1 space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
            <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {LETTER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s.replaceAll("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="col-span-2 md:col-span-1 space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={filters.letterType} onValueChange={(v) => setFilters((f) => ({ ...f, letterType: v }))}>
            <SelectTrigger aria-label="Filter by type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All types</SelectItem>
              {LETTER_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{letterTypeLabel(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="lf-from" className="text-xs">From</Label>
          <Input id="lf-from" type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="lf-to" className="text-xs">To</Label>
          <Input id="lf-to" type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => setReloadTick((t) => t + 1)} />
      ) : !rows ? (
        <LoadingState label="Loading letters…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No letters match"
          hint="Adjust the filters, or create a new letter."
          action={<Button size="sm" variant="outline" onClick={() => navigateTo("hr", ["letters", "new"])}><Plus className="h-4 w-4 mr-1.5" /> Create Letter</Button>}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(l) => l.id} searchPlaceholder="Search number, subject, recipient…" emptyTitle="No letters match" exportName="letters" />
      )}
    </PageShell>
  );
}
