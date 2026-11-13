import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";
import { createMfaChallenge } from "@/lib/hms/mfa/challenge";
import { ensureMfaPolicies, getMfaPolicy, type MfaPolicyMode } from "@/lib/hms/mfa/policy";

export type MfaGateResult =
  | { action: "allowed"; enrollmentWarning?: { deadline: string } }
  | { action: "challenge"; challenge: { token: string; expiresAt: Date } }
  | { action: "enroll"; challenge: { token: string; expiresAt: Date }; graceDeadline: string | null };

export function loginTtl(): number {
  return Number(process.env.MFA_CHALLENGE_TTL_SECONDS ?? 300) * 1000;
}

export function enrollTtl(): number {
  return Number(process.env.MFA_ENROLL_TTL_SECONDS ?? 900) * 1000;
}

export function decideMfaAction(input: {
  mfaEnabled: boolean;
  policyMode: MfaPolicyMode;
  graceUntil: Date | null;
  enforcementDisabled: boolean;
  now?: Date;
}): { action: "allowed" | "challenge" | "enroll"; graceDeadline: Date | null; warning: Date | null } {
  if (input.enforcementDisabled) return { action: "allowed", graceDeadline: null, warning: null };
  if (input.mfaEnabled) return { action: "challenge", graceDeadline: null, warning: null };
  if (input.policyMode !== "MANDATORY") return { action: "allowed", graceDeadline: null, warning: null };

  const now = input.now ?? new Date();
  if (input.graceUntil && input.graceUntil > now) {
    return { action: "allowed", graceDeadline: input.graceUntil, warning: input.graceUntil };
  }
  return { action: "enroll", graceDeadline: input.graceUntil, warning: null };
}

export async function resolveMfaGate(
  user: { id: string; email: string; role: string },
  ctx: { remember: boolean; ip?: string; userAgent?: string }
): Promise<MfaGateResult> {
  await ensureMfaPolicies();
  const enforcementDisabled = process.env.MFA_ENFORCEMENT_DISABLED === "true";

  if (enforcementDisabled) {
    await audit({ actorId: user.id, actorEmail: user.email, action: "MFA_ENFORCEMENT_BYPASSED", resourceType: "AUTH", ip: ctx.ip });
    return { action: "allowed" };
  }

  const [mfa, policy] = await Promise.all([db.userMfa.findUnique({ where: { userId: user.id } }), getMfaPolicy(user.role)]);
  const decision = decideMfaAction({
    mfaEnabled: !!mfa?.mfaEnabled,
    policyMode: policy.policyMode,
    graceUntil: mfa?.graceUntil ?? null,
    enforcementDisabled,
  });

  if (decision.action === "challenge") {
    const challenge = await createMfaChallenge({ userId: user.id, purpose: "LOGIN", ttlMs: loginTtl(), ...ctx });
    return { action: "challenge", challenge: { token: challenge.token, expiresAt: challenge.expiresAt } };
  }

  if (decision.action === "enroll") {
    await audit({ actorId: user.id, actorEmail: user.email, action: "MFA_ENROLLMENT_REQUIRED", resourceType: "AUTH", ip: ctx.ip });
    const challenge = await createMfaChallenge({ userId: user.id, purpose: "ENROLL", ttlMs: enrollTtl(), ...ctx });
    return {
      action: "enroll",
      challenge: { token: challenge.token, expiresAt: challenge.expiresAt },
      graceDeadline: decision.graceDeadline?.toISOString() ?? null,
    };
  }

  return decision.warning ? { action: "allowed", enrollmentWarning: { deadline: decision.warning.toISOString() } } : { action: "allowed" };
}
