/** Uniform action state for useActionState. Lives outside actions.ts — a 'use server' file may
 * only export async functions, not values. */
export type ActionState = { ok: boolean; error?: string };

export const IDLE: ActionState = { ok: false };
