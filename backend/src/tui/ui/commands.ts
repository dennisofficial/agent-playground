import { ConductorService } from '@harness/conductor/conductor.service';
import { DEFAULT_PROJECT } from '@harness/domain/identity';
import { TaskStore } from '@harness/memory/task-store';

/**
 * The slash-command plugin contract + registry. Each command owns its own recognition and declines
 * by returning `false`, so the caller falls through to channel submit. Adding a command = one entry
 * in `buildCommands`. (Ported from playground/src/ui/commands/* — the approval/board/metrics
 * commands return with their features; this pass carries /exit, /tasks, /as, /debug.)
 *
 * Unlike the playground (which imported singletons), commands receive their services through the
 * `buildCommands` factory — main.ts resolves them from the Nest container and hands them over.
 */

export interface CommandContext {
  /** Print a local-only transcript row (RenderItem kind:'note') — CLI output, never a channel message. */
  note(text: string): void;
  /** Quit the app (dumps the transcript to the restored screen, then Ink `useApp().exit`). */
  exit(): void;
  /** Toggle (or set) debug-row visibility; returns the new state. */
  setDebug(show?: boolean): boolean;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  /** Return `true` if THIS command recognized AND handled `text`; `false` to decline. */
  run(text: string, ctx: CommandContext): boolean;
}

export interface CommandDeps {
  conductor: ConductorService;
  tasks: TaskStore;
  project?: string;
}

export function buildCommands(deps: CommandDeps): Command[] {
  const exitCommand: Command = {
    name: 'exit',
    summary: '/exit (or /quit) — leave the app',
    run(text, ctx) {
      if (text !== '/exit' && text !== '/quit') return false;
      ctx.exit();
      return true;
    },
  };

  const tasksCommand: Command = {
    name: 'tasks',
    summary: '/tasks — list open reminders',
    run(text, ctx) {
      if (text !== '/tasks') return false;
      // listTasks is async now (Postgres); render when it lands — commands stay synchronous.
      void deps.tasks
        .listTasks({ project: deps.project ?? DEFAULT_PROJECT, status: 'open' })
        .then((tasks) =>
          ctx.note(
            tasks.length
              ? `Open reminders (${tasks.length}):\n` +
                  tasks.map((t) => `  #${t.id}  [${t.owner}]  ${t.description}`).join('\n')
              : 'No open reminders yet.',
          ),
        )
        .catch((err) => ctx.note(`Couldn't load reminders: ${err}`));
      return true;
    },
  };

  const asCommand: Command = {
    name: 'as',
    summary: '/as <name> — speak as someone else in the channel',
    run(text) {
      const m = text.match(/^\/as\s+(.+)$/i);
      if (!m) return false;
      deps.conductor.setSpeaker(m[1]);
      return true;
    },
  };

  const debugCommand: Command = {
    name: 'debug',
    summary: '/debug [on|off] — show/hide debug logs (gate, memory, tools)',
    run(text, ctx) {
      const m = text.match(/^\/debug(?:\s+(on|off))?$/i);
      if (!m) return false;
      const want = m[1] ? m[1].toLowerCase() === 'on' : undefined; // undefined → toggle
      const shown = ctx.setDebug(want);
      ctx.note(shown ? 'Debug logs shown.' : 'Debug logs hidden.');
      return true;
    },
  };

  return [exitCommand, tasksCommand, asCommand, debugCommand];
}

/** Run the first command that accepts `text`; return `false` if none did (caller falls through to chat). */
export function runCommand(commands: Command[], text: string, ctx: CommandContext): boolean {
  for (const cmd of commands) if (cmd.run(text, ctx)) return true;
  return false;
}
