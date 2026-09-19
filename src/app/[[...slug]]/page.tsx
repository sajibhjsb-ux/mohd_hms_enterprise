import type { Metadata } from "next";
import { db } from "@/lib/db";
import { SessionProvider } from "@/components/hms/session";
import { Gate } from "@/components/hms/gate";

type Params = { slug?: string[] };

/** SEO metadata for the public legal pages (spec §30). Everything else keeps
 *  the root layout defaults — the app itself is a gated SPA, not for indexing. */
const LEGAL_META: Record<string, { title: string; description: string }> = {
  terms: {
    title: "Terms & Conditions — MOHD.HMS ENTERPRISE",
    description:
      "Terms & Conditions for the MOHD.HMS ENTERPRISE smart facility maintenance platform: accounts, service requests, work orders, quotations, invoices, payments, platform usage and security.",
  },
  privacy: {
    title: "Privacy Policy — MOHD.HMS ENTERPRISE",
    description:
      "How MOHD.HMS ENTERPRISE collects, uses, shares and protects personal information across its smart facility maintenance platform.",
  },
};

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const first = slug?.[0];
  const meta = first ? LEGAL_META[first] : undefined;
  if (!meta) return {};
  // Canonical URL from the company's configured public website (a real,
  // admin-maintained setting) — omitted when it has not been configured.
  let canonical: string | undefined;
  try {
    const row = await db.setting.findUnique({ where: { key: "public_url" }, select: { value: true } });
    if (row?.value) canonical = new URL(`/${first}`, row.value).toString();
  } catch {
    // Canonical is optional — never fail the page for it.
  }
  return {
    title: meta.title,
    description: meta.description,
    ...(canonical ? { alternates: { canonical } } : {}),
    robots: { index: true, follow: true },
  };
}

export default function Page() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
