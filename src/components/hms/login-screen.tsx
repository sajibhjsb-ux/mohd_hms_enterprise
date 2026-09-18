"use client";
// MOHD.HMS ENTERPRISE — authentication entry (composition root).
// The Gate renders <LoginScreen /> for unauthenticated visitors. The three
// screens (Welcome → Login → OTP verification) live in ./auth/* — a single
// unified mobile-first experience using the existing session context, auth
// APIs and routing. No duplicate auth system: see ./auth/auth-flow.tsx.

import { Suspense } from "react";
import { AuthFlowRoot } from "./auth/auth-flow";

export function LoginScreen() {
  return (
    <Suspense fallback={null}>
      <AuthFlowRoot />
    </Suspense>
  );
}
