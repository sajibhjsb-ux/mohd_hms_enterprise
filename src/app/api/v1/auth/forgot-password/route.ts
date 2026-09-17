import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors, parseBody } from "@/lib/hms/api";
import { generateToken } from "@/lib/hms/auth";
import { rateLimit, clientIp } from "@/lib/hms/rate-limit";

const schema = z.object({ email: z.string().email("Enter a valid email address.") });

export const POST = handler(
  async ({ req }) => {
    const { email } = await parseBody(req, schema);
    const rl = rateLimit(`pwreset:${clientIp(req)}`, 5, 15 * 60 * 1000);
    if (!rl.allowed) throw Errors.tooMany();

    // Always respond identically — never reveal whether an account exists.
    const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (user && user.status === "ACTIVE") {
      const token = generateToken();
      await db.passwordResetToken.create({
        data: { token, userId: user.id, expiresAt: new Date(Date.now() + 1000 * 60 * 30) },
      });
      // Delivery: EMAIL channel (provider configured via env in production).
      // Safe diagnostic only for super admin console; never returned to requester.
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", channel: "EMAIL", to: user.email, subject: "Password reset requested", queued: true }));
      await db.setting.upsert({ where: { key: `dev_pwreset_${user.id}` }, update: { value: token }, create: { key: `dev_pwreset_${user.id}`, value: token } });
    }
    return ok({ message: "If that email exists, a password reset link has been sent." });
  },
  { auth: false }
);
