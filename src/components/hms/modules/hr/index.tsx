"use client";

// HR module — workforce overview (headcount, attendance KPIs, 7-day trend),
// read-only employee register, attendance register and leave approval workflow.
//
// NAVIGATION ARCHITECTURE: every business form is a DEDICATED PAGE routed by
// the hash router (ui-store pages["hr"]) — no popup CRUD:
//   []                        → this list page (overview + tabs)
//   ["attendance", "new"]     → Mark Attendance page (create)
//   ["attendance", id]        → Edit Attendance page (prefilled)
//   ["leave", "new"]          → New Leave Request page
//   ["departments", "new"]    → New Department page
// Leave approve/reject stays inline (PATCH, same as before).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users, UserCheck, CalendarOff, UserX, Clock, CalendarPlus, Plus, Check, X, Info, FileText,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, toDateInput } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HrAttendancePage } from "./attendance-page";
import { HrLeaveNewPage } from "./leave-page";
import { HrDepartmentNewPage } from "./department-page";
import { LettersHome } from "./letters/letters-home";
import { LetterWizardPage } from "./letters/wizard";
import { LetterEditorPage } from "./letters/editor";
import { TemplatesManagerPage } from "./letters/templates-manager";
import { TemplateEditorPage } from "./letters/template-editor";
import { LetterHistoryPage } from "./letters/history";

// ── Types ──

type Overview = {
  headcount: number;
  activeCount: number;
  onLeaveToday: number;
  presentToday: number;
  halfDayToday?: number;
  absentToday: number;
  pendingLeaves: number;
  departments: { id: string; name: string; description?: string; count: number }[];
  attendance7d: { date: string; present: number; absent: number; leave: number; half: number }[];
};

type Employee = {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  position: string;
  email: string;
  phone: string;
  status: string;
  departmentId: string | null;
  department: { id: string; name: string } | null;
};

type AttendanceRecord = {
  id: string;
  date: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  notes: string;
  employee: { id: string; firstName: string; lastName: string; employeeNo: string; position?: string };
};

type LeaveRequest = {
  id: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string;
  status: string;
  approvedByName?: string | null;
  createdAt: string;
  employee: { id: string; firstName: string; lastName: string; employeeNo: string };
};

const todayInput = () => toDateInput(new Date());

// ── Module router ──

export function HrModule() {
  const seg = useUi((s) => s.pages["hr"]) ?? [];

  // Letters subtree — custom segment parsing (pageFromSeg drops 3rd segments:
  //   /hr/letters/templates/{id} needs the id):
  //   ["letters"]                    → routed to the Letters tab (list page)
  //   ["letters", "new"]             → Create Letter wizard
  //   ["letters", "templates"]       → Templates manager
  //   ["letters", "templates", id]   → Template editor
  //   ["letters", "history"]         → Letter history
  //   ["letters", letterId]          → Letter workspace
  if (seg[0] === "letters") {
    const [, a, b] = seg;
    if (!a) return <HrList initialTab="letters" />;
    if (a === "new") return <LetterWizardPage />;
    if (a === "templates") return b ? <TemplateEditorPage templateId={b} /> : <TemplatesManagerPage />;
    if (a === "history") return <LetterHistoryPage />;
    return <LetterEditorPage letterId={a} />;
  }

  const page = pageFromSeg(seg);

  if (page.view === "attendance" && page.id) return <HrAttendancePage attendanceId={page.id} />;
  if (page.view === "leave" && page.id === "new") return <HrLeaveNewPage />;
  if (page.view === "departments" && page.id === "new") return <HrDepartmentNewPage />;
  return <HrList />;
}

// ── List page ──

function HrList({ initialTab }: { initialTab?: string } = {}) {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.hr_manage);
  const canReadEmployees = hasPerm(user, PERMISSIONS.employees_read) || canManage;

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("hr", seg), []);

  // ── Overview ──
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [employeesError, setEmployeesError] = useState<string | null>(null);

  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [attendanceDate, setAttendanceDate] = useState(todayInput());
  const [attendanceLoading, setAttendanceLoading] = useState(true);

  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [leaveStatus, setLeaveStatus] = useState("ALL");
  const [leaveLoading, setLeaveLoading] = useState(true);

  const [tab, setTab] = useState(initialTab ?? "attendance");

  const [busyLeaveId, setBusyLeaveId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewError(null);
    try {
      const res = await api.get<Overview>("/api/v1/hr/overview");
      setOverview(res.data);
    } catch (e) {
      setOverviewError(e instanceof Error ? e.message : "Unable to load HR overview.");
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    if (!canReadEmployees) return;
    setEmployeesError(null);
    try {
      const res = await api.get<Employee[]>(`/api/v1/employees${qs({ pageSize: "200" })}`);
      setEmployees(res.data ?? []);
    } catch (e) {
      setEmployees(null);
      setEmployeesError(e instanceof Error ? e.message : "Employees register is unavailable.");
    }
  }, [canReadEmployees]);

  const loadAttendance = useCallback(async () => {
    setAttendanceLoading(true);
    try {
      const res = await api.get<AttendanceRecord[]>(`/api/v1/hr/attendance${qs({ date: attendanceDate, pageSize: "200" })}`);
      setAttendance(res.data ?? []);
    } catch {
      setAttendance([]);
    } finally {
      setAttendanceLoading(false);
    }
  }, [attendanceDate]);

  const loadLeaves = useCallback(async () => {
    setLeaveLoading(true);
    try {
      const res = await api.get<LeaveRequest[]>(`/api/v1/hr/leave${qs({ pageSize: "200", ...(leaveStatus !== "ALL" ? { status: leaveStatus } : {}) })}`);
      setLeaves(res.data ?? []);
    } catch {
      setLeaves([]);
    } finally {
      setLeaveLoading(false);
    }
  }, [leaveStatus]);

  useEffect(() => {
    loadOverview();
    loadEmployees();
  }, [loadOverview, loadEmployees]);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  useEffect(() => {
    loadLeaves();
  }, [loadLeaves]);

  // Realtime: leave approvals / employee changes refresh HR views live.
  useRealtimeEvent(MODULE_EVENTS.hr, () => { void loadLeaves(); void loadOverview(); });

  const chartData = useMemo(() => {
    if (!overview) return [];
    return overview.attendance7d.map((d) => ({
      date: d.date.slice(5), // MM-DD for compact axis
      Present: d.present,
      Half: d.half,
      Leave: d.leave,
      Absent: d.absent,
    }));
  }, [overview]);

  // ── Leave decision (stays inline — no navigation required) ──
  const decideLeave = async (leave: LeaveRequest, action: "approve" | "reject") => {
    setBusyLeaveId(leave.id);
    try {
      await api.patch(`/api/v1/hr/leave/${leave.id}`, { action });
      toast({
        title: action === "approve" ? "Leave approved" : "Leave rejected",
        description: `${leave.employee.firstName} ${leave.employee.lastName} · ${leave.days} day(s).`,
      });
      await Promise.all([loadLeaves(), loadOverview()]);
    } catch (e) {
      toast({ title: "Decision failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyLeaveId(null);
    }
  };

  // ── Columns ──
  const employeeColumns: Column<Employee>[] = [
    { key: "employeeNo", header: "Employee No", value: (e) => e.employeeNo, className: "font-medium whitespace-nowrap" },
    {
      key: "name", header: "Name", value: (e) => `${e.firstName} ${e.lastName}`,
      render: (e) => <span>{e.firstName} {e.lastName}</span>,
    },
    { key: "position", header: "Position", value: (e) => e.position, hideOnMobile: true },
    { key: "department", header: "Department", value: (e) => e.department?.name ?? "", render: (e) => e.department?.name ?? "—" },
    { key: "email", header: "Email", value: (e) => e.email, hideOnMobile: true },
    { key: "phone", header: "Phone", value: (e) => e.phone, hideOnMobile: true },
    { key: "status", header: "Status", value: (e) => e.status, render: (e) => <StatusBadge status={e.status} /> },
  ];

  const attendanceColumns: Column<AttendanceRecord>[] = [
    {
      key: "employee", header: "Employee", value: (a) => `${a.employee.firstName} ${a.employee.lastName}`,
      render: (a) => (
        <span>
          {a.employee.firstName} {a.employee.lastName}{" "}
          <span className="text-xs text-muted-foreground">({a.employee.employeeNo})</span>
        </span>
      ),
    },
    { key: "date", header: "Date", value: (a) => a.date, render: (a) => fmtDate(a.date), hideOnMobile: true },
    { key: "status", header: "Status", value: (a) => a.status, render: (a) => <StatusBadge status={a.status} /> },
    {
      key: "checkIn", header: "Check In", hideOnMobile: true, sortable: false, value: (a) => a.checkIn ?? "",
      render: (a) => (a.checkIn ? new Date(a.checkIn).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"),
    },
    {
      key: "checkOut", header: "Check Out", hideOnMobile: true, sortable: false, value: (a) => a.checkOut ?? "",
      render: (a) => (a.checkOut ? new Date(a.checkOut).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—"),
    },
    { key: "notes", header: "Notes", value: (a) => a.notes, render: (a) => a.notes || <span className="text-muted-foreground">—</span>, hideOnMobile: true },
    ...(canManage
      ? [{
          key: "attActions", header: "", sortable: false,
          render: (a: AttendanceRecord) => (
            <Button
              variant="outline" size="sm"
              onClick={() => openPage(["attendance", a.id])}
              aria-label={`Edit attendance for ${a.employee.employeeNo}`}
            >
              Edit
            </Button>
          ),
        } satisfies Column<AttendanceRecord>]
      : []),
  ];

  const leaveColumns: Column<LeaveRequest>[] = [
    {
      key: "employee", header: "Employee", value: (l) => `${l.employee.firstName} ${l.employee.lastName}`,
      render: (l) => (
        <span>
          {l.employee.firstName} {l.employee.lastName}{" "}
          <span className="text-xs text-muted-foreground">({l.employee.employeeNo})</span>
        </span>
      ),
    },
    { key: "type", header: "Type", value: (l) => l.type, render: (l) => <StatusBadge status={l.type} /> },
    {
      key: "period", header: "Period", sortable: false, value: (l) => l.startDate,
      render: (l) => (
        <span className="whitespace-nowrap text-sm">{fmtDate(l.startDate)} → {fmtDate(l.endDate)}</span>
      ),
    },
    { key: "days", header: "Days", value: (l) => l.days, render: (l) => <span className="tabular-nums">{l.days}</span> },
    { key: "reason", header: "Reason", value: (l) => l.reason, render: (l) => l.reason || <span className="text-muted-foreground">—</span>, hideOnMobile: true },
    { key: "status", header: "Status", value: (l) => l.status, render: (l) => <StatusBadge status={l.status} /> },
    {
      key: "approvedByName", header: "Approved By", hideOnMobile: true, value: (l) => l.approvedByName ?? "",
      render: (l) => l.approvedByName ?? <span className="text-muted-foreground">—</span>,
    },
    ...(canManage
      ? [{
          key: "leaveActions", header: "Decision", sortable: false,
          render: (l: LeaveRequest) =>
            l.status === "PENDING" ? (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline" size="sm"
                  disabled={busyLeaveId === l.id}
                  onClick={() => void decideLeave(l, "approve")}
                  aria-label={`Approve leave for ${l.employee.employeeNo}`}
                >
                  <Check className="h-3.5 w-3.5 text-emerald-600" /> Approve
                </Button>
                <Button
                  variant="ghost" size="sm"
                  disabled={busyLeaveId === l.id}
                  onClick={() => void decideLeave(l, "reject")}
                  aria-label={`Reject leave for ${l.employee.employeeNo}`}
                >
                  <X className="h-3.5 w-3.5 text-red-600" /> Reject
                </Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            ),
        } satisfies Column<LeaveRequest>]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Human Resources"
        subtitle="Headcount, attendance and leave management"
        actions={
          canManage ? (
            <>
              <Button variant="outline" size="sm" onClick={() => navigateTo("hr", ["letters", "new"])}>
                <FileText className="h-4 w-4 mr-1.5" /> Create Letter
              </Button>
              <Button variant="outline" size="sm" onClick={() => openPage(["attendance", "new"])}>
                <Clock className="h-4 w-4 mr-1.5" /> Mark Attendance
              </Button>
              <Button variant="outline" size="sm" onClick={() => openPage(["leave", "new"])}>
                <CalendarPlus className="h-4 w-4 mr-1.5" /> New Leave Request
              </Button>
              <Button size="sm" onClick={() => openPage(["departments", "new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> Department
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => openPage(["leave", "new"])}>
              <CalendarPlus className="h-4 w-4 mr-1.5" /> New Leave Request
            </Button>
          )
        }
      />

      {/* ── Overview ── */}
      {overviewError ? (
        <ErrorState message={overviewError} onRetry={() => void loadOverview()} />
      ) : !overview ? (
        <LoadingState label="Loading HR overview…" rows={2} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
            <StatCard title="Headcount" value={overview.headcount} sub={`${overview.activeCount} active`} icon={<Users className="h-5 w-5" />} loading={!overview} />
            <StatCard title="Present Today" value={overview.presentToday} icon={<UserCheck className="h-5 w-5" />} tone="success" loading={!overview} />
            <StatCard title="Absent Today" value={overview.absentToday} icon={<UserX className="h-5 w-5" />} tone="danger" loading={!overview} />
            <StatCard title="On Leave Today" value={overview.onLeaveToday} icon={<CalendarOff className="h-5 w-5" />} tone="warning" loading={!overview} />
            <StatCard title="Pending Leaves" value={overview.pendingLeaves} icon={<Clock className="h-5 w-5" />} loading={!overview} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <div className="lg:col-span-2 rounded-xl border bg-card p-4">
              <div className="text-sm font-medium mb-3">Attendance — last 7 days</div>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Present" stackId="a" fill="#10b981" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="Half" stackId="a" fill="#f59e0b" />
                    <Bar dataKey="Leave" stackId="a" fill="#64748b" />
                    <Bar dataKey="Absent" stackId="a" fill="#ef4444" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium">Departments</div>
                {canManage ? (
                  <Button variant="ghost" size="sm" onClick={() => openPage(["departments", "new"])} aria-label="Add department">
                    <Plus className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
              {overview.departments.length === 0 ? (
                <p className="text-sm text-muted-foreground">No departments yet.</p>
              ) : (
                <ul className="space-y-2">
                  {overview.departments.map((d) => (
                    <li key={d.id} className="flex items-center justify-between text-sm">
                      <span className="truncate">
                        {d.name}
                        {d.description ? <span className="block text-xs text-muted-foreground truncate">{d.description}</span> : null}
                      </span>
                      <span className="ml-2 rounded-full bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 tabular-nums shrink-0">
                        {d.count}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Tabs ── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="letters"><FileText className="h-4 w-4 mr-1.5" /> Letters</TabsTrigger>
          <TabsTrigger value="employees"><Users className="h-4 w-4 mr-1.5" /> Employees</TabsTrigger>
          <TabsTrigger value="attendance"><Clock className="h-4 w-4 mr-1.5" /> Attendance</TabsTrigger>
          <TabsTrigger value="leave"><CalendarPlus className="h-4 w-4 mr-1.5" /> Leave</TabsTrigger>
        </TabsList>

        <TabsContent value="letters">
          <LettersHome />
        </TabsContent>

        <TabsContent value="employees">
          {!canReadEmployees ? (
            <EmptyState
              title="Employees register is restricted"
              hint="You need the employees.read permission to view the register. Employee management lives in the Employees module."
            />
          ) : employeesError ? (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <span>The employee register (Employees module) is not available right now. HR KPIs and attendance keep working from this module.</span>
              </div>
              <ErrorState message={employeesError} onRetry={() => void loadEmployees()} />
            </div>
          ) : employees === null ? (
            <LoadingState label="Loading employees…" />
          ) : employees.length === 0 ? (
            <EmptyState title="No employees" hint="Employee records are managed in the Employees module." />
          ) : (
            <DataTable
              columns={employeeColumns}
              rows={employees}
              rowKey={(e) => e.id}
              searchPlaceholder="Search name, number, position…"
              emptyTitle="No employees match"
              exportName="employees"
            />
          )}
        </TabsContent>

        <TabsContent value="attendance">
          <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-4">
            <div className="space-y-1.5">
              <Label htmlFor="hr-att-date">Date</Label>
              <Input
                id="hr-att-date"
                type="date"
                value={attendanceDate}
                onChange={(e) => setAttendanceDate(e.target.value)}
                className="w-[180px]"
              />
            </div>
            {canManage ? (
              <Button variant="outline" size="sm" onClick={() => openPage(["attendance", "new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> Mark Attendance
              </Button>
            ) : null}
          </div>

          {attendanceLoading ? (
            <LoadingState label="Loading attendance…" />
          ) : attendance.length === 0 ? (
            <EmptyState
              title="No attendance records for this date"
              hint={canManage ? "Use Mark Attendance to record the register for this day." : "Nothing was recorded for this date."}
              action={canManage ? <Button size="sm" variant="outline" onClick={() => openPage(["attendance", "new"])}><Plus className="h-4 w-4 mr-1.5" /> Mark Attendance</Button> : undefined}
            />
          ) : (
            <DataTable
              columns={attendanceColumns}
              rows={attendance}
              rowKey={(a) => a.id}
              searchPlaceholder="Search employee…"
              emptyTitle="No records match"
              exportName={`attendance-${attendanceDate}`}
            />
          )}
        </TabsContent>

        <TabsContent value="leave">
          {leaveLoading ? (
            <LoadingState label="Loading leave requests…" />
          ) : leaves.length === 0 ? (
            <EmptyState
              title="No leave requests"
              hint="Requests submitted here appear in this list for approval."
              action={<Button size="sm" variant="outline" onClick={() => openPage(["leave", "new"])}><CalendarPlus className="h-4 w-4 mr-1.5" /> New Leave Request</Button>}
            />
          ) : (
            <DataTable
              columns={leaveColumns}
              rows={leaves}
              rowKey={(l) => l.id}
              searchPlaceholder="Search employee, reason…"
              emptyTitle="No requests match"
              exportName="leave-requests"
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
