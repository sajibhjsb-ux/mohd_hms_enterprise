"use client";

// MOHD.HMS ENTERPRISE — Files dashboard (§5). REAL PostgreSQL aggregates from
// /api/v1/files/dashboard — no simulated metrics. Quick navigation into every
// Files section + recent uploads and real activity.

import { useCallback, useEffect, useState } from "react";
import {
  Activity, Clock, CloudUpload, FolderOpen, FolderInput, Share2, Star,
  Trash2, Upload, Users,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { LoadingState, ErrorState, PageHeader, StatCard } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { navigateTo } from "@/lib/hms/router";
import { fileIcon, fmtBytes, when } from "./shared";

type Dashboard = {
  totals: {
    files: number; folders: number; usedBytes: number; quotaBytes: number; quotaMb: number;
    sharedWithMe: number; sharedFolders: number; starred: number; trash: number; uploadQueue: number;
  };
  recentUploads: { id: string; name: string; sizeBytes: number; mimeType: string; createdAt: string }[];
  recentActivity: { id: string; action: string; name: string; at: string; resourceId: string }[];
};

function humanizeAction(action: string): string {
  return action.replace(/^FILE_|^FOLDER_|^UPLOAD_/, "").toLowerCase().replace(/_/g, " ");
}

export function FilesDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Dashboard>("/api/v1/files/dashboard");
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the Files dashboard.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading Files dashboard…" />;
  if (error || !data) return <ErrorState message={error ?? "Unknown error."} onRetry={() => void load()} />;

  const t = data.totals;
  const usedPct = t.quotaBytes > 0 ? Math.min(100, (t.usedBytes / t.quotaBytes) * 100) : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Files"
        subtitle="Your centralized private file space — upload, organize, share and track documents"
        actions={
          <Button onClick={() => navigateTo("files", ["upload"])}>
            <Upload className="h-4 w-4 mr-1.5" /> Upload
          </Button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard title="My Files" value={t.files} icon={<CloudUpload className="h-4 w-4" />} onClick={() => navigateTo("files", ["my"])} />
        <StatCard title="My Folders" value={t.folders} icon={<FolderOpen className="h-4 w-4" />} onClick={() => navigateTo("files", ["my"])} />
        <StatCard title="Shared With Me" value={t.sharedWithMe + t.sharedFolders} icon={<Share2 className="h-4 w-4" />} onClick={() => navigateTo("files", ["shared"])} />
        <StatCard title="Starred" value={t.starred} icon={<Star className="h-4 w-4" />} onClick={() => navigateTo("files", ["starred"])} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Storage (§5/§29 — authoritative backend numbers) */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Storage</CardTitle>
            <CardDescription>
              {fmtBytes(t.usedBytes)} used of {fmtBytes(t.quotaBytes)} — quotas are enforced by the backend on every upload.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={usedPct} aria-label={`Storage ${usedPct.toFixed(1)}% used`} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <div className="rounded-lg border p-2.5">
                <p className="text-xs text-muted-foreground">Available</p>
                <p className="font-semibold tabular-nums">{fmtBytes(Math.max(0, t.quotaBytes - t.usedBytes))}</p>
              </div>
              <div className="rounded-lg border p-2.5">
                <p className="text-xs text-muted-foreground">In Trash</p>
                <p className="font-semibold tabular-nums">{t.trash}</p>
              </div>
              <div className="rounded-lg border p-2.5">
                <p className="text-xs text-muted-foreground">Upload queue</p>
                <p className="font-semibold tabular-nums">{t.uploadQueue}</p>
              </div>
              <div className="rounded-lg border p-2.5">
                <p className="text-xs text-muted-foreground">Shared folders</p>
                <p className="font-semibold tabular-nums">{t.sharedFolders}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick sections */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Browse</CardTitle>
            <CardDescription>Every view is authorization-scoped server-side.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2 text-sm">
            {[
              { label: "My Files", seg: ["my"], icon: FolderOpen },
              { label: "Shared With Me", seg: ["shared"], icon: Users },
              { label: "Shared Folders", seg: ["shared-folders"], icon: FolderInput },
              { label: "Recent", seg: ["recent"], icon: Clock },
              { label: "Starred", seg: ["starred"], icon: Star },
              { label: "Trash", seg: ["trash"], icon: Trash2 },
              { label: "Activity", seg: ["activity"], icon: Activity },
            ].map(({ label, seg, icon: Icon }) => (
              <button
                key={label}
                onClick={() => navigateTo("files", seg)}
                className="flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left hover:bg-muted/50 transition-colors"
              >
                <Icon className="h-4 w-4 text-primary" aria-hidden />
                <span className="font-medium">{label}</span>
              </button>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recently uploaded (§5) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recently uploaded</CardTitle>
            <CardDescription>Your five newest files.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.recentUploads.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing uploaded yet — start with the Upload page.</p>
            ) : (
              data.recentUploads.map((f) => {
                const Icon = fileIcon(f.name, f.mimeType);
                return (
                  <button
                    key={f.id}
                    onClick={() => navigateTo("files", ["file", f.id])}
                    className="flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="font-medium truncate flex-1">{f.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{fmtBytes(f.sizeBytes)}</span>
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Recent activity (§24/§25 — real audit data) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent activity</CardTitle>
            <CardDescription>From the real audit trail — last 7 days.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 max-h-72 overflow-y-auto">
            {data.recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet.</p>
            ) : (
              data.recentActivity.map((a) => (
                <div key={a.id} className="flex items-baseline gap-2 text-sm border-b pb-1.5 last:border-0">
                  <span className="font-medium capitalize">{humanizeAction(a.action)}</span>
                  <span className="text-muted-foreground truncate flex-1">{a.name || a.resourceId.slice(0, 8) + "…"}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{when(a.at)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
