// MOHD.HMS ENTERPRISE — CMS Pages list (§CMS).
// Admin UI for managing website pages: list, create, publish, unpublish,
// archive. Reuses the existing session + api-client patterns.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Check, Eye, Edit, Archive } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { useSession, hasPerm } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { navigateTo } from "@/lib/hms/router";

type PageRow = {
  id: string; slug: string; title: string; status: string;
  seoTitle: string; seoDescription: string; publishedAt: string | null;
  createdAt: string; updatedAt: string; _count: { revisions: number };
};

const STATUS_TONE: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
  DRAFT: "default", PUBLISHED: "secondary", ARCHIVED: "destructive",
};

export default function CmsPagesModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const [pages, setPages] = useState<PageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const canRead = hasPerm(user, PERMISSIONS.cms_pages_read);
  const canCreate = hasPerm(user, PERMISSIONS.cms_pages_create);
  const canPublish = hasPerm(user, PERMISSIONS.cms_pages_publish);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ pages: PageRow[] }>("/api/v1/cms/pages");
      setPages(res.data.pages);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load pages.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async (formData: FormData) => {
    const slug = String(formData.get("slug") || "").trim();
    const title = String(formData.get("title") || "").trim();
    if (!slug || !title) { toast({ title: "Slug and title are required." }); return; }
    try {
      const res = await api.post<{ page: PageRow }>("/api/v1/cms/pages", {
        slug, title, content: { blocks: [] },
      });
      setOpenCreate(false);
      void load();
      toast({ title: "Page created", description: `${res.data.page.title} is a draft.` });
    } catch (e) {
      toast({ title: "Create failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handlePublish = async (id: string) => {
    try {
      await api.post(`/api/v1/cms/pages/${id}/publish`);
      void load();
      toast({ title: "Published", description: "The page is now live on the public website." });
    } catch (e) {
      toast({ title: "Publish failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleUnpublish = async (id: string) => {
    try {
      await api.post(`/api/v1/cms/pages/${id}/unpublish`);
      void load();
      toast({ title: "Unpublished", description: "The page is now a draft and removed from the public website." });
    } catch (e) {
      toast({ title: "Unpublish failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleArchive = async (id: string) => {
    try {
      await api.del(`/api/v1/cms/pages/${id}`);
      setConfirmId(null);
      void load();
      toast({ title: "Archived" });
    } catch (e) {
      toast({ title: "Archive failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!canRead) return <ErrorState message="You do not have permission to view CMS pages." />;
  if (loading) return <LoadingState label="Loading pages…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="space-y-4">
      <PageHeader title="Website Pages" subtitle="Build and publish public website pages with the visual page builder." />
      <div className="flex items-center gap-2">
        {canCreate && (
          <Button onClick={() => setOpenCreate(true)}><Plus /> New page</Button>
        )}
      </div>

      {openCreate && (
        <Dialog open={openCreate} onOpenChange={setOpenCreate}>
          <DialogContent>
            <DialogTitle>Create page</DialogTitle>
            <DialogDescription>Give the page a slug (URL-friendly) and a title. It starts as a draft.</DialogDescription>
            <form onSubmit={(e) => { e.preventDefault(); handleCreate(new FormData(e.currentTarget)); }} className="space-y-3 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>Slug</Label>
                  <Input placeholder="about-us" name="slug" required maxLength={120} />
                </div>
                <div className="space-y-1">
                  <Label>Title</Label>
                  <Input placeholder="About us" name="title" required maxLength={200} />
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpenCreate(false)}>Cancel</Button>
                <Button type="submit">Create</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pages</CardTitle>
          <CardDescription>{pages.length} page{pages.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          {pages.length === 0 ? (
            <EmptyState title="No pages yet" hint="Create your first page to start building the public website." action={
              canCreate ? <Button onClick={() => setOpenCreate(true)}>Create page</Button> : null
            } />
          ) : (
            <div className="divide-y">
              {pages.map((p) => (
                <div key={p.id} className="p-4 flex items-center justify-between group hover:bg-muted/50">
                  <div className="flex items-center gap-3 min-w-0">
                    <Button variant="ghost" size="sm" onClick={() => navigateTo(`/cms/pages/${p.id}/edit`)}>
                      <Edit className="w-4 h-4" /> {p.title}
                    </Button>
                    <p className="text-sm text-muted-foreground truncate max-w-xs">{p.slug}</p>
                    <p className="text-xs text-muted-foreground">{p._count.revisions} revision{p._count.revisions !== 1 ? "s" : ""}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_TONE[p.status] ?? "default"}>{p.status}</Badge>
                    {p.status === "PUBLISHED" ? (
                      <Button variant="ghost" size="sm" onClick={() => handleUnpublish(p.id)}><Eye /> Unpublish</Button>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => handlePublish(p.id)}><Check /> Publish</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setConfirmId(p.id)}><Archive /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {confirmId && (
        <Dialog open={!!confirmId} onOpenChange={(v) => !v && setConfirmId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Archive page?</DialogTitle>
              <DialogDescription>Archiving removes the page from the list. It can be restored later.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirmId(null)}>Cancel</Button>
              <Button type="button" onClick={() => handleArchive(confirmId!)}>Archive</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
