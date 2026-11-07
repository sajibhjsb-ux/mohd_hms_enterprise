// MOHD.HMS ENTERPRISE — CMS page editor route (§CMS).
// Server component that loads a page and hands it to the visual page builder.

import { db } from "@/lib/db";
import { PageBuilder } from "@/components/hms/modules/cms/page-builder";

export default async function CmsPageEdit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await db.page.findUnique({
    where: { id },
    select: {
      id: true, slug: true, title: true, status: true, content: true,
      seoTitle: true, seoDescription: true, seoImage: true, publishedAt: true,
      updatedAt: true,
    },
  });
  if (!page) return <div className="p-6">Page not found.</div>;
  return <PageBuilder initialPage={page} />;
}
