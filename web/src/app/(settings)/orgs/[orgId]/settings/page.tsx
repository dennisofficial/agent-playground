import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/routes";

/** `/orgs/:orgId/settings` — the bare path has no content of its own; send it to the General section. */
export default async function OrgSettingsIndexPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  redirect(ROUTES.orgSettings(orgId, "general"));
}
