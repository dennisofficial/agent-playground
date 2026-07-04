"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { AuthCard } from "@/features/auth/components/auth-ui";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/routes";

export default function SignedOutPage() {
  const router = useRouter();
  return (
    <AuthCard>
      <div className="flex flex-col items-center text-center">
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full"
          style={{ background: "var(--surface-2)", color: "var(--dim)" }}
        >
          <LogOut size={20} />
        </span>
        <h1 className="mt-3 font-disp text-[20px] font-semibold text-text">
          You&apos;ve been signed out
        </h1>
        <p className="mt-1.5 text-[13px] text-dim">
          Your session on this device has ended. Active threads keep running on
          the harness.
        </p>
        <Button
          className="mt-5"
          size="lg"
          block
          onClick={() => router.replace(ROUTES.auth.login())}
        >
          Sign back in
        </Button>
      </div>
    </AuthCard>
  );
}
