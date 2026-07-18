'use client';

import { auth } from '@/lib/auth';
import { useEffect } from 'react';

/**
 * Kicks the one-time session probe on app boot. Guards subscribe via `auth.onAuthStateChanged`
 * independently; `onAuthStateChanged` only fires once `initialize()` resolves, so calling it here
 * exactly once unblocks every guard. Renders nothing.
 */
export function AuthInitializer() {
  useEffect(() => {
    void auth.initialize();
  }, []);
  return null;
}
