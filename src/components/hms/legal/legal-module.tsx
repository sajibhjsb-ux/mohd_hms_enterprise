"use client";

// MOHD.HMS ENTERPRISE — in-app legal pages (/terms, /privacy).
// Registered in the module registry with navHidden: true (entered from the
// footer, the auth screens, the profile page and document references — no
// extra top-level navigation per spec §27). Same canonical document, same
// renderer as the public page — one source, one presentation.

import { LegalPageView } from "./legal-page-view";
import type { LegalKind } from "@/lib/hms/legal/types";

function LegalModule({ kind }: { kind: LegalKind }) {
  return (
    <LegalPageView
      kind={kind}
      className="py-2"
      // Both legal pages are registered SPA modules → navigate internally so
      // Back/Forward keep working exactly like everywhere else in the shell.
      onNavigate={(path) => {
        const moduleKey = path.replace(/^\//, "");
        // Imported lazily to avoid a router<->view cycle at module scope.
        void import("@/lib/hms/router").then(({ navigateTo }) => navigateTo(moduleKey));
      }}
    />
  );
}

export function TermsModule() {
  return <LegalModule kind="TERMS" />;
}

export function PrivacyModule() {
  return <LegalModule kind="PRIVACY" />;
}
