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
import { Field, PasswordField, StrengthMeter } from "@/components/ui/field";
import { auth } from "@/lib/auth";
import { ROUTES } from "@/lib/routes";
import {
  validateEmail,
  validateNameRequired,
  validatePasswordMin,
} from "@/lib/validation";

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [emailErr, setEmailErr] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ne = validateNameRequired(name);
    const ee = validateEmail(email);
    const pe = validatePasswordMin(password);
    setNameErr(ne);
    setEmailErr(ee);
    setPwErr(pe);
    if (ne || ee || pe) return;

    setBanner(null);
    setPending(true);
    try {
      await auth.register(email.trim(), password, name);
      router.replace(ROUTES.workspace());
    } catch (err) {
      setBanner(
        err instanceof Error ? err.message : "Could not create your account.",
      );
      setPending(false);
    }
  }

  return (
    <AuthCard>
      <AuthHeader
        title="Create your Atlas account"
        subtitle="Spin up isolated coding sessions in minutes."
      />
      <ErrorBanner message={banner} />

      <GoogleButton
        label="Sign up with Google"
        onError={(m) => setBanner(m || null)}
      />
      <OrDivider />

      <form onSubmit={onSubmit} className="flex flex-col gap-3.5" noValidate>
        <Field
          label="Full name"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameErr}
        />
        <Field
          label="Work email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailErr}
        />
        <div className="flex flex-col gap-2">
          <PasswordField
            label="Password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={pwErr}
          />
          <StrengthMeter password={password} />
        </div>
        <Button
          type="submit"
          size="lg"
          block
          loading={pending}
          loadingText="Creating account…"
        >
          Create account
        </Button>
      </form>

      <p className="mt-4 text-center text-[11px] text-faint">
        By creating an account you agree to the Terms and Privacy Policy.
      </p>
      <p className="mt-3 text-center text-[12.5px] text-dim">
        Already have an account?{" "}
        <Link
          href={ROUTES.auth.login()}
          className="font-medium text-accent hover:underline"
        >
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
