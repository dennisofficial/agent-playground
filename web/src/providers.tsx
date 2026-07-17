"use client";

import { AuthInitializer } from "@/features/auth/components/auth-initializer";
import { ReduxProvider } from "@/redux/provider";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Client provider composition for the whole app:
 *  - Redux Toolkit store + RTK Query (REST reads/writes; SSE deltas patch the same cache).
 *  - AuthInitializer (one-time session probe).
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      value={{ light: "daylight", dark: "night" }}
      disableTransitionOnChange
    >
      <ReduxProvider>
        <AuthInitializer />
        {children}
      </ReduxProvider>
    </ThemeProvider>
  );
}
