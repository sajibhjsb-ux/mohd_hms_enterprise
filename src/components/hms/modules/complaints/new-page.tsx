"use client";

// MOHD.HMS ENTERPRISE — dedicated Complaint Entry page (complaints/new view).
// Replaces the old "New Complaint" modal as the primary complaint entry mechanism.
// Reuses the existing Complaint API, RBAC, workflow, numbering, audit and draft
// architecture — no duplicate tables, no duplicate APIs, no mock data.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import {
  PageHeader, EmptyState,
} from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, PRIORITIES, humanize } from "@/lib/hms/constants";
import { customerLabel, fmtDateTime } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertCircle, ArrowLeft, Camera, CheckCircle2, ChevronRight, CircleUserRound, FileVideo, ImagePlus,
  Loader2, MapPin, RefreshCw, Save, Send, Trash2, Upload, User, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CameraCaptureDialog } from "@/components/hms/shared/photo-capture";

// ── Types ──

type CustomerOpt = {
  id: string;
  companyName?: string;
  name?: string;
  contactPerson?: string;
  phone?: string;
  code?: string;
};

type EquipmentOpt = {
  id: string;
  name?: string;
  assetTag?: string;
  location?: { id: string; name?: string | null; code?: string | null } | null;
  customer?: { id: string; companyName?: string; code?: string } | null;
};

type CreateForm = {
  title: string;
  description: string;
  priority: string;
  customerId: string;
  equipmentId: string;
  workCatalogue: string;
  catalogueIssue: string;
};

const EMPTY_CREATE: CreateForm = {
  title: "",
  description: "",
  priority: "MEDIUM",
  customerId: "",
  equipmentId: "",
  workCatalogue: "",
  catalogueIssue: "",
};

// §12/§13 — master-data catalogue pulls its OWN issue list (catalogue-specific
// dynamic lists — never a flat global list).
type CatalogueOpt = {
  id: string;
  code: string;
  name: string;
  issues: { id: string; name: string }[];
};
const TITLE_MAX = 200;
const DESC_MAX = 5000;

// ── Page ──

export function ComplaintNewPage() {
  const { user, refresh } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const isStaffUser = !!user && user.role !== "CUSTOMER";
  const canCreate = hasPerm(user, PERMISSIONS.complaints_create);

  const draft = useDraft<CreateForm>({ formKey: "complaint.create", initial: EMPTY_CREATE });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [beforeBusy, setBeforeBusy] = useState(false);

  type BeforeFile = {
    key: string;
    file: File;
    kind: "image" | "video";
    previewUrl: string;
    status: "staged" | "uploading" | "done" | "error";
    progress: number;
    error?: string;
    uploadId: string;
  };
  const [beforeFiles, setBeforeFiles] = useState<BeforeFile[]>([]);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  // ── Customer search (API-backed, never loads the whole table) ──
  const [custQuery, setCustQuery] = useState("");
  const [custResults, setCustResults] = useState<CustomerOpt[]>([]);
  const [custLoading, setCustLoading] = useState(false);
  const [custOpen, setCustOpen] = useState(false);
  const [custInitialDone, setCustInitialDone] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOpt | null>(null);
  const [portalCustomerName, setPortalCustomerName] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const selectedId = isStaffUser ? draft.value.customerId : (user?.customerId ?? "");

  // Initial page of customers (20) for staff — search narrows server-side from
  // there. customersOnly=1: backend returns genuine customer accounts only, so
  // records mirroring staff logins can never appear or be picked.
  useEffect(() => {
    if (!isStaffUser) return;
    let alive = true;
    setCustLoading(true);
    api.get<CustomerOpt[]>(`/api/v1/customers${qs({ pageSize: 20, customersOnly: 1 })}`)
      .then((r) => { if (alive) { setCustResults(Array.isArray(r.data) ? r.data : []); setCustInitialDone(true); } })
      .catch(() => { if (alive) setCustInitialDone(true); })
      .finally(() => { if (alive) setCustLoading(false); });
    return () => { alive = false; };
  }, [isStaffUser]);

  // Debounced server-side search while typing (≥2 chars); empty query restores the initial page.
  useEffect(() => {
    if (!isStaffUser) return;
    const q = custQuery.trim();
    if (q.length < 2) {
      if (custInitialDone && custQuery === "") {
        let alive = true;
        setCustLoading(true);
        api.get<CustomerOpt[]>(`/api/v1/customers${qs({ pageSize: 20, customersOnly: 1 })}`)
          .then((r) => { if (alive) setCustResults(Array.isArray(r.data) ? r.data : []); })
          .catch(() => undefined)
          .finally(() => { if (alive) setCustLoading(false); });
        return () => { alive = false; };
      }
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(() => {
      setCustLoading(true);
      api.get<CustomerOpt[]>(`/api/v1/customers${qs({ search: q, pageSize: 20, customersOnly: 1 })}`)
        .then((r) => { if (alive(seq)) setCustResults(Array.isArray(r.data) ? r.data : []); })
        .catch(() => { if (alive(seq)) setCustResults([]); })
        .finally(() => { if (alive(seq)) setCustLoading(false); });
    }, 300);
    function alive(s: number) { return s === searchSeq.current; }
    return () => clearTimeout(t);
  }, [custQuery, custInitialDone, isStaffUser]);

  // Portal users file under their own customer record — show its name for clarity.
  useEffect(() => {
    if (isStaffUser || !user?.customerId) return;
    let alive = true;
    api.get<CustomerOpt[]>("/api/v1/customers")
      .then((r) => {
        if (!alive) return;
        const own = Array.isArray(r.data) ? r.data[0] : undefined;
        if (own) setPortalCustomerName(own.companyName ?? own.name ?? null);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [isStaffUser, user?.customerId]);

  // BUGFIX: after a draft restores customerId (component-local display state is
  // lost on reload), re-fetch the customer record so the selection card renders.
  useEffect(() => {
    if (!isStaffUser) return;
    const cid = draft.value.customerId;
    if (!cid || selectedCustomer?.id === cid) return;
    let alive = true;
    api.get<CustomerOpt[]>(`/api/v1/customers${qs({ customerId: cid, customersOnly: 1 })}`)
      .then((r) => {
        if (!alive) return;
        const c = Array.isArray(r.data) ? r.data.find((x) => x.id === cid) : undefined;
        if (c) {
          setSelectedCustomer(c);
          setCustQuery(c.companyName ?? c.name ?? c.id);
        }
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [draft.value.customerId, isStaffUser, selectedCustomer?.id]);

  // ── Equipment follows the selected customer (server-filtered) ──
  const [equipment, setEquipment] = useState<EquipmentOpt[]>([]);
  const [equipLoading, setEquipLoading] = useState(false);
  const [equipLoaded, setEquipLoaded] = useState(false);

  useEffect(() => {
    if (!canCreate) return;
    if (isStaffUser && !selectedId) { setEquipment([]); setEquipLoaded(true); return; }
    let alive = true;
    setEquipLoading(true);
    setEquipLoaded(false);
    api.get<EquipmentOpt[]>(`/api/v1/equipment${qs({ customerId: selectedId || undefined, pageSize: 200 })}`)
      .then((r) => {
        if (!alive) return;
        const list = Array.isArray(r.data) ? r.data : [];
        setEquipment(list);
        // Portal UX: derive the caller's own customer name from the equipment payload
        // (customers lack customers.read by design — no extra API, no RBAC change).
        if (!isStaffUser) {
          const ownName = list.find((e) => e.customer?.companyName)?.customer?.companyName;
          if (ownName) setPortalCustomerName(ownName);
        }
      })
      .catch(() => { if (alive) setEquipment([]); })
      .finally(() => { if (alive) { setEquipLoading(false); setEquipLoaded(true); } });
    return () => { alive = false; };
  }, [selectedId, isStaffUser, canCreate]);

  const selectedEquipment = useMemo(
    () => equipment.find((e) => e.id === draft.value.equipmentId) ?? null,
    [equipment, draft.value.equipmentId]
  );

  // ── Work Catalogue (§12/§13) — master data with catalogue-specific issue lists ──
  const [catalogues, setCatalogues] = useState<CatalogueOpt[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCatLoading(true);
    api.get<CatalogueOpt[]>("/api/v1/work-catalogues")
      .then((r) => { if (alive) setCatalogues(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setCatError("Could not load the work catalogue. Please retry."); })
      .finally(() => { if (alive) setCatLoading(false); });
    return () => { alive = false; };
  }, []);

  const selectedCatalogue = useMemo(
    () => catalogues.find((c) => c.code === draft.value.workCatalogue) ?? null,
    [catalogues, draft.value.workCatalogue]
  );
  const catalogueIssues = useMemo(() => selectedCatalogue?.issues ?? [], [selectedCatalogue]);

  function pickCatalogue(code: string) {
    draft.setValue({ workCatalogue: code, catalogueIssue: "" });
    setErrors((p) => { const { workCatalogue: _a, catalogueIssue: _b, ...rest } = p; return rest; });
  }

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  function goBackToList() {
    draft.saveNow(); // silent protection — never lose typed data when leaving via Back
    navigateTo("complaints");
  }

  function saveDraft() {
    draft.saveNow();
    toast({ title: "Draft saved successfully", description: "You can safely leave this page and restore the draft later." });
  }

  function pickCustomer(c: CustomerOpt) {
    setSelectedCustomer(c);
    setCustQuery(c.companyName ?? c.name ?? c.id);
    setCustOpen(false);
    draft.setValue({ customerId: c.id, equipmentId: "" });
    setErrors((prev) => { const { customerId: _drop, ...rest } = prev; return rest; });
  }

  function clearCustomer() {
    setSelectedCustomer(null);
    setCustQuery("");
    draft.setValue({ customerId: "", equipmentId: "" });
  }

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    const t = draft.value.title.trim();
    if (!t) errs.title = "Title is required.";
    else if (t.length < 3) errs.title = "Title must be at least 3 characters.";
    const d = draft.value.description.trim();
    if (!d) errs.description = "Description is required.";
    else if (d.length < 3) errs.description = "Description must be at least 3 characters.";
    if (isStaffUser && !draft.value.customerId) errs.customerId = "Please select a customer.";
    if (!draft.value.workCatalogue) errs.workCatalogue = "Please select a work catalogue.";
    if (!draft.value.catalogueIssue) errs.catalogueIssue = "Please select the catalogue issue.";
    return errs;
  }

  function addBeforeFiles(files: File[]) {
    if (files.length === 0) return;
    const next: BeforeFile[] = files.map((file) => ({
      key: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      file,
      kind: file.type.startsWith("video/") ? "video" : "image",
      previewUrl: URL.createObjectURL(file),
      status: "staged",
      progress: 0,
      uploadId: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    }));
    setBeforeFiles((prev) => [...prev, ...next]);
  }

  function removeBeforeFile(key: string) {
    setBeforeFiles((prev) => {
      const item = prev.find((f) => f.key === key);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((f) => f.key !== key);
    });
  }

  function useShot() {
    if (!shot) return;
    const file = new File([shot.blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" });
    if (shot.url) URL.revokeObjectURL(shot.url);
    setShot(null);
    setCameraOpen(false);
    addBeforeFiles([file]);
  }

  async function uploadBeforeFiles(complaintId: string): Promise<void> {
    const pending = beforeFiles.filter((f) => f.status === "staged" || f.status === "error");
    if (pending.length === 0) return;
    setBeforeBusy(true);
    try {
      for (const file of pending) {
        setBeforeFiles((prev) => prev.map((f) => (f.key === file.key ? { ...f, status: "uploading", progress: 0, error: undefined } : f)));
        const fd = new FormData();
        fd.append("file", file.file);
        fd.append("phase", "BEFORE");
        fd.append("uploadId", file.uploadId);
        try {
          const res = await api.postForm<{ id: string }>(`/api/v1/complaints/${complaintId}/media`, fd);
          setBeforeFiles((prev) => prev.map((f) => (f.key === file.key ? { ...f, status: "done", progress: 100 } : f)));
          // Idempotent retry: if the server already had this uploadId, it returns the existing record.
          void res;
        } catch (e) {
          setBeforeFiles((prev) => prev.map((f) => (f.key === file.key ? { ...f, status: "error", error: e instanceof Error ? e.message : "Upload failed. Please retry." } : f)));
        }
      }
    } finally {
      setBeforeBusy(false);
    }
  }

  async function createComplaint() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast({ title: "Check the highlighted fields", variant: "destructive" });
      return;
    }
    // §1 — never submit a complaint with evidence still uploading or failed.
    const unsaved = beforeFiles.some((f) => f.status !== "done");
    if (beforeFiles.length > 0 && unsaved) {
      toast({ title: "Evidence still uploading", description: "Please wait for all photos/videos to finish uploading, or retry failed files.", variant: "destructive" });
      return;
    }
    setCreating(true);
    setSubmitError(null);
    try {
      const payload: Record<string, unknown> = {
        title: draft.value.title.trim(),
        description: draft.value.description.trim(),
        priority: draft.value.priority,
        workCatalogue: draft.value.workCatalogue,
        catalogueIssue: draft.value.catalogueIssue,
        ...(isStaffUser && draft.value.customerId ? { customerId: draft.value.customerId } : {}),
        ...(draft.value.equipmentId ? { equipmentId: draft.value.equipmentId } : {}),
      };
      const res = await api.post<{ id: string; code: string }>("/api/v1/complaints", payload);
      const complaintId = res.data.id;

      // Upload BEFORE evidence linked to the new complaint before navigating away.
      if (beforeFiles.length > 0) {
        setCreating(true);
        await uploadBeforeFiles(complaintId);
        const failed = beforeFiles.some((f) => f.status === "error");
        if (failed) {
          toast({ title: "Some evidence failed to upload", description: "The complaint was created but not all evidence was stored. Retry failed files on the complaint page.", variant: "destructive" });
        } else {
          toast({ title: "Complaint created", description: `${res.data.code} logged with ${beforeFiles.length} evidence file${beforeFiles.length === 1 ? "" : "s"}.` });
        }
      } else {
        toast({ title: "Complaint created", description: `${res.data.code} logged successfully.` });
      }
      draft.reset(EMPTY_CREATE);
      setSelectedCustomer(null);
      setCustQuery("");
      setBeforeFiles([]);
      setPageDirty(false);
      navigateTo("complaints", [complaintId]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not create the complaint. Please try again.";
      if (e instanceof ClientApiError && e.code === "PROFILE_INCOMPLETE") {
        toast({ title: "Profile completion required", description: msg, variant: "destructive" });
        void refresh();
        navigateTo("profile", ["complete"]);
        return;
      }
      setSubmitError(msg);
      toast({ title: "Could not create complaint", description: msg, variant: "destructive" });
    } finally {
      setCreating(false);
      setBeforeBusy(false);
    }
  }

  if (!canCreate) {
    return (
      <EmptyState
        title="You don't have permission to create complaints"
        hint="Complaint creation is limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  // ── Profile completion gate (spec §10/§11) ──
  // UX hint on top of the backend-authoritative guard; stale sessions are
  // still caught server-side with the PROFILE_INCOMPLETE code (handled below).
  const profileIncomplete = !isStaffUser && user?.profileComplete === false;
  if (profileIncomplete) {
    return (
      <div className="max-w-xl mx-auto py-6">
        <Card className="border-amber-200 bg-amber-50/60">
          <CardHeader className="pb-2 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center" aria-hidden>
              <AlertCircle className="h-6 w-6" />
            </div>
            <CardTitle className="text-base mt-2">Service requests are locked until your profile is complete</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-sm text-muted-foreground">
              Please complete your mobile number and address before requesting a service.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <Button onClick={() => navigateTo("profile", ["complete"])}>
                <CircleUserRound className="h-4 w-4 mr-1.5" aria-hidden /> Complete Profile
              </Button>
              <Button variant="outline" onClick={() => navigateTo("complaints")}>
                Back to Complaints
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const actions = (
    <>
      <Button variant="outline" onClick={saveDraft} disabled={creating}>
        <Save className="h-4 w-4 mr-1.5" /> Save Draft
      </Button>
      <Button onClick={createComplaint} disabled={creating}>
        {creating ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
        {creating ? "Creating…" : "Create Complaint"}
      </Button>
    </>
  );

  return (
    <div>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="mb-2">
        <ol className="flex items-center gap-1 text-sm text-muted-foreground">
          <li>
            <button
              onClick={goBackToList}
              className="hover:text-foreground hover:underline underline-offset-2 rounded"
            >
              Complaints
            </button>
          </li>
          <li aria-hidden><ChevronRight className="h-3.5 w-3.5" /></li>
          <li aria-current="page" className="text-foreground font-medium">New Complaint</li>
        </ol>
      </nav>

      {/* Back link */}
      <button
        onClick={goBackToList}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors rounded"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden /> Back to Complaints
      </button>

      <PageHeader
        title="New Complaint"
        subtitle={isStaffUser ? "Log a complaint on behalf of a customer." : "Report an issue — our team will assign a technician."}
        actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
      />

      {/* Recoverable draft banner */}
      {draft.draftExists ? (
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm">
          <span className="text-muted-foreground">
            Unsubmitted draft saved {draft.lastSavedAt ? fmtDateTime(draft.lastSavedAt) : "earlier"} — restore it to continue where you left off.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={draft.restore}>Restore</Button>
            <Button size="sm" variant="ghost" onClick={draft.discard}>Discard</Button>
          </div>
        </div>
      ) : null}

      {submitError ? (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">The complaint could not be created.</p>
            <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-5">
        {/* ── Complaint information ── */}
        <Card className="xl:col-span-3 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Complaint Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="nc-title">Title *</Label>
                <span className="text-[11px] text-muted-foreground tabular-nums">{draft.value.title.trim().length}/{TITLE_MAX}</span>
              </div>
              <Input
                id="nc-title"
                value={draft.value.title}
                onChange={(e) => { draft.setValue({ title: e.target.value }); setErrors((p) => ({ ...p, title: "" })); }}
                placeholder="Short summary of the issue — e.g. Air Conditioning Unit Not Cooling"
                maxLength={TITLE_MAX}
                aria-invalid={!!errors.title}
                aria-describedby={errors.title ? "nc-title-err" : undefined}
              />
              {errors.title ? <p id="nc-title-err" className="text-xs text-destructive">{errors.title}</p> : null}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="nc-desc">Description *</Label>
                <span className="text-[11px] text-muted-foreground tabular-nums">{draft.value.description.trim().length}/{DESC_MAX}</span>
              </div>
              <Textarea
                id="nc-desc"
                value={draft.value.description}
                onChange={(e) => { draft.setValue({ description: e.target.value }); setErrors((p) => ({ ...p, description: "" })); }}
                placeholder={"Describe the problem, location and impact…\n\nExample: Air conditioning unit in Level 2 meeting room is not cooling properly. Temperature remains above normal operating level."}
                rows={7}
                maxLength={DESC_MAX}
                aria-invalid={!!errors.description}
                aria-describedby={errors.description ? "nc-desc-err" : undefined}
                className="min-h-[9rem]"
              />
              {errors.description ? <p id="nc-desc-err" className="text-xs text-destructive">{errors.description}</p> : null}
            </div>

            <div className="space-y-1.5 sm:max-w-xs">
              <Label>Priority</Label>
              <Select value={draft.value.priority} onValueChange={(v) => draft.setValue({ priority: v })}>
                <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Defaults to Medium — the server enforces the same priority scale.</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="nc-catalogue">Work catalogue *</Label>
                <Select value={draft.value.workCatalogue} onValueChange={pickCatalogue} disabled={catLoading}>
                  <SelectTrigger id="nc-catalogue" aria-label="Work catalogue">
                    <SelectValue placeholder={catLoading ? "Loading catalogue…" : "Select catalogue"} />
                  </SelectTrigger>
                  <SelectContent>
                    {catalogues.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.name} ({c.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.workCatalogue ? <p className="text-xs text-destructive">{errors.workCatalogue}</p> : null}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="nc-issue">Catalogue issue *</Label>
                <Select
                  value={draft.value.catalogueIssue}
                  onValueChange={(v) => { draft.setValue({ catalogueIssue: v }); setErrors((p) => { const { catalogueIssue: _d, ...rest } = p; return rest; }); }}
                  disabled={!draft.value.workCatalogue}
                >
                  <SelectTrigger id="nc-issue" aria-label="Catalogue issue">
                    <SelectValue placeholder={
                      catLoading ? "Loading…"
                        : !draft.value.workCatalogue ? "Select a catalogue first"
                          : catalogueIssues.length === 0 ? "No issues configured" : "Select issue"
                    } />
                  </SelectTrigger>
                  <SelectContent>
                    {catalogueIssues.map((i) => (
                      <SelectItem key={i.id || i.name} value={i.name}>{i.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.catalogueIssue ? <p className="text-xs text-destructive">{errors.catalogueIssue}</p> : null}
              </div>
            </div>
            {catError ? <p className="text-xs text-destructive">{catError}</p> : null}
            <p className="text-[11px] text-muted-foreground">The catalogue classifies the work; the issue is specific to the selected catalogue.</p>

            {/* §1 — BEFORE WORK evidence: customer captures the problem before submitting. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="nc-before-evidence">Before Work — Customer Evidence *optional*</Label>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {beforeFiles.length} file{beforeFiles.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Upload photos or videos showing the reported problem. Evidence is locked once the complaint is submitted.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="min-h-[44px]"
                  disabled={creating || beforeBusy}
                  onClick={() => setCameraOpen(true)}
                >
                  <Camera className="h-4 w-4 mr-1" aria-hidden /> Take Photo
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={creating || beforeBusy}
                  onClick={() => photoInputRef.current?.click()}
                >
                  <ImagePlus className="h-4 w-4 mr-1" aria-hidden /> Choose Photos
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={creating || beforeBusy}
                  onClick={() => videoInputRef.current?.click()}
                >
                  <FileVideo className="h-4 w-4 mr-1" aria-hidden /> Choose Videos
                </Button>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose existing photos"
                  onChange={(e) => {
                    addBeforeFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-label="Choose existing videos"
                  onChange={(e) => {
                    addBeforeFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
              </div>

              {shot && (
                <div className="rounded-lg border bg-muted/30 p-2">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs font-medium">Captured preview</span>
                    <Button size="sm" variant="outline" onClick={() => setShot(null)}>Cancel</Button>
                  </div>
                  <img src={shot.url} alt="Captured" className="h-32 w-48 object-cover rounded" />
                  <Button size="sm" onClick={useShot} className="mt-1">
                    <CheckCircle2 className="h-4 w-4 mr-1" aria-hidden /> Use Photo
                  </Button>
                </div>
              )}

              {beforeFiles.length > 0 ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {beforeFiles.map((f) => (
                      <div key={f.key} className="relative overflow-hidden rounded-lg border bg-muted/30">
                        <div className="aspect-square relative">
                          {f.kind === "video" ? (
                            <video
                              src={f.previewUrl}
                              className="h-full w-full object-cover"
                              muted
                              playsInline
                              preload="none"
                            />
                          ) : (
                            <img src={f.previewUrl} alt={f.file.name} className="h-full w-full object-cover" />
                          )}
                          {f.status === "uploading" && (
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                              <Loader2 className="h-5 w-5 animate-spin text-white" />
                            </div>
                          )}
                          {f.status === "done" && (
                            <div className="absolute right-1 top-1 bg-emerald-600 rounded-full p-1">
                              <CheckCircle2 className="h-3 w-3 text-white" aria-hidden />
                            </div>
                          )}
                          {f.status === "error" && (
                            <div className="absolute right-1 top-1 bg-destructive rounded-full p-1">
                              <X className="h-3 w-3 text-white" aria-hidden />
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-1 border-t bg-card px-1.5 py-1">
                          <span className="min-w-0 truncate text-[10px] text-muted-foreground" title={f.file.name}>
                            {f.file.name}
                          </span>
                          {f.status === "error" ? (
                            <span className="text-[10px] text-destructive">failed</span>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeBeforeFile(f.key)}
                          aria-label={`Remove ${f.file.name}`}
                          className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
                        >
                          <X className="h-3 w-3" />
                        </button>
                        {f.error && (
                          <p className="border-t bg-destructive/5 px-1.5 py-1 text-[10px] leading-tight text-destructive">
                            {f.error}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  {beforeBusy && (
                    <p className="text-xs text-muted-foreground">Uploading evidence…</p>
                  )}
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* ── Customer & asset ── */}
        <div className="xl:col-span-2 space-y-4">
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Customer &amp; Asset</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isStaffUser ? (
                <div className="space-y-1.5">
                  <Label htmlFor="nc-customer">Customer *</Label>
                  {selectedCustomer ? (
                    <div className="flex items-start justify-between gap-2 rounded-lg border bg-muted/30 p-3">
                      <div className="min-w-0 text-sm">
                        <p className="font-medium truncate">{customerLabel(selectedCustomer)}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[selectedCustomer.contactPerson, selectedCustomer.phone, selectedCustomer.code ? `#${selectedCustomer.code}` : ""].filter(Boolean).join(" · ") || "—"}
                        </p>
                      </div>
                      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={clearCustomer} aria-label="Clear selected customer">
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Input
                        id="nc-customer"
                        role="combobox"
                        aria-expanded={custOpen}
                        aria-controls="nc-customer-list"
                        aria-autocomplete="list"
                        autoComplete="off"
                        value={custQuery}
                        onChange={(e) => { setCustQuery(e.target.value); setCustOpen(true); }}
                        onFocus={() => setCustOpen(true)}
                        onKeyDown={(e) => { if (e.key === "Escape") setCustOpen(false); }}
                        placeholder="Search customer by name, contact or code…"
                        aria-invalid={!!errors.customerId}
                        aria-describedby={errors.customerId ? "nc-customer-err" : undefined}
                      />
                      {custLoading ? <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
                      {custOpen ? (
                        <>
                          <div className="fixed inset-0 z-30" onClick={() => setCustOpen(false)} aria-hidden />
                          <div
                            id="nc-customer-list"
                            role="listbox"
                            aria-label="Customer results"
                            className="absolute z-40 mt-1 w-full max-h-60 overflow-y-auto hms-scroll rounded-md border bg-background shadow-md"
                          >
                            {custLoading && custResults.length === 0 ? (
                              <p className="px-3 py-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading customers…</p>
                            ) : custResults.length === 0 ? (
                              <p className="px-3 py-4 text-sm text-muted-foreground">No customers match “{custQuery.trim()}”.</p>
                            ) : (
                              custResults.map((c) => (
                                <button
                                  key={c.id}
                                  type="button"
                                  role="option"
                                  aria-selected={false}
                                  onClick={() => pickCustomer(c)}
                                  className="w-full text-left px-3 py-2 hover:bg-accent focus:bg-accent focus:outline-none border-b last:border-0"
                                >
                                  <span className="block text-sm font-medium truncate">{customerLabel(c)}</span>
                                  <span className="block text-xs text-muted-foreground truncate">
                                    {[c.contactPerson, c.phone, c.code ? `#${c.code}` : ""].filter(Boolean).join(" · ") || "\u00A0"}
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}
                  {errors.customerId ? <p id="nc-customer-err" className="text-xs text-destructive">{errors.customerId}</p> : null}
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
                  <User className="h-4 w-4 mt-0.5 text-primary shrink-0" aria-hidden />
                  <div>
                    <p className="font-medium">{portalCustomerName ?? "Your account"}</p>
                    <p className="text-xs text-muted-foreground">This complaint will be filed under your own customer record. You cannot file on behalf of another customer.</p>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="nc-equipment">Equipment</Label>
                <Select
                  value={draft.value.equipmentId}
                  onValueChange={(v) => { draft.setValue({ equipmentId: v }); }}
                  disabled={isStaffUser && !selectedId}
                >
                  <SelectTrigger id="nc-equipment" aria-label="Equipment">
                    <SelectValue placeholder={
                      isStaffUser && !selectedId
                        ? "Select a customer first…"
                        : equipLoading
                          ? "Loading equipment…"
                          : equipLoaded && equipment.length === 0
                            ? "No equipment"
                            : "Optional — pick the equipment…"
                    } />
                  </SelectTrigger>
                  <SelectContent>
                    {equipment.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name ?? e.id}{e.assetTag ? ` (${e.assetTag})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {equipLoading ? (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading equipment…</p>
                ) : isStaffUser && !selectedId ? (
                  <p className="text-xs text-muted-foreground">Equipment options appear once a customer is selected.</p>
                ) : equipLoaded && equipment.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No equipment found for this customer.</p>
                ) : null}
              </div>

              {/* Location — read-only, from the existing equipment → location relationship */}
              {selectedEquipment?.location ? (
                <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
                  <MapPin className="h-4 w-4 mt-0.5 text-primary shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Location (from equipment record)</p>
                    <p className="font-medium truncate">{selectedEquipment.location.name ?? "—"}{selectedEquipment.location.code ? ` · ${selectedEquipment.location.code}` : ""}</p>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="shadow-sm bg-muted/20">
            <CardContent className="p-4 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground text-sm">What happens next?</p>
              <p>On creation the complaint gets a unique number (CPT-…) and enters the standard workflow: <span className="font-medium">New → Assigned → In Progress → Completed → Confirmed → Closed</span>.</p>
              <p>Supervisors and admins are notified automatically. Technician assignment happens from the complaint details — responsibilities stay separated.</p>
              {/* Terms reference (spec §24) — canonical page, new tab so the form
                  state (and its autosaved draft) is never lost. */}
              <p className="pt-1 border-t">
                By submitting this request you confirm the information provided is accurate and accept our{" "}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
                >
                  Terms &amp; Conditions
                </a>
                .
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Autosave hint */}
      <p className="mt-3 text-xs text-muted-foreground">
        {draft.dirty
          ? "Draft auto-saves as you type — safe to leave and restore later."
          : draft.lastSavedAt
            ? `Draft saved at ${fmtDateTime(draft.lastSavedAt)}.`
            : "Tip: use Save Draft to keep incomplete entries for later."}
      </p>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          <Button variant="outline" className="flex-1 min-w-0 px-2 text-xs min-[360px]:text-sm" onClick={saveDraft} disabled={creating}>
            <Save className="h-4 w-4 mr-1.5 shrink-0" /> Save Draft
          </Button>
          <Button className="flex-1 min-w-0 px-2 text-xs min-[360px]:text-sm" onClick={createComplaint} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 mr-1.5 shrink-0 animate-spin" /> : <Send className="h-4 w-4 mr-1.5 shrink-0" />}
            {creating ? "Creating…" : "Create Complaint"}
          </Button>
        </div>
      </div>

      {/* Camera capture dialog for BEFORE evidence */}
      <CameraCaptureDialog
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => {
          addBeforeFiles([file]);
          setCameraOpen(false);
        }}
      />

      {/* Live camera shot preview */}
      {shot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label="Captured preview">
          <button
            type="button"
            onClick={() => setShot(null)}
            aria-label="Close preview"
            className="absolute right-3 top-3 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="relative max-h-[70vh] w-full max-w-3xl overflow-hidden rounded-xl bg-background shadow-2xl">
            <img src={shot.url} alt="Captured preview" className="max-h-full max-w-full object-contain" />
          </div>
          <div className="border-t p-3 text-xs text-muted-foreground flex justify-between items-center gap-2">
            <span className="truncate font-medium text-foreground">Captured photo</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setShot(null)}>
                <RefreshCw className="h-4 w-4 mr-1" aria-hidden /> Retake
              </Button>
              <Button size="sm" onClick={useShot}>
                <CheckCircle2 className="h-4 w-4 mr-1" aria-hidden /> Use Photo
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
