"use client";

// MOHD.HMS ENTERPRISE — IRMS full-page report builder (NEW + EDIT).
//
// Routes: /irms/reports/new           → IrmsReportBuilder (new)
//         /irms/reports/{id}/edit     → IrmsReportBuilder (edit)
//
// 5 shadcn Tabs per the contract: DETAILS / WORK DETAILS / PHOTOS / SIGNATURES /
// APPROVAL. NEW reports keep PHOTOS/SIGNATURES/APPROVAL as friendly
// "save the report first" panels. Data comes from GET /api/v1/irms/meta
// (contract §13). Project/work-order/equipment selects auto-fill (§7 spec);
// AI ASSIST (§10) previews generated text in a Dialog and only inserts on
// explicit confirm — never auto-overwrites. useDraft autosave per contract
// form keys ("irms.report.builder.new" | "irms.report.builder.{id}") with the
// central dirty guard (§56). Server errors keep every value (no fake success §67).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { toDateInput, fmtDateTime } from "@/lib/hms/format";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState, PriorityBadge, StatusBadge } from "@/components/hms/shared/ui-bits";
import { humanize, PERMISSIONS, PRIORITIES } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertCircle, BadgeCheck, Bot, Building2, CheckCheck, ClipboardList, FileSignature,
  FileText, Images, Loader2, PenTool, Plus, Save, Send, Trash2, Undo2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IrmsPhotoManager } from "./irms-photo-manager";
import { IrmsSignaturePanel } from "./irms-signature-pad";

// ── Constants / types ──

const REPORT_TYPES = ["ROUTINE", "SAFETY", "EQUIPMENT", "PROJECT", "OTHER"];
const CONDITIONS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"];
const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const EDITABLE_STATUSES = ["DRAFT", "REJECTED"];

type FindingDraft = { finding: string; severity: string; recommendation: string };

type FormState = {
  projectId: string;
  workOrderId: string;
  equipmentId: string;
  inspectorId: string;
  title: string;
  type: string;
  priority: string;
  inspectionDate: string;
  overallCondition: string;
  summary: string;
  recommendations: string;
  customerVisible: boolean;
  jobOrderNo: string;
  building: string;
  floor: string;
  room: string;
  taskDescription: string;
  scope: string;
  notes: string;
  correctiveActions: string;
  rootCause: string;
  safetyNotes: string;
  materials: string;
  labourHours: string;
  completionPercent: number;
  findings: FindingDraft[];
};

const EMPTY_FORM: FormState = {
  projectId: "", workOrderId: "", equipmentId: "", inspectorId: "",
  title: "", type: "ROUTINE", priority: "MEDIUM", inspectionDate: "", overallCondition: "GOOD",
  summary: "", recommendations: "", customerVisible: false,
  jobOrderNo: "", building: "", floor: "", room: "",
  taskDescription: "", scope: "", notes: "", correctiveActions: "", rootCause: "", safetyNotes: "", materials: "",
  labourHours: "0", completionPercent: 0,
  findings: [],
};

type IrmsMeta = {
  projects: { id: string; code: string; name: string; customerId: string | null; customer?: { companyName: string } | null; siteLocation?: string | null }[];
  workOrders: { id: string; code: string; title: string; description?: string | null; equipmentId?: string | null; equipment?: { name: string; assetTag: string } | null }[];
  equipment: { id: string; name: string; assetTag: string; serialNumber?: string | null; manufacturer?: string | null; model?: string | null; category?: string | null; location?: { name: string } | null }[];
  customers: { id: string; companyName: string }[];
  inspectors: { id: string; employeeNo: string; user: { name: string } }[];
};

type EditDetail = {
  id: string;
  code: string;
  title: string;
  status: string;
  type: string;
  priority?: string | null;
  inspectionDate: string | null;
  overallCondition?: string | null;
  summary?: string | null;
  recommendations?: string | null;
  customerVisible?: boolean;
  jobOrderNo?: string | null;
  building?: string | null;
  floor?: string | null;
  room?: string | null;
  taskDescription?: string | null;
  scope?: string | null;
  notes?: string | null;
  correctiveActions?: string | null;
  rootCause?: string | null;
  safetyNotes?: string | null;
  materials?: string | null;
  labourHours?: number | null;
  completionPercent?: number | null;
  projectId?: string;
  equipmentId?: string | null;
  workOrderId?: string | null;
  inspectorId?: string | null;
  project?: { id: string; code: string; name: string } | null;
  equipment?: { id: string; name: string; assetTag: string } | null;
  inspector?: { id: string; user?: { name?: string | null } | null } | null;
  findings: { id: string; finding: string; severity: string; recommendation?: string | null }[];
};

// AI assist field map (§10): form field → API field.
const AI_FIELDS = [
  { formField: "summary", apiField: "summary", label: "Summary" },
  { formField: "correctiveActions", apiField: "correctiveAction", label: "Corrective actions" },
  { formField: "recommendations", apiField: "recommendation", label: "Recommendations" },
  { formField: "rootCause", apiField: "rootCause", label: "Root cause" },
  { formField: "safetyNotes", apiField: "safetyNotes", label: "Safety notes" },
] as const;
type AIField = (typeof AI_FIELDS)[number];

function readSavedDraft(formKey: string): FormState | null {
  try {
    const raw = localStorage.getItem(`hms:draft:${formKey}`);
    return raw ? (JSON.parse(raw) as FormState) : null;
  } catch {
    return null;
  }
}

function valuesFromDetail(d: EditDetail): FormState {
  return {
    ...EMPTY_FORM,
    projectId: d.projectId ?? "",
    workOrderId: d.workOrderId ?? "",
    equipmentId: d.equipmentId ?? "",
    inspectorId: d.inspectorId ?? "",
    title: d.title ?? "",
    type: d.type || "ROUTINE",
    priority: d.priority || "MEDIUM",
    inspectionDate: toDateInput(d.inspectionDate),
    overallCondition: d.overallCondition || "GOOD",
    summary: d.summary ?? "",
    recommendations: d.recommendations ?? "",
    customerVisible: !!d.customerVisible,
    jobOrderNo: d.jobOrderNo ?? "",
    building: d.building ?? "",
    floor: d.floor ?? "",
    room: d.room ?? "",
    taskDescription: d.taskDescription ?? "",
    scope: d.scope ?? "",
    notes: d.notes ?? "",
    correctiveActions: d.correctiveActions ?? "",
    rootCause: d.rootCause ?? "",
    safetyNotes: d.safetyNotes ?? "",
    materials: d.materials ?? "",
    labourHours: String(d.labourHours ?? 0),
    completionPercent: Number(d.completionPercent ?? 0),
    findings: (d.findings ?? []).map((f) => ({ finding: f.finding, severity: f.severity || "MEDIUM", recommendation: f.recommendation ?? "" })),
  };
}

// ── Component ──

export function IrmsReportBuilder({ reportId }: { reportId?: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const moduleQuery = useModuleQuery("irms");

  const isNew = !reportId;
  const canCreate = hasPerm(user, PERMISSIONS.irms_create);
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  const formKey = reportId ? `irms.report.builder.${reportId}` : "irms.report.builder.new";
  const draft = useDraft<FormState>({ formKey, initial: EMPTY_FORM });

  const [meta, setMeta] = useState<IrmsMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [detail, setDetail] = useState<EditDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(isNew ? false : true);

  const [tab, setTab] = useState("details");
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState<FormState | null>(null);

  // AI assist dialog state
  const [aiField, setAiField] = useState<AIField | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiText, setAiText] = useState("");

  // Project combobox open state
  const [projOpen, setProjOpen] = useState(false);

  const initRef = useRef(false);

  // ── Meta ──
  const loadMeta = useCallback(async () => {
    setMetaError(null);
    try {
      const res = await api.get<IrmsMeta>("/api/v1/irms/meta");
      setMeta(res.data);
    } catch (e) {
      setMeta(null);
      setMetaError(e instanceof Error ? e.message : "Reference data is unavailable.");
    }
  }, []);

  useEffect(() => { void loadMeta(); }, [loadMeta]);

  // ── Edit-mode load ──
  const loadDetail = useCallback(async () => {
    if (!reportId) return;
    setInitializing(true);
    setLoadError(null);
    try {
      const res = await api.get<EditDetail>(`/api/v1/irms/reports/${reportId}`);
      if (!EDITABLE_STATUSES.includes(res.data.status)) {
        toast({
          title: "This report can no longer be edited",
          description: `Status is ${humanize(res.data.status)} — opening the read-only view.`,
        });
        navigateTo("irms", ["reports", reportId]);
        return;
      }
      setDetail(res.data);
      if (!initRef.current) {
        initRef.current = true;
        draft.reset(valuesFromDetail(res.data));
        setSavedDraft(readSavedDraft(formKey));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this report.");
    } finally {
      setInitializing(false);
    }
     
  }, [reportId, formKey]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // ── NEW: prefill inspection date from calendar deep link (/irms/reports/new?date=…) ──
  useEffect(() => {
    if (reportId) return;
    const d = moduleQuery.params.date;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !draft.value.inspectionDate) {
      draft.setValue({ inspectionDate: d });
    }
     
  }, []);

  // ── Inspector default = own profile (name match), non-managers cannot change ──
  useEffect(() => {
    if (!meta || draft.value.inspectorId) return;
    const mine = meta.inspectors.find((i) => i.user?.name === user?.name);
    if (mine) draft.setValue({ inspectorId: mine.id });
     
  }, [meta]);

  // ── Dirty wiring (§56 central guard) ──
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  const v = draft.value;
  const set = draft.setValue;

  const selectedProject = useMemo(() => meta?.projects.find((p) => p.id === v.projectId) ?? null, [meta, v.projectId]);
  const selectedWO = useMemo(() => meta?.workOrders.find((w) => w.id === v.workOrderId) ?? null, [meta, v.workOrderId]);
  const selectedEquipment = useMemo(() => meta?.equipment.find((e) => e.id === v.equipmentId) ?? null, [meta, v.equipmentId]);

  // ── Auto-fill handlers ──
  const onProjectSelect = (id: string) => {
    set({ projectId: id });
  };

  const onWorkOrderSelect = (id: string) => {
    const wo = meta?.workOrders.find((w) => w.id === id) ?? null;
    if (!wo) {
      set({ workOrderId: "" });
      return;
    }
    set({
      workOrderId: id,
      jobOrderNo: wo.code,
      taskDescription: v.taskDescription.trim() ? v.taskDescription : (wo.description ?? ""),
      equipmentId: v.equipmentId || wo.equipmentId || "",
    });
  };

  // ── Findings rows ──
  const addFinding = () => set({ findings: [...v.findings, { finding: "", severity: "MEDIUM", recommendation: "" }] });
  const updateFinding = (idx: number, patch: Partial<FindingDraft>) =>
    set({ findings: v.findings.map((f, i) => (i === idx ? { ...f, ...patch } : f)) });
  const removeFinding = (idx: number) => set({ findings: v.findings.filter((_, i) => i !== idx) });

  // ── AI assist (§10) ──
  async function generate(field: AIField) {
    setAiField(field);
    setAiBusy(true);
    setAiText("");
    try {
      const res = await api.post<{ text: string }>("/api/v1/irms/ai/generate", {
        field: field.apiField,
        context: {
          title: v.title,
          type: v.type,
          overallCondition: v.overallCondition,
          findings: v.findings.filter((f) => f.finding.trim()).map((f) => ({ finding: f.finding, severity: f.severity, recommendation: f.recommendation })),
          scope: v.scope,
          equipment: selectedEquipment ? `${selectedEquipment.name} (${selectedEquipment.assetTag})` : undefined,
          project: selectedProject ? `${selectedProject.code} — ${selectedProject.name}` : undefined,
          hint: v[field.formField],
        },
      });
      setAiText(res.data?.text ?? "");
    } catch (e) {
      toast({ title: "AI generation failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
      setAiField(null);
    } finally {
      setAiBusy(false);
    }
  }

  // ── Validation + payload ──
  function validate(): boolean {
    if (!v.projectId) {
      toast({ title: "Select a project", variant: "destructive" });
      setTab("details");
      return false;
    }
    if (!v.title.trim()) {
      toast({ title: "Report title is required", variant: "destructive" });
      setTab("details");
      return false;
    }
    if (!v.inspectionDate) {
      toast({ title: "Inspection date is required", variant: "destructive" });
      setTab("details");
      return false;
    }
    if (v.findings.some((f) => !f.finding.trim())) {
      toast({ title: "Some finding rows are empty", description: "Fill or remove empty finding rows.", variant: "destructive" });
      setTab("work");
      return false;
    }
    return true;
  }

  function buildPayload() {
    return {
      projectId: v.projectId,
      workOrderId: v.workOrderId || null,
      equipmentId: v.equipmentId || null,
      title: v.title.trim(),
      type: v.type,
      priority: v.priority,
      inspectionDate: v.inspectionDate,
      overallCondition: v.overallCondition,
      summary: v.summary.trim(),
      recommendations: v.recommendations.trim(),
      customerVisible: v.customerVisible,
      jobOrderNo: v.jobOrderNo.trim(),
      building: v.building.trim(),
      floor: v.floor.trim(),
      room: v.room.trim(),
      taskDescription: v.taskDescription.trim(),
      scope: v.scope.trim(),
      notes: v.notes.trim(),
      correctiveActions: v.correctiveActions.trim(),
      rootCause: v.rootCause.trim(),
      safetyNotes: v.safetyNotes.trim(),
      materials: v.materials.trim(),
      labourHours: Number(v.labourHours) || 0,
      completionPercent: Math.min(100, Math.max(0, Number(v.completionPercent) || 0)),
      ...(canManage && v.inspectorId ? { inspectorId: v.inspectorId } : {}),
      findings: v.findings
        .filter((f) => f.finding.trim())
        .map((f) => ({ finding: f.finding.trim(), severity: f.severity, recommendation: f.recommendation.trim() })),
    };
  }

  async function save() {
    if (!validate()) return;
    setSaving(true);
    setSubmitError(null);
    try {
      if (isNew) {
        const res = await api.post<{ id: string; code: string }>("/api/v1/irms/reports", buildPayload());
        toast({ title: "Report created as draft", description: `${res.data.code} — continue with photos, signatures and approval on its page.` });
        draft.reset(EMPTY_FORM);
        setPageDirty(false);
        navigateTo("irms", ["reports", res.data.id]);
      } else {
        await api.patch(`/api/v1/irms/reports/${reportId}`, buildPayload());
        toast({ title: "Report saved", description: `${detail?.code ?? "Report"} updated.` });
        draft.reset(EMPTY_FORM);
        setPageDirty(false);
        navigateTo("irms", ["reports", reportId!]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not save the report. Please try again.";
      setSubmitError(msg);
      toast({ title: isNew ? "Could not create report" : "Save failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  // ── RBAC guard ──
  if (!canCreate) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="/irms" title={isNew ? "New Inspection Report" : "Edit Report"}>
        <EmptyState
          title="You don't have permission to create inspection reports"
          hint="Creating reports requires the irms.create permission. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (initializing) {
    return (
      <PageShell backLabel="Back to Reports" backHref="/irms/reports" title={isNew ? "New Inspection Report" : "Edit Report"}>
        <LoadingState label="Loading report…" rows={4} />
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell backLabel="Back to Reports" backHref="/irms/reports" title={isNew ? "New Inspection Report" : "Edit Report"}>
        <ErrorState message={loadError} onRetry={() => void loadDetail()} />
      </PageShell>
    );
  }

  const saveButton = (
    <Button onClick={() => void save()} disabled={saving} className="min-h-[44px] flex-1 sm:flex-none sm:min-h-0">
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
      {saving ? "Saving…" : isNew ? "Create Draft Report" : "Save Changes"}
    </Button>
  );

  const draftIndicator = (
    <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
      {draft.dirty
        ? "Draft saving…"
        : draft.lastSavedAt
          ? `Draft saved ${fmtDateTime(draft.lastSavedAt)}`
          : "Autosave on — drafts restore after interruptions."}
    </span>
  );

  const aiButton = (field: AIField) => (
    <Button
      type="button" variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs"
      onClick={() => void generate(field)}
      aria-label={`Generate ${field.label} with AI`}
      title="Generate a draft with AI — always reviewed before insertion (§10)"
    >
      <Bot className="h-3.5 w-3.5 text-primary" aria-hidden /> AI
    </Button>
  );

  const fieldRow = (label: string, htmlFor: string, children: React.ReactNode, ai?: AIField) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {ai ? aiButton(ai) : null}
      </div>
      {children}
    </div>
  );

  const notSavedHint = (what: string, icon: React.ReactNode) => (
    <Card className="shadow-sm">
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">{icon}</div>
        <p className="font-medium">Save the report first</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {what} become available once the report exists on the server. Fill in the DETAILS and WORK DETAILS tabs, then press
          “Create Draft Report”.
        </p>
        <Button size="sm" variant="outline" onClick={() => setTab("details")}>Go to DETAILS</Button>
      </CardContent>
    </Card>
  );

  return (
    <div>
      <PageShell
        backLabel={isNew ? "Back to Reports" : "Back to Report"}
        backHref={isNew ? "/irms/reports" : `/irms/reports/${reportId}`}
        crumbs={[
          { label: "IRMS", href: "/irms" },
          { label: "Reports", href: "/irms/reports" },
          { label: isNew ? "New report" : `Edit ${detail?.code ?? ""}` },
        ]}
        title={isNew ? "New Inspection Report" : `Edit ${detail?.code ?? ""}`}
        description={isNew
          ? "Drafts start locally — autosaved as you type, restored after interruptions."
          : "Only DRAFT and REJECTED reports can be edited. Saved values go straight to the server."}
        actions={
          <div className="hidden flex-col items-end gap-1 sm:flex">
            <div className="flex items-center gap-2 no-print">
              {detail ? <StatusBadge status={detail.status} /> : null}
              {saveButton}
            </div>
            {draftIndicator}
          </div>
        }
      >
        {/* Recoverable draft banner — NEW uses hook state; EDIT uses the pre-init snapshot */}
        {draft.draftExists && isNew ? (
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm no-print">
            <span className="text-muted-foreground">
              Unsubmitted report draft saved{draft.lastSavedAt ? ` ${fmtDateTime(draft.lastSavedAt)}` : " earlier"} — restore it to continue where you left off.
            </span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={draft.restore}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={draft.discard}>Discard</Button>
            </div>
          </div>
        ) : null}
        {!isNew && savedDraft ? (
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm no-print">
            <span className="text-muted-foreground">Unsaved edits from your last session were found for this report — restore them on top of the server values?</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { set(savedDraft as Partial<FormState>); setSavedDraft(null); }}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={() => setSavedDraft(null)}>Discard</Button>
            </div>
          </div>
        ) : null}

        {submitError ? (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">The report could not be saved.</p>
              <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
            </div>
          </div>
        ) : null}

        {metaError ? (
          <div className="mb-4">
            <ErrorState message={`Reference data is unavailable — ${metaError}`} onRetry={() => void loadMeta()} />
          </div>
        ) : null}

        <Tabs value={tab} onValueChange={setTab}>
          <div className="-mx-1 mb-4 overflow-x-auto px-1">
            <TabsList className="h-auto w-max min-w-full justify-start">
              <TabsTrigger value="details" className="min-h-[40px] gap-1.5"><FileText className="h-4 w-4" /> DETAILS</TabsTrigger>
              <TabsTrigger value="work" className="min-h-[40px] gap-1.5"><ClipboardList className="h-4 w-4" /> WORK DETAILS</TabsTrigger>
              <TabsTrigger value="photos" className="min-h-[40px] gap-1.5"><Images className="h-4 w-4" /> PHOTOS</TabsTrigger>
              <TabsTrigger value="signatures" className="min-h-[40px] gap-1.5"><PenTool className="h-4 w-4" /> SIGNATURES</TabsTrigger>
              <TabsTrigger value="approval" className="min-h-[40px] gap-1.5"><BadgeCheck className="h-4 w-4" /> APPROVAL</TabsTrigger>
            </TabsList>
          </div>

          {/* ── DETAILS ── */}
          <TabsContent value="details">
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Report details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {/* Project — searchable combobox */}
                  <div className="space-y-1.5">
                    <Label>Project *</Label>
                    <Popover open={projOpen} onOpenChange={setProjOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={projOpen}
                          aria-label="Select project"
                          className="w-full justify-between font-normal"
                          disabled={!meta}
                        >
                          <span className="truncate">
                            {selectedProject ? `${selectedProject.code} — ${selectedProject.name}` : meta ? "Select project…" : "Loading projects…"}
                          </span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[340px] p-0" align="start">
                        <Command>
                          <CommandInput placeholder="Search code or name…" />
                          <CommandList>
                            <CommandEmpty>No project found.</CommandEmpty>
                            <CommandGroup>
                              {(meta?.projects ?? []).map((p) => (
                                <CommandItem
                                  key={p.id}
                                  value={`${p.code} ${p.name} ${p.customer?.companyName ?? ""}`}
                                  onSelect={() => { onProjectSelect(p.id); setProjOpen(false); }}
                                >
                                  <CheckCheck className={cn("mr-2 h-4 w-4", v.projectId === p.id ? "opacity-100" : "opacity-0")} aria-hidden />
                                  <span className="min-w-0">
                                    <span className="block truncate font-medium">{p.code} — {p.name}</span>
                                    {p.customer?.companyName ? <span className="block truncate text-xs text-muted-foreground">{p.customer.companyName}</span> : null}
                                  </span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {/* Read-only customer chip */}
                    {selectedProject?.customer?.companyName ? (
                      <p className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                        <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        Customer: {selectedProject.customer.companyName}
                        {selectedProject.siteLocation ? ` · Site: ${selectedProject.siteLocation}` : ""}
                      </p>
                    ) : null}
                  </div>

                  {/* Work order */}
                  <div className="space-y-1.5">
                    <Label>Work order</Label>
                    <Select value={v.workOrderId || "NONE"} onValueChange={(val) => onWorkOrderSelect(val === "NONE" ? "" : val)} disabled={!meta}>
                      <SelectTrigger aria-label="Work order">
                        <SelectValue placeholder={meta ? "None" : "Loading…"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">No work order</SelectItem>
                        {(meta?.workOrders ?? []).map((w) => (
                          <SelectItem key={w.id} value={w.id}>{w.code} — {w.title}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedWO ? (
                      <p className="text-xs text-muted-foreground">Linked WO {selectedWO.code} — details auto-filled where empty.</p>
                    ) : null}
                  </div>

                  {/* Equipment */}
                  <div className="space-y-1.5">
                    <Label>Equipment</Label>
                    <Select value={v.equipmentId || "NONE"} onValueChange={(val) => set({ equipmentId: val === "NONE" ? "" : val })} disabled={!meta}>
                      <SelectTrigger aria-label="Equipment">
                        <SelectValue placeholder={meta ? "None" : "Loading…"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">Not equipment-specific</SelectItem>
                        {(meta?.equipment ?? []).map((e) => (
                          <SelectItem key={e.id} value={e.id}>{e.name} ({e.assetTag})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedEquipment ? (
                      <p className="flex flex-wrap items-center gap-x-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{selectedEquipment.name}</span>
                        <span>Tag {selectedEquipment.assetTag}</span>
                        {selectedEquipment.serialNumber ? <span>S/N {selectedEquipment.serialNumber}</span> : null}
                        {selectedEquipment.manufacturer ? <span>{selectedEquipment.manufacturer}</span> : null}
                        {selectedEquipment.model ? <span>{selectedEquipment.model}</span> : null}
                        {selectedEquipment.category ? <span>{humanize(selectedEquipment.category)}</span> : null}
                        {selectedEquipment.location?.name ? <span>Loc: {selectedEquipment.location.name}</span> : null}
                      </p>
                    ) : null}
                  </div>

                  {/* Inspector */}
                  <div className="space-y-1.5">
                    <Label>Inspector</Label>
                    {canManage ? (
                      <Select value={v.inspectorId || "AUTO"} onValueChange={(val) => set({ inspectorId: val === "AUTO" ? "" : val })} disabled={!meta}>
                        <SelectTrigger aria-label="Inspector">
                          <SelectValue placeholder={meta ? "Auto (me)" : "Loading…"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="AUTO">Myself (default)</SelectItem>
                          {(meta?.inspectors ?? []).map((i) => (
                            <SelectItem key={i.id} value={i.id}>{i.user?.name ?? i.employeeNo}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={meta?.inspectors.find((i) => i.id === v.inspectorId)?.user?.name ?? user?.name ?? "Myself (auto-assigned)"}
                        readOnly
                        disabled
                        aria-label="Inspector (assigned to you)"
                      />
                    )}
                    {!canManage ? <p className="text-xs text-muted-foreground">Reports you create are inspected by you. Managers can reassign.</p> : null}
                  </div>

                  {/* Inspection date */}
                  <div className="space-y-1.5">
                    <Label htmlFor="irb-date">Inspection date *</Label>
                    <Input id="irb-date" type="date" value={v.inspectionDate} onChange={(e) => set({ inspectionDate: e.target.value })} />
                  </div>

                  {/* Type */}
                  <div className="space-y-1.5">
                    <Label>Type</Label>
                    <Select value={v.type} onValueChange={(val) => set({ type: val })}>
                      <SelectTrigger aria-label="Report type"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {REPORT_TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Priority */}
                  <div className="space-y-1.5">
                    <Label>Priority</Label>
                    <Select value={v.priority} onValueChange={(val) => set({ priority: val })}>
                      <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Overall condition */}
                  <div className="space-y-1.5">
                    <Label>Overall condition</Label>
                    <Select value={v.overallCondition} onValueChange={(val) => set({ overallCondition: val })}>
                      <SelectTrigger aria-label="Overall condition"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CONDITIONS.map((c) => <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Title */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="irb-title">Title *</Label>
                    <Input id="irb-title" value={v.title} onChange={(e) => set({ title: e.target.value })} placeholder="Quarterly HVAC system inspection" />
                  </div>

                  {fieldRow("Summary", "irb-summary",
                    <Textarea id="irb-summary" rows={3} value={v.summary} onChange={(e) => set({ summary: e.target.value })} placeholder="Executive summary of the inspection…" />,
                    AI_FIELDS[0],
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── WORK DETAILS ── */}
          <TabsContent value="work">
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Work details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="irb-jo">Job order no.</Label>
                    <Input id="irb-jo" value={v.jobOrderNo} onChange={(e) => set({ jobOrderNo: e.target.value })} placeholder="e.g. JO-2026-0012" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="irb-bld">Building</Label>
                    <Input id="irb-bld" value={v.building} onChange={(e) => set({ building: e.target.value })} placeholder="e.g. Block C" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="irb-floor">Floor / level</Label>
                    <Input id="irb-floor" value={v.floor} onChange={(e) => set({ floor: e.target.value })} placeholder="e.g. Level 3" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="irb-room">Room</Label>
                    <Input id="irb-room" value={v.room} onChange={(e) => set({ room: e.target.value })} placeholder="e.g. Server Room" />
                  </div>

                  {fieldRow("Task description", "irb-task",
                    <Textarea id="irb-task" rows={3} value={v.taskDescription} onChange={(e) => set({ taskDescription: e.target.value })} placeholder="What work was inspected…" />,
                  )}
                  {fieldRow("Scope", "irb-scope",
                    <Textarea id="irb-scope" rows={2} value={v.scope} onChange={(e) => set({ scope: e.target.value })} placeholder="Scope covered by this inspection…" />,
                  )}
                  {fieldRow("Corrective actions", "irb-corr",
                    <Textarea id="irb-corr" rows={3} value={v.correctiveActions} onChange={(e) => set({ correctiveActions: e.target.value })} />,
                    AI_FIELDS[1],
                  )}
                  {fieldRow("Recommendations", "irb-recs",
                    <Textarea id="irb-recs" rows={3} value={v.recommendations} onChange={(e) => set({ recommendations: e.target.value })} />,
                    AI_FIELDS[2],
                  )}
                  {fieldRow("Root cause", "irb-root",
                    <Textarea id="irb-root" rows={2} value={v.rootCause} onChange={(e) => set({ rootCause: e.target.value })} />,
                    AI_FIELDS[3],
                  )}
                  {fieldRow("Safety notes", "irb-safety",
                    <Textarea id="irb-safety" rows={2} value={v.safetyNotes} onChange={(e) => set({ safetyNotes: e.target.value })} />,
                    AI_FIELDS[4],
                  )}
                  {fieldRow("Notes", "irb-notes",
                    <Textarea id="irb-notes" rows={2} value={v.notes} onChange={(e) => set({ notes: e.target.value })} />,
                  )}
                  {fieldRow("Materials used", "irb-mat",
                    <Textarea id="irb-mat" rows={2} value={v.materials} onChange={(e) => set({ materials: e.target.value })} placeholder="One material per line…" />,
                  )}

                  <div className="space-y-1.5">
                    <Label htmlFor="irb-labour">Labour hours</Label>
                    <Input id="irb-labour" type="number" min={0} max={9999} step="0.5" value={v.labourHours} onChange={(e) => set({ labourHours: e.target.value })} />
                  </div>

                  <div className="space-y-1.5 sm:col-span-2">
                    <div className="flex items-center justify-between">
                      <Label>Completion percent</Label>
                      <span className="text-sm font-medium tabular-nums text-primary">{v.completionPercent}%</span>
                    </div>
                    <Slider
                      value={[v.completionPercent]}
                      onValueChange={(vals) => set({ completionPercent: vals[0] ?? 0 })}
                      min={0} max={100} step={5}
                      aria-label="Completion percent"
                    />
                  </div>
                </div>

                {/* Findings repeater */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Findings</Label>
                    <Button type="button" variant="outline" size="sm" onClick={addFinding}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add Finding
                    </Button>
                  </div>
                  {v.findings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No findings yet — add rows for each observation.</p>
                  ) : (
                    <div className="space-y-3">
                      {v.findings.map((f, idx) => (
                        <div key={idx} className="space-y-2 rounded-lg border bg-muted/20 p-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-muted-foreground">Finding {idx + 1}</span>
                            <div className="ml-auto">
                              <Button type="button" variant="ghost" size="sm" onClick={() => removeFinding(idx)} aria-label={`Remove finding ${idx + 1}`}>
                                <Trash2 className="h-3.5 w-3.5 text-red-600" />
                              </Button>
                            </div>
                          </div>
                          <Textarea
                            rows={2}
                            value={f.finding}
                            onChange={(e) => updateFinding(idx, { finding: e.target.value })}
                            placeholder="Describe the observation…"
                            aria-label={`Finding ${idx + 1} description`}
                          />
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            <Select value={f.severity} onValueChange={(val) => updateFinding(idx, { severity: val })}>
                              <SelectTrigger aria-label={`Severity for finding ${idx + 1}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {SEVERITIES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                            <Input
                              value={f.recommendation}
                              onChange={(e) => updateFinding(idx, { recommendation: e.target.value })}
                              placeholder="Recommendation (optional)"
                              aria-label={`Recommendation for finding ${idx + 1}`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Findings are included in the autosaved draft and replaced as a set when saving.</p>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── PHOTOS ── */}
          <TabsContent value="photos">
            {isNew || !reportId ? (
              notSavedHint("Photo uploads", <Images className="h-6 w-6" aria-hidden />)
            ) : (
              <IrmsPhotoManager reportId={reportId} editable canManage={canManage} />
            )}
          </TabsContent>

          {/* ── SIGNATURES ── */}
          <TabsContent value="signatures">
            {isNew || !reportId ? (
              notSavedHint("Signatures", <FileSignature className="h-6 w-6" aria-hidden />)
            ) : (
              <IrmsSignaturePanel reportId={reportId} canManage={canManage} isOwner={canCreate} />
            )}
          </TabsContent>

          {/* ── APPROVAL ── */}
          <TabsContent value="approval">
            {isNew || !reportId ? (
              notSavedHint("Workflow actions and client visibility", <BadgeCheck className="h-6 w-6" aria-hidden />)
            ) : detail ? (
              <ApprovalTab
                detail={detail}
                canManage={canManage}
                canCreate={canCreate}
                onTransitioned={() => { void loadDetail(); }}
              />
            ) : null}
          </TabsContent>
        </Tabs>

        {/* Sticky mobile save bar */}
        <div className="sticky bottom-[4.4rem] z-20 mt-4 lg:bottom-4 lg:hidden no-print">
          <div className="flex items-center gap-2 rounded-xl border bg-background/95 p-3 shadow-lg backdrop-blur">
            {saveButton}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground sm:hidden no-print">{draftIndicator}</p>
      </PageShell>

      {/* AI preview dialog (§10) — Insert ONLY on confirm */}
      <Dialog open={aiField !== null} onOpenChange={(open) => { if (!open && !aiBusy) setAiField(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" aria-hidden /> AI-generated {aiField?.label.toLowerCase() ?? "text"}
            </DialogTitle>
            <DialogDescription>Review the draft below — it is inserted only when you confirm.</DialogDescription>
          </DialogHeader>
          {aiBusy ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Generating a professional draft…
            </div>
          ) : (
            <Textarea readOnly rows={8} value={aiText} aria-label="AI generated text" className="bg-muted/30" />
          )}
          <p className="text-xs text-muted-foreground">AI-generated draft — review before use. The original image/field is never modified without your confirmation.</p>
          <DialogFooter>
            <Button variant="ghost" disabled={aiBusy} onClick={() => setAiField(null)}>
              <X className="h-4 w-4 mr-1.5" /> Discard
            </Button>
            <Button
              disabled={aiBusy || !aiText.trim()}
              onClick={() => {
                if (aiField) set({ [aiField.formField]: aiText } as unknown as Partial<FormState>);
                setAiField(null);
                toast({ title: `${aiField?.label ?? "Text"} inserted`, description: "Review the inserted text before saving." });
              }}
            >
              <Plus className="h-4 w-4 mr-1.5" /> Insert
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── APPROVAL tab (edit mode) ──

function ApprovalTab({
  detail, canManage, canCreate, onTransitioned,
}: {
  detail: EditDetail;
  canManage: boolean;
  canCreate: boolean;
  onTransitioned: () => void;
}) {
  const { toast } = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [customerVisible, setCustomerVisible] = useState(!!detail.customerVisible);
  const [cvBusy, setCvBusy] = useState(false);

  const status = detail.status;
  const isOwnerLike = canCreate; // server enforces ownership precisely

  async function transition(action: string, opts?: { withComment?: boolean }) {
    if (opts?.withComment && !comment.trim()) {
      toast({ title: "A comment is required to reject", variant: "destructive" });
      return;
    }
    setBusy(action);
    try {
      await api.post(`/api/v1/irms/reports/${detail.id}/transition`, { action, comment: comment.trim() || undefined });
      toast({ title: `${humanize(action)} done`, description: `${detail.code} is now being processed — opening the report.` });
      navigateTo("irms", ["reports", detail.id]);
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
      setBusy(null);
    }
  }

  async function saveCustomerVisible(next: boolean) {
    setCvBusy(true);
    try {
      await api.patch(`/api/v1/irms/reports/${detail.id}`, { customerVisible: next });
      setCustomerVisible(next);
      toast({ title: next ? "Report shared with the customer" : "Customer visibility disabled" });
      onTransitioned();
    } catch (e) {
      toast({ title: "Could not update visibility", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setCvBusy(false);
    }
  }

  const actions: { key: string; label: string; icon: React.ReactNode; show: boolean; variant?: "default" | "outline" | "destructive" | "ghost"; needsComment?: boolean }[] = [
    { key: "submit", label: "Submit for Approval", icon: <Send className="h-4 w-4 mr-1.5" />, show: status === "DRAFT" && isOwnerLike },
    { key: "review", label: "Start Review", icon: <ClipboardList className="h-4 w-4 mr-1.5" />, show: status === "SUBMITTED" && canManage },
    { key: "manager_approve", label: "Approve to Manager", icon: <CheckCheck className="h-4 w-4 mr-1.5" />, show: status === "IN_REVIEW" && canManage },
    { key: "client_request", label: "Request Client Review", icon: <FileText className="h-4 w-4 mr-1.5" />, show: status === "MANAGER_APPROVAL" && canManage },
    { key: "approve", label: "Approve", icon: <CheckCheck className="h-4 w-4 mr-1.5" />, show: (status === "MANAGER_APPROVAL" || status === "CLIENT_REVIEW") && canManage },
    { key: "reopen", label: "Reopen as Draft", icon: <Undo2 className="h-4 w-4 mr-1.5" />, show: status === "REJECTED" && isOwnerLike },
  ];
  const canReject = ["SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW"].includes(status) && canManage;

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex flex-wrap items-center gap-2">
          Approval <StatusBadge status={status} /> <PriorityBadge priority={detail.priority} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Workflow: DRAFT → SUBMITTED → IN_REVIEW → MANAGER_APPROVAL → CLIENT_REVIEW → APPROVED → ARCHIVED.
          Rejection is possible from any review stage. After a workflow action the report opens in its read-only view.
        </p>

        {/* customerVisible switch (manage only, editable reports) */}
        {canManage ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <Label htmlFor="irb-cv" className="text-sm">Shared to customer</Label>
              <p className="text-xs text-muted-foreground">Customer portal users of this project can see the report while it is shared.</p>
            </div>
            <Switch
              id="irb-cv"
              checked={customerVisible}
              disabled={cvBusy}
              onCheckedChange={(next) => void saveCustomerVisible(next)}
            />
          </div>
        ) : null}

        {/* Comment input (used by reject) */}
        {canReject ? (
          <div className="space-y-1.5">
            <Label htmlFor="irb-comment">Comment {canReject ? "(required for reject)" : "(optional)"}</Label>
            <Textarea id="irb-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why is this being rejected? Visible in the approval history." />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {actions.filter((a) => a.show).map((a) => (
            <Button key={a.key} size="sm" disabled={busy !== null} onClick={() => void transition(a.key)} className="min-h-[44px] sm:min-h-0">
              {busy === a.key ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : a.icon}
              {busy === a.key ? "Working…" : a.label}
            </Button>
          ))}
          {canReject ? (
            <Button
              size="sm" variant="outline"
              disabled={busy !== null}
              onClick={() => void transition("reject", { withComment: true })}
              className="min-h-[44px] text-red-700 hover:bg-red-50 sm:min-h-0"
            >
              {busy === "reject" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <X className="h-4 w-4 mr-1.5" />}
              Reject
            </Button>
          ) : null}
          {actions.every((a) => !a.show) && !canReject ? (
            <p className="text-sm text-muted-foreground">No workflow action is available for your role at status {humanize(status)}.</p>
          ) : null}
        </div>

        <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
          Submitting creates a revision snapshot (Rev 1). Every approval step is recorded in the approval history with your name and time.
        </div>
      </CardContent>
    </Card>
  );
}
