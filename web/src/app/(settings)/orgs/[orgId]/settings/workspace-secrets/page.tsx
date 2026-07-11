"use client";

import { use } from "react";
import { useOrg } from "@/lib/api/me";
import { WorkspaceSecretsSection } from "@/features/settings/components/workspace-secrets-section";

export default function WorkspaceSecretsSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <WorkspaceSecretsSection orgId={org.id} role={org.role} />;
}
