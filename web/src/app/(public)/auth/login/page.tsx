"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  AuthCard,
  AuthHeader,
  ErrorBanner,
  OrDivider,
} from "@/features/auth/components/auth-ui";
import { GoogleButton } from "@/features/auth/components/google-button";
import { Button } from "@/components/ui/button";
import { Field, PasswordField } from "@/components/ui/field";
import { auth } from "@/lib/auth";
import { ROUTES, safeNext } from "@/lib/routes";
import { validateEmail, validatePasswordRequired } from "@/lib/validation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ee = validateEmail(email);
    const pe = validatePasswordRequired(password);
    setEmailErr(ee);
    setPwErr(pe);
    if (ee || pe) return;

    setBanner(null);
    setPending(true);
    try {
      await auth.signIn(email.trim(), password);
      const next =
        typeof window !== "undefined"
          ? new URLSearchParams(window.location.search).get("next")
          : null;
      router.replace(safeNext(next));
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Sign in failed.");
      setPending(false);
    }
  }

  return (
    <AuthCard>
      <AuthHeader
        title="Sign in to Atlas"
        subtitle="Operate your coding agents from one console."
      />
      <ErrorBanner message={banner} />

      <GoogleButton
        label="Continue with Google"
        onError={(m) => setBanner(m || null)}
      />
      <OrDivider />

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
        <PasswordField
          label="Password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={pwErr}
          labelAside={
            <Link
              href={ROUTES.auth.forgot()}
              className="text-[11.5px] text-accent hover:underline"
            >
              Forgot?
            </Link>
          }
        />
        <Button
          type="submit"
          size="lg"
          block
          loading={pending}
          loadingText="Signing in…"
        >
          Sign in
        </Button>
      </form>

      <p className="mt-5 text-center text-[12.5px] text-dim">
        New to Atlas?{" "}
        <Link
          href={ROUTES.auth.signup()}
          className="font-medium text-accent hover:underline"
        >
          Create an account
        </Link>
      </p>
    </AuthCard>
  );
}
