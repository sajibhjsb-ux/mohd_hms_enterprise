import { z } from "zod";
import { handler, ok, parseBody, Errors, ApiError } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { AI_FIELDS, generateInspectionText, type AiContext } from "@/lib/hms/ai";

const contextSchema = z.object({
  title: z.string().max(200).optional(),
  type: z.string().max(40).optional(),
  overallCondition: z.string().max(40).optional(),
  findings: z
    .array(
      z.object({
        finding: z.string().max(2000).optional(),
        severity: z.string().max(20).optional(),
        recommendation: z.string().max(2000).optional(),
      })
    )
    .max(20)
    .optional(),
  scope: z.string().max(8000).optional(),
  equipment: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  hint: z.string().max(2000).optional(),
});

const generateSchema = z.object({
  field: z.enum(AI_FIELDS),
  context: contextSchema.default({}),
});

/**
 * 15. POST /api/v1/irms/ai/generate (CREATE | MANAGE) — draft-text assistance.
 * Never auto-saves; the frontend previews first and inserts only on confirm (§10).
 */
export const POST = handler(
  async ({ req, user }) => {
    // CREATE | MANAGE — either permission qualifies (contract auth vocabulary).
    if (!roleCan(user.role, PERMISSIONS.irms_create) && !roleCan(user.role, PERMISSIONS.irms_manage)) {
      throw Errors.forbidden();
    }
    const body = await parseBody(req, generateSchema);

    const text = await generateInspectionText(body.field, body.context as AiContext);
    if (!text) {
      // 502-style structured error; SUPER_ADMIN receives detail via handler().
      throw new ApiError(502, "AI_GENERATION_FAILED", "The AI assistant is unavailable right now. Please try again in a moment, or write the section manually.");
    }
    return ok({ text });
  },
  { auth: true } // permission enforced above (CREATE | MANAGE)
);
