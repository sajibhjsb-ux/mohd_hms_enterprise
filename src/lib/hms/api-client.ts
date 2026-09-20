"use client";
// MOHD.HMS ENTERPRISE — client API wrapper: credentials + structured error surfacing

export type ApiEnvelope<T> = { ok: true; data: T; meta?: Record<string, unknown> };
export type ApiErrorEnvelope = { ok: false; error: { code: string; message: string; details?: unknown; requestId?: string } };

export class ClientApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiEnvelope<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ClientApiError("Network error. Check your connection and try again.", "NETWORK", 0);
  }
  let body: ApiEnvelope<T> | ApiErrorEnvelope | null = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !body || body.ok === false) {
    const err = body && body.ok === false ? body.error : { code: "UNKNOWN", message: "Something went wrong. Please try again." };
    // Central session-expired interception (§17): the backend answers
    // 401 SESSION_EXPIRED when the idle timeout has passed. Dispatch ONCE
    // here so every caller shares the same logout flow — no per-call logic.
    if (res.status === 401 && err.code === "SESSION_EXPIRED" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("hms:session-expired"));
    }
    throw new ClientApiError(err.message, err.code, res.status, (err as { details?: unknown }).details);
  }
  return body;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(data ?? {}) }),
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(data ?? {}) }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(data ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
