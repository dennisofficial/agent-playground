/**
 * The team roster. One process hosts every bot; each is its own identity — own persona, chat graph,
 * checkpoint, memory owner, and job owner. Adding a teammate is one entry here.
 */
export interface Bot {
  id: string;
  name: string;
  role: string;
}

export const ROSTER: Bot[] = [
  { id: 'alex', name: 'Alex', role: 'backend engineer' },
  { id: 'james', name: 'James', role: 'marketing & analytics' },
];

export const botById = (id: string): Bot | undefined => ROSTER.find((b) => b.id === id);

/** Roster bots @mentioned in a message (matches name or id, case-insensitive). */
export function mentionedBots(text: string): Bot[] {
  const handles = new Set((text.match(/@([\w-]+)/g) ?? []).map((m) => m.slice(1).toLowerCase()));
  return ROSTER.filter((b) => handles.has(b.name.toLowerCase()) || handles.has(b.id));
}

/**
 * Roster bots ADDRESSED in a message — either @mentioned OR named outright ("Alex, can you…").
 * In a chat, using a teammate's name is addressing them, so it counts as a direct hail.
 */
export function addressedBots(text: string): Bot[] {
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
