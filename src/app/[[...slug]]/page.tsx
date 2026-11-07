import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { SessionProvider } from "@/components/hms/session";
import { Gate } from "@/components/hms/gate";
import { NativeRuntime } from "@/lib/hms/native/runtime";
import RenderPage, { type Block } from "@/components/hms/modules/cms/page-renderer";

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

  // 1) Published CMS page → real CMS SEO metadata.
  try {
    const page = await db.page.findUnique({
      where: { slug: first ?? "" },
      select: { id: true, slug: true, title: true, seoTitle: true, seoDescription: true, status: true },
    });
    if (page && page.status === "PUBLISHED") {
      let canonical: string | undefined;
      try {
        const row = await db.setting.findUnique({ where: { key: "public_url" }, select: { value: true } });
        if (row?.value) canonical = new URL(`/${page.slug}`, row.value).toString();
      } catch {
        /* canonical optional */
      }
      return {
        title: page.seoTitle || page.title,
        description: page.seoDescription || undefined,
        ...(canonical ? { alternates: { canonical } } : {}),
        robots: { index: true, follow: true },
      };
    }
  } catch {
    /* fall through to legal-page / SPA behavior below */
  }

  // 2) Legal pages (static SEO) + gated SPA fallback.
  const meta = first ? LEGAL_META[first] : undefined;
  if (!meta) return notFound();
  let canonical: string | undefined;
  try {
    const row = await db.setting.findUnique({ where: { key: "public_url" }, select: { value: true } });
    if (row?.value) canonical = new URL(`/${first}`, row.value).toString();
  } catch {
    /* canonical optional */
  }
  return {
    title: meta.title,
    description: meta.description,
    ...(canonical ? { alternates: { canonical } } : {}),
    robots: { index: true, follow: true },
  };
}

export default function Page({ params }: { params: Params }) {
  const { slug } = params;
  const first = slug?.[0];

  return (
    <SessionProvider>
      <NativeRuntime />
      {/* Render a published CMS page when one matches the slug. */}
      {first ? (
        <CmsPageRenderer slug={first} />
      ) : (
        /* Root — keep the existing gated SPA shell. */
        <Gate />
      )}
    </SessionProvider>
  );
}

async function CmsPageRenderer({ slug }: { slug: string }) {
  const page = await db.page.findUnique({
    where: { slug },
    select: { id: true, title: true, content: true, status: true, updatedAt: true },
  });
  if (!page || page.status !== "PUBLISHED") return notFound();
  return (
    <div className="cms-public-page">
      <RenderPage blocks={(page.content as unknown as { blocks?: Block[] })?.blocks ?? ([] as Block[])} />
    </div>
  );
}
