// MOHD.HMS ENTERPRISE — canonical customer profile state.
// One authoritative definition of "profile complete" for customer identities:
//   profileComplete = Customer.phone (mobile) non-empty AND Customer.address non-empty
// Company name is deliberately OPTIONAL and never affects completeness.
// The state is DERIVED from the actual Customer row (never a stored boolean),
// so it can never drift from the real data (spec §9).
//
// Backend-authoritative: every customer job/service request entry point must
// call assertCustomerProfileComplete() — frontend checks are UX hints only.

import "server-only";
import type { Prisma, Customer } from "@prisma/client";
import { db } from "@/lib/db";
import { Errors } from "./api";
import { nextNumber } from "./services";

export type CustomerProfileState = {
  /** True for staff roles (never onboarded) and for customers with mobile + address. */
  profileComplete: boolean;
  /** Machine-readable missing fields, e.g. ["mobile", "address"]. */
  missingFields: string[];
};

/** Derive missing required fields from the actual customer row. */
export function missingCustomerFields(
  customer: Pick<Customer, "phone" | "address"> | null | undefined
): string[] {
  const missing: string[] = [];
  if (!customer || !customer.phone.trim()) missing.push("mobile");
  if (!customer || !customer.address.trim()) missing.push("address");
  return missing;
}

/** Load the derived profile state for the given account (one DB query max).
 *  Accepts any { role, customerId } shape (SessionUser or raw Prisma User). */
export async function customerProfileState(user: {
  role: string;
  customerId: string | null;
}): Promise<CustomerProfileState> {
  if (user.role !== "CUSTOMER") return { profileComplete: true, missingFields: [] };
  const customer = user.customerId
    ? await db.customer.findUnique({
        where: { id: user.customerId },
        select: { phone: true, address: true },
      })
    : null;
  const missingFields = missingCustomerFields(customer);
  return { profileComplete: missingFields.length === 0, missingFields };
}

/** Guard for restricted customer actions — throws the machine-readable error. */
export async function assertCustomerProfileComplete(user: {
  role: string;
  customerId: string | null;
}): Promise<void> {
  if (user.role !== "CUSTOMER") return;
  const state = await customerProfileState(user);
  if (!state.profileComplete) {
    throw Errors.profileIncomplete(state.missingFields);
  }
}

export type ProvisionCustomerInput = {
  name: string;
  email: string;
  phone?: string;
  address?: string;
  companyName?: string;
  city?: string;
};

/**
 * Customer code for a new identity. MUST be called BEFORE the caller's
 * transaction — nextNumber() writes via the global db client, which would
 * deadlock on SQLite inside one (project convention, see users POST).
 */
export function newCustomerCode(): Promise<string> {
  return nextNumber("CUS");
}

/**
 * Create the canonical Customer identity for a portal user (Google
 * provisioning, admin user creation, or repair of legacy unclassified users).
 * Company name is optional; mobile/address start empty and are completed
 * during mandatory profile onboarding.
 */
export async function createCustomerRecord(
  tx: Prisma.TransactionClient,
  code: string,
  data: ProvisionCustomerInput
): Promise<Customer> {
  return tx.customer.create({
    data: {
      code,
      companyName: data.companyName?.trim() ?? "",
      contactPerson: data.name.trim() || data.email.split("@")[0],
      email: data.email.toLowerCase().trim(),
      phone: data.phone?.trim() ?? "",
      address: data.address?.trim() ?? "",
      ...(data.city?.trim() ? { city: data.city.trim() } : {}),
    },
  });
}
