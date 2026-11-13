import { generate, generateSecret, generateURI, verify } from "otplib";

export const TOTP_ISSUER = "MOHD.HMS ENTERPRISE";
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function createTotpSecret(): string {
  return generateSecret();
}

export function totpUri(secret: string, email: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: email, secret, period: TOTP_PERIOD_SECONDS, digits: TOTP_DIGITS });
}

export async function totpCodeAt(secret: string, epoch: number, digits = TOTP_DIGITS): Promise<string> {
  return generate({ secret, epoch, period: TOTP_PERIOD_SECONDS, digits, algorithm: "sha1" });
}

export async function verifyTotp(
  secret: string,
  token: string,
  afterTimeStep: number | null
): Promise<{ valid: boolean; timeStep: number | null }> {
  const result = await verify({
    secret,
    token,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    algorithm: "sha1",
    epochTolerance: Number(process.env.MFA_TOTP_TOLERANCE_SECONDS ?? 30),
    ...(afterTimeStep === null ? {} : { afterTimeStep }),
  });
  return result.valid ? { valid: true, timeStep: result.timeStep ?? null } : { valid: false, timeStep: null };
}
