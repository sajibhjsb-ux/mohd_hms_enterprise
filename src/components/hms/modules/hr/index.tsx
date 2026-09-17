"use client";

// HR module — workforce overview (headcount, attendance KPIs, 7-day trend),
// read-only employee register, attendance marking and leave approval workflow.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Users, UserCheck, CalendarOff, UserX, Clock, CalendarPlus, Plus, Check, X, Info,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, toDateInput } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import {
  EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge,
} from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

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

type Option = { id: string; label: string };

const LEAVE_TYPES = ["ANNUAL", "SICK", "UNPAID", "OTHER"];
const ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LEAVE", "HALF_DAY"];

const todayInput = () => toDateInput(new Date());

export function HrModule() {
  const { user } = useSession();
  const { toast } = useToast();

  const canManage = hasPerm(user, PERMISSIONS.hr_manage);
  const canReadEmployees = hasPerm(user, PERMISSIONS.employees_read) || canManage;
  const canFileForOthers = canManage || user?.role === "SUPER_ADMIN" || user?.role === "ADMIN";

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

  const [tab, setTab] = useState("attendance");

  // ── Dialogs ──
  const [markOpen, setMarkOpen] = useState(false);
  const [markSaving, setMarkSaving] = useState(false);
  const [markForm, setMarkForm] = useState({
    employeeId: "",
    date: todayInput(),
    status: "PRESENT",
    checkIn: "08:00",
    checkOut: "17:00",
    notes: "",
  });

  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveSaving, setLeaveSaving] = useState(false);
  const [leaveForm, setLeaveForm] = useState({
    employeeId: "",
    type: "ANNUAL",
    startDate: todayInput(),
    endDate: todayInput(),
    reason: "",
  });

  const [deptOpen, setDeptOpen] = useState(false);
  const [deptSaving, setDeptSaving] = useState(false);
  const [deptForm, setDeptForm] = useState({ name: "", description: "" });

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

  const employeeOptions = useMemo<Option[]>(() => {
    if (employees === null) return [];
    return employees.map((e) => ({ id: e.id, label: `${e.firstName} ${e.lastName} (${e.employeeNo})` }));
  }, [employees]);

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

  // ── Attendance mark (upsert) ──
  const openMark = (record?: AttendanceRecord) => {
    setMarkForm({
      employeeId: record?.employee.id ?? "",
      date: record ? toDateInput(record.date) : attendanceDate,
      status: record?.status ?? "PRESENT",
      checkIn: record?.checkIn ? new Date(record.checkIn).toTimeString().slice(0, 5) : "08:00",
      checkOut: record?.checkOut ? new Date(record.checkOut).toTimeString().slice(0, 5) : "17:00",
      notes: record?.notes ?? "",
    });
    setMarkOpen(true);
  };

  const saveMark = async () => {
    if (!markForm.employeeId) {
      toast({ title: "Select an employee", variant: "destructive" });
      return;
    }
    setMarkSaving(true);
    try {
      const existing = attendance.find((a) => a.employee.id === markForm.employeeId);
      await api.post("/api/v1/hr/attendance", {
        employeeId: markForm.employeeId,
        date: markForm.date,
        status: markForm.status,
        checkIn: ["PRESENT", "HALF_DAY"].includes(markForm.status) ? markForm.checkIn || null : null,
        checkOut: ["PRESENT", "HALF_DAY"].includes(markForm.status) ? markForm.checkOut || null : null,
        notes: markForm.notes || null,
      });
      toast({
        title: existing ? "Attendance updated" : "Attendance marked",
        description: `${humanize(markForm.status)} on ${markForm.date}.`,
      });
      setMarkOpen(false);
      await Promise.all([loadAttendance(), loadOverview()]);
    } catch (e) {
      toast({ title: "Could not mark attendance", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setMarkSaving(false);
    }
  };

  // ── Leave actions ──
  const saveLeave = async () => {
    if (leaveForm.endDate < leaveForm.startDate) {
      toast({ title: "End date cannot be before start date", variant: "destructive" });
      return;
    }
    setLeaveSaving(true);
    try {
      await api.post("/api/v1/hr/leave", {
        employeeId: canFileForOthers && leaveForm.employeeId ? leaveForm.employeeId : undefined,
        type: leaveForm.type,
        startDate: leaveForm.startDate,
        endDate: leaveForm.endDate,
        reason: leaveForm.reason,
      });
      toast({ title: "Leave request submitted", description: "It is now pending approval." });
      setLeaveOpen(false);
      setLeaveForm({ employeeId: "", type: "ANNUAL", startDate: todayInput(), endDate: todayInput(), reason: "" });
      await Promise.all([loadLeaves(), loadOverview()]);
    } catch (e) {
      toast({ title: "Could not submit request", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setLeaveSaving(false);
    }
  };

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

  // ── Department create ──
  const saveDepartment = async () => {
    if (!deptForm.name.trim()) {
      toast({ title: "Department name is required", variant: "destructive" });
      return;
    }
    setDeptSaving(true);
    try {
      await api.post("/api/v1/hr/departments", { name: deptForm.name.trim(), description: deptForm.description.trim() });
      toast({ title: "Department created", description: deptForm.name.trim() });
      setDeptForm({ name: "", description: "" });
      setDeptOpen(false);
      await loadOverview();
    } catch (e) {
      toast({ title: "Could not create department", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDeptSaving(false);
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
            <Button variant="outline" size="sm" onClick={() => openMark(a)} aria-label={`Edit attendance for ${a.employee.employeeNo}`}>
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
              <Button variant="outline" size="sm" onClick={() => openMark()} disabled={employees === null && employeeOptions.length === 0}>
                <Clock className="h-4 w-4 mr-1.5" /> Mark Attendance
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLeaveOpen(true)}>
                <CalendarPlus className="h-4 w-4 mr-1.5" /> New Leave Request
              </Button>
              <Button size="sm" onClick={() => setDeptOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" /> Department
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setLeaveOpen(true)}>
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
                  <Button variant="ghost" size="sm" onClick={() => setDeptOpen(true)} aria-label="Add department">
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
          <TabsTrigger value="employees"><Users className="h-4 w-4 mr-1.5" /> Employees</TabsTrigger>
          <TabsTrigger value="attendance"><Clock className="h-4 w-4 mr-1.5" /> Attendance</TabsTrigger>
          <TabsTrigger value="leave"><CalendarPlus className="h-4 w-4 mr-1.5" /> Leave</TabsTrigger>
        </TabsList>

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
              <Button variant="outline" size="sm" onClick={() => openMark()} disabled={employees === null && employeeOptions.length === 0}>
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
              action={canManage ? <Button size="sm" variant="outline" onClick={() => openMark()}><Plus className="h-4 w-4 mr-1.5" /> Mark Attendance</Button> : undefined}
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
              action={<Button size="sm" variant="outline" onClick={() => setLeaveOpen(true)}><CalendarPlus className="h-4 w-4 mr-1.5" /> New Leave Request</Button>}
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

      {/* ── Mark attendance dialog ── */}
      <Dialog open={markOpen} onOpenChange={setMarkOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Mark Attendance</DialogTitle>
            <DialogDescription>Recording is idempotent — marking the same employee and day again updates the record.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Employee *</Label>
              <Select value={markForm.employeeId || undefined} onValueChange={(v) => setMarkForm((f) => ({ ...f, employeeId: v }))}>
                <SelectTrigger aria-label="Employee"><SelectValue placeholder={employeeOptions.length === 0 ? "Employee list unavailable" : "Select employee"} /></SelectTrigger>
                <SelectContent>
                  {employeeOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mark-date">Date</Label>
              <Input id="mark-date" type="date" value={markForm.date} onChange={(e) => setMarkForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={markForm.status} onValueChange={(v) => setMarkForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger aria-label="Attendance status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ATTENDANCE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mark-in">Check In</Label>
              <Input
                id="mark-in" type="time" value={markForm.checkIn}
                onChange={(e) => setMarkForm((f) => ({ ...f, checkIn: e.target.value }))}
                disabled={!["PRESENT", "HALF_DAY"].includes(markForm.status)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mark-out">Check Out</Label>
              <Input
                id="mark-out" type="time" value={markForm.checkOut}
                onChange={(e) => setMarkForm((f) => ({ ...f, checkOut: e.target.value }))}
                disabled={!["PRESENT", "HALF_DAY"].includes(markForm.status)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="mark-notes">Notes</Label>
              <Textarea id="mark-notes" rows={2} value={markForm.notes} onChange={(e) => setMarkForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional remarks…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarkOpen(false)} disabled={markSaving}>Cancel</Button>
            <Button onClick={() => void saveMark()} disabled={markSaving}>
              {markSaving ? "Saving…" : "Save Attendance"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New leave request dialog ── */}
      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Leave Request</DialogTitle>
            <DialogDescription>
              {canFileForOthers
                ? "File on behalf of any employee, or leave the employee blank to file for yourself."
                : "The request will be filed against your own employee record and sent for approval."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
            {canFileForOthers ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Employee</Label>
                <Select
                  value={leaveForm.employeeId || "SELF"}
                  onValueChange={(v) => setLeaveForm((f) => ({ ...f, employeeId: v === "SELF" ? "" : v }))}
                >
                  <SelectTrigger aria-label="Employee"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SELF">Myself</SelectItem>
                    {employeeOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={leaveForm.type} onValueChange={(v) => setLeaveForm((f) => ({ ...f, type: v }))}>
                <SelectTrigger aria-label="Leave type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LEAVE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-start">Start Date</Label>
              <Input id="leave-start" type="date" value={leaveForm.startDate} onChange={(e) => setLeaveForm((f) => ({ ...f, startDate: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="leave-end">End Date</Label>
              <Input id="leave-end" type="date" value={leaveForm.endDate} onChange={(e) => setLeaveForm((f) => ({ ...f, endDate: e.target.value }))} />
              <p className="text-xs text-muted-foreground">Days are computed automatically (inclusive).</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="leave-reason">Reason</Label>
              <Textarea id="leave-reason" rows={3} value={leaveForm.reason} onChange={(e) => setLeaveForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Brief reason for the request…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaveOpen(false)} disabled={leaveSaving}>Cancel</Button>
            <Button onClick={() => void saveLeave()} disabled={leaveSaving}>
              {leaveSaving ? "Submitting…" : "Submit Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── New department dialog ── */}
      <Dialog open={deptOpen} onOpenChange={setDeptOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Department</DialogTitle>
            <DialogDescription>Department names must be unique.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="dept-name">Name *</Label>
              <Input id="dept-name" value={deptForm.name} onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))} placeholder="Field Operations" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dept-desc">Description</Label>
              <Textarea id="dept-desc" rows={2} value={deptForm.description} onChange={(e) => setDeptForm((f) => ({ ...f, description: e.target.value }))} placeholder="What this team does…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeptOpen(false)} disabled={deptSaving}>Cancel</Button>
            <Button onClick={() => void saveDepartment()} disabled={deptSaving}>
              {deptSaving ? "Creating…" : "Create Department"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
