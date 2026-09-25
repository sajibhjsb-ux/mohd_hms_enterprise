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
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      // JSON is the default payload; multipart forms send their own Content-Type
      // (with boundary) — overriding it would silently break the upload.
      headers: { ...(isForm ? {} : { "Content-Type": "application/json" }), ...(init?.headers ?? {}) },
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
    // Central session-security interception (§11): the backend answers
    // 401 SESSION_REVOKED when this device's session was ended by a newer
    // login on another device (single-active-device policy). Dispatch ONCE
    // here with the precise code so every caller shares the same logout
    // flow — no per-page revocation logic anywhere.
    if (res.status === 401 && (err.code === "SESSION_REVOKED" || err.code === "SESSION_EXPIRED") && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("hms:session-expired", { detail: { code: err.code } }));
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
  /** Multipart upload — the browser sets the boundary automatically. */
  postForm: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form }),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
