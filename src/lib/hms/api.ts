// MOHD.HMS ENTERPRISE — API framework: structured responses, centralized error
// handling, request IDs, structured logging, pagination/query parsing.

import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ZodError, ZodType } from "zod";
import { getSessionUser, SessionUser } from "./auth";
import { roleCan } from "./rbac";
import type { Permission } from "./constants";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (msg = "Invalid request.", details?: unknown) => new ApiError(400, "BAD_REQUEST", msg, details),
  unauthorized: (msg = "Authentication required.") => new ApiError(401, "UNAUTHORIZED", msg),
  forbidden: (msg = "You do not have permission to perform this action.") => new ApiError(403, "FORBIDDEN", msg),
  notFound: (msg = "Resource not found.") => new ApiError(404, "NOT_FOUND", msg),
  conflict: (msg = "The request conflicts with existing data.") => new ApiError(409, "CONFLICT", msg),
  invalidTransition: (msg: string) => new ApiError(422, "INVALID_TRANSITION", msg),
  tooMany: (msg = "Too many requests. Please slow down.") => new ApiError(429, "RATE_LIMITED", msg),
  internal: (msg = "Something went wrong. Please try again.") => new ApiError(500, "INTERNAL", msg),
  /**
   * 403 PROFILE_INCOMPLETE — a customer attempted a restricted job/service
   * request before completing the required profile (mobile number + address).
   * Machine-readable code lets the frontend route to the profile completion
   * page; details carry the specific missing fields.
   */
  profileIncomplete: (missingFields: string[] = []) =>
    new ApiError(
      403,
      "PROFILE_INCOMPLETE",
      "Please complete your mobile number and address before requesting a service.",
      { missingFields }
    ),
};

export function ok<T>(data: T, init?: number) {
  return NextResponse.json({ ok: true, data }, { status: init ?? 200 });
}

export function okList<T>(items: T[], meta?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, data: items, meta: meta ?? {} });
}

function safeErrorMessage(err: unknown, isSuperAdmin: boolean): { message: string; details?: unknown } {
  if (err instanceof ApiError) {
    // SUPER_ADMIN may receive safe diagnostic info
    if (isSuperAdmin && err.details) return { message: err.message, details: err.details };
    return { message: err.message };
  }
  return { message: "Something went wrong. Please try again." };
}

/**
 * Wrap a route handler with: request id, structured logging, centralized errors,
 * authentication + RBAC enforcement (backend authoritative).
 */
export function handler(
  fn: (ctx: { req: NextRequest; requestId: string; user: SessionUser }) => Promise<NextResponse> | NextResponse,
  opts?: { permission?: Permission; auth?: boolean }
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const requestId = randomUUID();
    const started = Date.now();
    const route = new URL(req.url).pathname;
    let status = 200;
    try {
      const needsAuth = opts?.auth !== false;
      const user = await getSessionUser();
      if (needsAuth && !user) throw Errors.unauthorized();
      if (opts?.permission && (!user || !roleCan(user.role, opts.permission))) {
        throw Errors.forbidden();
      }
      const res = await fn({ req, requestId, user: user as SessionUser });
      status = res.status;
      return res;
    } catch (err) {
      if (err instanceof ZodError) {
        status = 400;
        return NextResponse.json(
          { ok: false, error: { code: "VALIDATION_ERROR", message: "Please check the highlighted fields.", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })), requestId } },
          { status }
        );
      }
      const isApiErr = err instanceof ApiError;
      status = isApiErr ? err.status : 500;
      if (!isApiErr) {
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", requestId, route, msg: err instanceof Error ? err.message : String(err) }));
      }
      const isSuperAdmin = req.headers.get("x-hms-role") === "SUPER_ADMIN";
      const { message, details } = safeErrorMessage(err, isSuperAdmin);
      return NextResponse.json({ ok: false, error: { code: isApiErr ? err.code : "INTERNAL", message, details, requestId } }, { status });
    } finally {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", requestId, route, method: req.method, status, durationMs: Date.now() - started }));
    }
  };
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw Errors.badRequest("Request body must be valid JSON.");
  }
  return schema.parse(json);
}

export function listQuery(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(sp.get("pageSize") ?? "50", 10) || 50));
  const search = (sp.get("search") ?? "").trim();
  const status = (sp.get("status") ?? "").trim();
  const customerId = (sp.get("customerId") ?? "").trim();
  const sort = (sp.get("sort") ?? "").trim();
  const dir = sp.get("dir") === "asc" ? "asc" : "desc";
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize, search, status, customerId, sort, dir };
}

export function pagedMeta(page: number, pageSize: number, total: number) {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
