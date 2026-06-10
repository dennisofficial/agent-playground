'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  createProject,
  deleteToken,
  putToken,
  setDefaultToken,
  updateProject,
} from '@/lib/admin-api';
import {
  adminConfigured,
  assertAdmin,
  checkLoginToken,
  clearAdminCookie,
  setAdminCookie,
} from '@/lib/admin-auth';

import type { ActionState } from './action-state';

const str = (fd: FormData, key: string): string => String(fd.get(key) ?? '').trim();

/** Every mutation: cookie gate first, friendly error out, revalidate on success. */
async function guarded(fn: () => Promise<void>): Promise<ActionState> {
  const denied = await assertAdmin();
  if (denied) return { ok: false, error: denied };
  try {
    await fn();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/admin');
  return { ok: true };
}

// ── auth ─────────────────────────────────────────────────────────────────────────────────────────

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!adminConfigured()) {
    return {
      ok: false,
      error: 'ADMIN_API_TOKEN is not set for the web app — add it to web/.env.personal first.',
    };
  }
  const token = str(formData, 'token');
  if (!checkLoginToken(token)) return { ok: false, error: 'That is not the admin token.' };
  await setAdminCookie(token);
  redirect('/admin');
}

export async function logoutAction(): Promise<void> {
  await clearAdminCookie();
  redirect('/admin/login');
}

// ── projects ─────────────────────────────────────────────────────────────────────────────────────

export async function createProjectAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    await createProject({
      projectId: str(formData, 'projectId'),
      displayName: str(formData, 'displayName'),
      gitUrl: str(formData, 'gitUrl'),
      ...(str(formData, 'defaultBranch') ? { defaultBranch: str(formData, 'defaultBranch') } : {}),
      ...(str(formData, 'tokenName') ? { tokenName: str(formData, 'tokenName') } : {}),
    });
  });
}

export async function updateProjectAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    await updateProject(str(formData, 'projectId'), {
      displayName: str(formData, 'displayName'),
      gitUrl: str(formData, 'gitUrl'),
      defaultBranch: str(formData, 'defaultBranch') || 'main',
      // Empty select = clear the override back to the default token.
      tokenName: str(formData, 'tokenName') || null,
    });
  });
}

// ── tokens ───────────────────────────────────────────────────────────────────────────────────────

export async function putTokenAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    await putToken({
      name: str(formData, 'name'),
      token: str(formData, 'token'), // passes straight through; never echoed into state
      ...(formData.get('default') ? { default: true } : {}),
    });
  });
}

export async function setDefaultTokenAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return guarded(() => setDefaultToken(str(formData, 'name')).then(() => undefined));
}

export async function deleteTokenAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return guarded(() => deleteToken(str(formData, 'name')).then(() => undefined));
}
