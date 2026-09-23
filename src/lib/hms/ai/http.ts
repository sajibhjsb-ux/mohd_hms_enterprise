// MOHD.HMS ENTERPRISE — AI API helpers: map central AIService failures to
// honest HTTP responses (spec §18/§19/§34 — never fake success, never leak
// credentials, machine-readable codes for the frontend).

import "server-only";
import { ApiError } from "@/lib/hms/api";

type AiFailure = { code: string; message: string };

export function aiFailureToApiError(failure: AiFailure): ApiError {
  switch (failure.code) {
    case "AI_DISABLED":
    case "AI_NOT_CONFIGURED":
      return new ApiError(503, failure.code, failure.message);
    case "AI_RATE_LIMITED":
      return new ApiError(429, "AI_RATE_LIMITED", failure.message);
    case "AI_AUTH_FAILED":
    case "AI_TIMEOUT":
    case "AI_PROVIDER_ERROR":
    case "AI_BAD_RESPONSE":
    default:
      return new ApiError(502, failure.code, failure.message);
  }
}
