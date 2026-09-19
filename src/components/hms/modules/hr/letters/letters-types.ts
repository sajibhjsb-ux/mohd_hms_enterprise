"use client";

// MOHD.HMS ENTERPRISE — HR Letters: client-side reference data types
// (GET /api/v1/hr/letters/meta — SAFE fields only per spec §31/§32).

export type EmployeeMeta = {
  id: string;
  employeeNo: string;
  name: string;
  position: string;
  department: string;
  departmentId: string | null;
  joinDate: string | null;
  /** Present ONLY when the selected template declares a SALARY field (§31). */
  salaryCents?: number;
};

export type MetaData = {
  employees: EmployeeMeta[];
  customers: { id: string; code: string; companyName: string; contactPerson: string; address: string; city: string }[];
  projects: { id: string; code: string; name: string }[];
  quotations: { id: string; code: string }[];
  workOrders: { id: string; code: string; title: string }[];
};
