/**
 * The employee registry. One process hosts every teammate; each is its own identity — own persona, chat
 * graph, checkpoint, memory owner, and job owner. Adding a teammate is one new file in this folder plus
 * one entry in `ROSTER` below; nothing else in the codebase needs to change.
 *
 * Mirrors the engine registry (`../engines/index.ts`): per-unit definitions imported here, exposed
 * through a small set of lookup/match helpers.
 */
import { alex } from './alex.js';
import { james } from './james.js';
import type { Employee } from './types.js';

export type { Employee } from './types.js';

export const ROSTER: Employee[] = [alex, james];

export const botById = (id: string): Employee | undefined => ROSTER.find((b) => b.id === id);

/** Roster employees @mentioned in a message (matches name or id, case-insensitive). */
export function mentionedBots(text: string): Employee[] {
  const handles = new Set((text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()));
  return ROSTER.filter((b) => handles.has(b.name.toLowerCase()) || handles.has(b.id));
}

/**
 * Roster employees ADDRESSED in a message — either @mentioned OR named outright ("Alex, can you…").
 * In a chat, using a teammate's name is addressing them, so it counts as a direct hail.
 */
export function addressedBots(text: string): Employee[] {
  const handles = new Set((text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()));
  return ROSTER.filter(
    (b) =>
      handles.has(b.name.toLowerCase()) ||
      handles.has(b.id) ||
      new RegExp(`\\b${b.name}\\b`, 'i').test(text) ||
      new RegExp(`\\b${b.id}\\b`, 'i').test(text),
  );
}

/** One-line roster summary for prompts ("Alex — backend engineer; James — marketing & analytics"). */
export const rosterSummary = (): string => ROSTER.map((b) => `${b.name} — ${b.role}`).join('; ');
