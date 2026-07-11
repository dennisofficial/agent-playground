"use client";

import { use } from "react";
import { useOrg } from "@/lib/api/me";
import { SkillsSection } from "@/features/settings/components/skills-section";

export default function SkillsSettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const org = useOrg(orgId);
  if (!org) return null;
  return <SkillsSection orgId={org.id} role={org.role} />;
}
