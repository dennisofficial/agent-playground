"use client";

import { use } from "react";
import { useOrg } from "@/lib/api/me";
import { GeneralSection } from "@/features/settings/components/general-section";

export default function GeneralSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <GeneralSection org={org} />;
}
