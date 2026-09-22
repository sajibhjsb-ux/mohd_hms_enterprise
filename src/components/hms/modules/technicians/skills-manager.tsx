"use client";

// MOHD.HMS ENTERPRISE — Skills Manager (spec §6/§7/§8).
// ONE shared component for BOTH surfaces:
//   • Technicians edit page  → base /api/v1/technicians/{profileId}/skills
//   • Profile "My Skills"    → base /api/v1/profile/technician-skills (selfService)
//
// Capabilities: add (library suggestions + free text), edit (level /
// certification / years), remove (confirm). Every change waits for the API
// response before any success toast — never optimistic lies (spec §46).
// Read-only mode renders the same chips plus an honest permission hint.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { humanize } from "@/lib/hms/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Award, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

// ── Domain vocabularies (spec §7 — mirrors the backend whitelist) ──

export const SKILL_LEVEL_OPTIONS = ["BASIC", "INTERMEDIATE", "ADVANCED", "EXPERT"] as const;
export const SKILL_CATEGORY_OPTIONS = [
  "HVAC", "ELECTRICAL", "PLUMBING", "FIRE_PROTECTION", "GENERATOR", "LIFT_ESCALATOR",
  "MECHANICAL", "CIVIL", "CLEANING", "PEST_CONTROL", "LANDSCAPE", "OTHER",
] as const;

/** Full skill row served by the skills endpoints. */
export type SkillEntry = {
  id: string;
  name: string;
  category: string;
  level: string;
  certification: string;
  yearsExperience: number | null;
};

/** Roster projection (GET /api/v1/technicians skillEntries) — chips only. */
export type SkillChip = { id: string; name: string; category: string; level: string };

type LibraryItem = { id: string; name: string; category: string; active: boolean };

// Local tone map — STATUS_TONE has no skill-level keys and lib/hms/constants.ts
// is outside this task's file ownership, so the tones live here (client-safe).
const LEVEL_TONE: Record<string, string> = {
  BASIC: "bg-stone-200 text-stone-700",
  INTERMEDIATE: "bg-amber-100 text-amber-800",
  ADVANCED: "bg-teal-100 text-teal-800",
  EXPERT: "bg-emerald-100 text-emerald-800",
};

export function SkillLevelBadge({ level, className }: { level: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_TONE[level] ?? "bg-stone-200 text-stone-700"} ${className ?? ""}`}
    >
      {humanize(level)}
    </span>
  );
}

export function SkillCategoryBadge({ category, className }: { category: string; className?: string }) {
  return (
    <Badge variant="secondary" className={`text-[11px] font-normal ${className ?? ""}`} title="Category">
      {humanize(category)}
    </Badge>
  );
}

function sortSkills(list: SkillEntry[]): SkillEntry[] {
  return [...list].sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );
}

const EMPTY_ADD = { name: "", category: "", level: "BASIC", certification: "", years: "" };

export function SkillsManager({
  profileId,
  skills,
  canEdit,
  selfService = false,
  onChange,
}: {
  profileId: string;
  skills: SkillEntry[];
  canEdit: boolean;
  /** true → /api/v1/profile/technician-skills (own skills only). */
  selfService?: boolean;
  /** Notifies the parent with the new list after every confirmed mutation. */
  onChange?: (skills: SkillEntry[]) => void;
}) {
  const { toast } = useToast();
  const base = selfService ? "/api/v1/profile/technician-skills" : `/api/v1/technicians/${profileId}/skills`;

  const [items, setItems] = useState<SkillEntry[]>(skills);
  useEffect(() => setItems(skills), [skills]);

  const commit = (next: SkillEntry[]) => {
    setItems(next);
    onChange?.(next);
  };

  // ── Library suggestions (best effort: unavailable library → free text) ──
  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    api
      .get<LibraryItem[]>("/api/v1/skills?active=true")
      .then((r) => { if (alive) setLibrary(r.data); })
      .catch(() => { if (alive) setLibrary([]); });
    return () => { alive = false; };
  }, [canEdit]);

  // ── Add form state ──
  const [add, setAdd] = useState<{ name: string; category: string; level: string; certification: string; years: string }>(EMPTY_ADD);
  const [adding, setAdding] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const nameRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo<LibraryItem[]>(() => {
    const q = add.name.trim().toLowerCase();
    if (!q || q.length < 2 || !library) return [];
    return library
      .filter((li) => li.name.toLowerCase().includes(q) && li.name.toLowerCase() !== q)
      .slice(0, 6);
  }, [add.name, library]);

  useEffect(() => { setHighlight(-1); }, [add.name]);

  function pickSuggestion(li: LibraryItem) {
    setAdd((a) => ({ ...a, name: li.name, category: li.category }));
    setSuggestOpen(false);
    nameRef.current?.focus();
  }

  function onNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!suggestOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      pickSuggestion(suggestions[highlight]);
    } else if (e.key === "Escape") {
      setSuggestOpen(false);
    }
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = add.name.trim();
    if (!name) {
      toast({ title: "Skill name is required", variant: "destructive" });
      return;
    }
    if (!add.category) {
      toast({ title: "Select a category", description: "Choose the trade this skill belongs to.", variant: "destructive" });
      return;
    }
    if (add.years.trim() !== "") {
      const n = Number(add.years);
      if (!Number.isFinite(n) || n < 0 || n > 60) {
        toast({ title: "Invalid years of experience", description: "Enter a number between 0 and 60.", variant: "destructive" });
        return;
      }
    }
    setAdding(true);
    try {
      const res = await api.post<SkillEntry>(base, {
        name,
        category: add.category,
        level: add.level,
        ...(add.certification.trim() ? { certification: add.certification.trim() } : {}),
        ...(add.years.trim() !== "" ? { yearsExperience: Number(add.years) } : {}),
      });
      // Success ONLY after the API answered ok — nothing optimistic (spec §46).
      commit(sortSkills([...items, res.data]));
      setAdd(EMPTY_ADD);
      setSuggestOpen(false);
      toast({ title: "Skill added", description: `“${res.data.name}” was added to the technician's skills.` });
    } catch (err) {
      // Duplicate (409) and validation errors surface the API's honest message.
      toast({
        title: "Could not add skill",
        description: err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setAdding(false);
    }
  }

  // ── Edit dialog state ──
  const [editing, setEditing] = useState<SkillEntry | null>(null);
  const [editForm, setEditForm] = useState({ level: "BASIC", certification: "", years: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  function openEdit(s: SkillEntry) {
    setEditing(s);
    setEditForm({
      level: s.level,
      certification: s.certification ?? "",
      years: s.yearsExperience === null || s.yearsExperience === undefined ? "" : String(s.yearsExperience),
    });
  }

  async function submitEdit() {
    if (!editing) return;
    if (editForm.years.trim() !== "") {
      const n = Number(editForm.years);
      if (!Number.isFinite(n) || n < 0 || n > 60) {
        toast({ title: "Invalid years of experience", description: "Enter a number between 0 and 60.", variant: "destructive" });
        return;
      }
    }
    setSavingEdit(true);
    try {
      const res = await api.patch<SkillEntry>(`${base}/${editing.id}`, {
        level: editForm.level,
        certification: editForm.certification.trim(),
        ...(editForm.years.trim() !== "" ? { yearsExperience: Number(editForm.years) } : { yearsExperience: null }),
      });
      commit(items.map((s) => (s.id === res.data.id ? res.data : s)));
      setEditing(null);
      toast({ title: "Skill updated", description: `“${res.data.name}” was updated.` });
    } catch (err) {
      toast({
        title: "Could not update skill",
        description: err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingEdit(false);
    }
  }

  // ── Remove confirm state ──
  const [removing, setRemoving] = useState<SkillEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmRemove() {
    if (!removing) return;
    setDeleting(true);
    try {
      const res = await api.del<SkillEntry>(`${base}/${removing.id}`);
      commit(items.filter((s) => s.id !== res.data.id));
      setRemoving(null);
      toast({ title: "Skill removed", description: `“${res.data.name}” was removed from the technician's skills.` });
    } catch (err) {
      toast({
        title: "Could not remove skill",
        description: err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  // ── Render ──

  return (
    <div className="space-y-4">
      {canEdit ? (
        <form onSubmit={submitAdd} className="rounded-lg border bg-muted/30 p-3 space-y-3" data-testid="add-skill-form">
          <div className="relative">
            <Label htmlFor="skill-name" className="text-xs">Skill</Label>
            <Input
              id="skill-name"
              ref={nameRef}
              value={add.name}
              maxLength={80}
              autoComplete="off"
              placeholder="e.g. Chiller Maintenance"
              className="mt-1"
              role="combobox"
              aria-expanded={suggestOpen && suggestions.length > 0}
              aria-controls="skill-suggestions"
              aria-autocomplete="list"
              onChange={(e) => { setAdd((a) => ({ ...a, name: e.target.value })); setSuggestOpen(true); }}
              onKeyDown={onNameKeyDown}
              onBlur={() => window.setTimeout(() => setSuggestOpen(false), 150)}
            />
            {suggestOpen && suggestions.length > 0 ? (
              <ul
                id="skill-suggestions"
                role="listbox"
                aria-label="Skill suggestions"
                className="absolute z-20 left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md"
              >
                {suggestions.map((li, i) => (
                  <li key={li.id} role="option" aria-selected={i === highlight}>
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); pickSuggestion(li); }}
                      onMouseEnter={() => setHighlight(i)}
                      className={`flex w-full min-h-[44px] items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors focus:outline-none ${i === highlight ? "bg-accent" : ""}`}
                    >
                      <span className="truncate">{li.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{humanize(li.category)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-[11px] text-muted-foreground mt-1">
              {library && library.length > 0 ? "Pick a suggestion from the skill library or type a new skill." : "Type any skill — new entries extend the library automatically."}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="skill-category" className="text-xs">Category</Label>
              <Select value={add.category} onValueChange={(v) => setAdd((a) => ({ ...a, category: v }))}>
                <SelectTrigger id="skill-category" className="mt-1 min-h-[44px]" aria-label="Skill category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="skill-level" className="text-xs">Level</Label>
              <Select value={add.level} onValueChange={(v) => setAdd((a) => ({ ...a, level: v }))}>
                <SelectTrigger id="skill-level" className="mt-1 min-h-[44px]" aria-label="Skill level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_LEVEL_OPTIONS.map((l) => (
                    <SelectItem key={l} value={l}>{humanize(l)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="skill-cert" className="text-xs">Certification <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                id="skill-cert"
                value={add.certification}
                maxLength={120}
                placeholder="e.g. City & Guilds Level 3"
                className="mt-1"
                onChange={(e) => setAdd((a) => ({ ...a, certification: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="skill-years" className="text-xs">Years of experience <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                id="skill-years"
                inputMode="decimal"
                value={add.years}
                placeholder="e.g. 5"
                className="mt-1"
                onChange={(e) => setAdd((a) => ({ ...a, years: e.target.value }))}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" size="sm" className="min-h-[44px]" disabled={adding}>
              {adding ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
              {adding ? "Adding…" : "Add skill"}
            </Button>
          </div>
        </form>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No skills recorded yet.</p>
      ) : (
        <ul
          className="grid gap-2 max-h-96 overflow-y-auto pr-1
            [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent
            [&::-webkit-scrollbar-thumb]:bg-muted-foreground/30 [&::-webkit-scrollbar-thumb]:rounded-full"
          aria-label="Technician skills"
        >
          {items.map((s) => (
            <li key={s.id} className="rounded-lg border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate" title={s.name}>{s.name}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    <SkillCategoryBadge category={s.category} />
                    <SkillLevelBadge level={s.level} />
                  </div>
                  {s.certification || s.yearsExperience !== null ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
                      {s.certification ? (
                        <span className="inline-flex items-center gap-1 min-w-0">
                          <Award className="h-3 w-3 shrink-0" aria-hidden />
                          <span className="truncate" title={s.certification}>{s.certification}</span>
                        </span>
                      ) : null}
                      {s.yearsExperience !== null ? <span>{s.yearsExperience} yr{s.yearsExperience === 1 ? "" : "s"} experience</span> : null}
                    </div>
                  ) : null}
                </div>
                {canEdit ? (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9"
                      onClick={() => openEdit(s)}
                      aria-label={`Edit skill ${s.name}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-destructive hover:text-destructive"
                      onClick={() => setRemoving(s)}
                      aria-label={`Remove skill ${s.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!canEdit ? (
        <p className="text-xs text-muted-foreground">You don&apos;t have permission to edit skills. Contact your supervisor or administrator.</p>
      ) : null}

      {/* Edit dialog — level / certification / years */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit skill</DialogTitle>
            <DialogDescription className="truncate">{editing?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="edit-skill-level">Level</Label>
              <Select value={editForm.level} onValueChange={(v) => setEditForm((f) => ({ ...f, level: v }))}>
                <SelectTrigger id="edit-skill-level" className="mt-1 min-h-[44px]" aria-label="Skill level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_LEVEL_OPTIONS.map((l) => (
                    <SelectItem key={l} value={l}>{humanize(l)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="edit-skill-cert">Certification</Label>
              <Input
                id="edit-skill-cert"
                value={editForm.certification}
                maxLength={120}
                placeholder="e.g. City & Guilds Level 3"
                className="mt-1"
                onChange={(e) => setEditForm((f) => ({ ...f, certification: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-skill-years">Years of experience</Label>
              <Input
                id="edit-skill-years"
                inputMode="decimal"
                value={editForm.years}
                placeholder="e.g. 5"
                className="mt-1"
                onChange={(e) => setEditForm((f) => ({ ...f, years: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</Button>
            <Button onClick={submitEdit} disabled={savingEdit}>
              {savingEdit ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              {savingEdit ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirmation */}
      <AlertDialog open={!!removing} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove skill?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing ? `“${removing.name}” will be removed from this technician's skills. This cannot be undone.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmRemove(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              {deleting ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
