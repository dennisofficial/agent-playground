"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import {
  AuthCard,
  AuthHeader,
  ErrorBanner,
} from "@/features/auth/components/auth-ui";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/routes";
import { validateEmail } from "@/lib/validation";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ee = validateEmail(email);
    setEmailErr(ee);
    if (ee) return;
    setBanner(null);
    setPending(true);
    try {
      await auth.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setBanner(
        err instanceof Error ? err.message : "Could not send the reset link.",
      );
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    await auth.requestPasswordReset(email.trim());
    setResent(true);
  }

  if (sent) {
    return (
      <AuthCard>
        <div className="flex flex-col items-center text-center">
          <CheckCircle2 size={36} style={{ color: "var(--green)" }} />
          <h1 className="mt-3 font-disp text-[20px] font-semibold text-text">
            Check your inbox
          </h1>
          <p className="mt-1 text-[13px] text-dim">
            We sent a reset link to{" "}
            <span className="font-medium text-text">{email.trim()}</span>.
          </p>
          <p className="mt-2 font-mono text-[10px] text-faint">
            link expires in 30 minutes
          </p>
          <div className="mt-5 flex w-full flex-col gap-2">
            <Button variant="ghost" block onClick={resend}>
              {resent ? "✓ Sent again just now" : "Resend email"}
            </Button>
            <Link
              href={ROUTES.auth.login()}
              className="inline-flex items-center justify-center gap-1.5 text-[12.5px] text-dim hover:text-text"
            >
              <ArrowLeft size={13} /> Back to sign in
            </Link>
          </div>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthHeader
        title="Reset your password"
        subtitle="Enter your email and we'll send a reset link."
      />
      <ErrorBanner message={banner} />
      <form onSubmit={onSubmit} className="flex flex-col gap-3.5" noValidate>
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailErr}
        />
        <Button
          type="submit"
          size="lg"
          block
          loading={pending}
          loadingText="Sending…"
        >
          Send reset link
        </Button>
      </form>
      <Link
        href={ROUTES.auth.login()}
        className="mt-5 inline-flex items-center justify-center gap-1.5 text-[12.5px] text-dim hover:text-text"
      >
        <ArrowLeft size={13} /> Back to sign in
      </Link>
    </AuthCard>
  );
}
