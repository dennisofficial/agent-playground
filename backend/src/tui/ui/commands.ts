import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { ConductorService } from '@harness/conductor/conductor.service';
import { DEFAULT_PROJECT } from '@harness/domain/identity';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { MemoryMetricsService } from '@harness/memory/memory-metrics.service';
import { TaskStore } from '@harness/memory/task-store';
import type { TuiChatSurface } from '../tui-chat-surface';

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
  /** Focus a room: the transcript filters to it and `send()` posts into it. */
  setActiveChannel(channelId: string): void;
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
  registry: ChannelRegistryService;
  employees: EmployeeRegistry;
  surface: TuiChatSurface;
  metrics: MemoryMetricsService;
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
        .listTasks({
          team: deps.registry.teamIdOf(deps.surface.activeChannel),
          project: deps.project ?? DEFAULT_PROJECT,
          status: 'open',
        })
        .then((tasks) =>
          ctx.note(
            tasks.length
              ? `Open reminders (${tasks.length}):\n` +
                  tasks
                    .map((t) => `  #${t.id}  [${t.owner}]  ${t.description}`)
                    .join('\n')
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

  const roomCommand: Command = {
    name: 'room',
    summary:
      '/room <name> [bot,bot…] — create or switch to a project room (room name = its memory project)',
    run(text, ctx) {
      const m = text.match(/^\/room\s+(\S+)(?:\s+(.+))?$/i);
      if (!m) return false;
      const name = m[1].toLowerCase().replace(/^#/, '');
      // Resolve an existing room by its full channelId first ('/room tui:main' must switch to the
      // default room, not mint a 'tui:tui:main'), then by the tui-prefixed short name.
      const channelId = deps.registry.get(name) ? name : `tui:${name}`;
      const existing = deps.registry.get(channelId);
      if (!existing) {
        const allBots = deps.employees.list().map((b) => b.id);
        const requested = m[2]
          ?.split(/[,\s]+/)
          .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
          .filter(Boolean);
        const unknown = requested?.filter((id) => !allBots.includes(id)) ?? [];
        if (unknown.length) {
          ctx.note(
            `Unknown teammate(s): ${unknown.join(', ')}. Roster: ${allBots.join(', ')}.`,
          );
          return true;
        }
        const members = requested?.length ? requested : allBots;
        deps.registry.ensure({
          channelId,
          kind: 'channel',
          project: name,
          members,
          displayName: name,
        });
        ctx.note(
          `Created #${name} (project '${name}') with ${members.join(', ')}.`,
        );
      } else {
        ctx.note(`Switched to #${existing.displayName}.`);
      }
      ctx.setActiveChannel(channelId);
      return true;
    },
  };

  const dmCommand: Command = {
    name: 'dm',
    summary: '/dm <bot> — open (or switch to) a private 1:1 with a teammate',
    run(text, ctx) {
      const m = text.match(/^\/dm\s+(\S+)$/i);
      if (!m) return false;
      const botId = m[1].toLowerCase().replace(/^@/, '');
      const bot = deps.employees.byId(botId);
      if (!bot) {
        ctx.note(
          `No teammate '${botId}'. Roster: ${deps.employees
            .list()
            .map((b) => b.id)
            .join(', ')}.`,
        );
        return true;
      }
      // Two-party id — a DM belongs to a (bot, human) PAIR, so a bot's send_message to a human and
      // that human's /dm land in the SAME room (and another human's DM with the same bot doesn't).
      const speaker = deps.conductor.speaker;
      const channelId = `tui:dm:${botId}:${speaker}`;
      if (!deps.registry.get(channelId)) {
        // A DM is WORKSPACE-level, not project-bound — the row's project is only the reminders
        // home; recall spans every project the pair shares (see ConductorService.identityFor).
        deps.registry.ensure({
          channelId,
          kind: 'dm',
          project: deps.project ?? DEFAULT_PROJECT,
          members: [botId, speaker],
          displayName: `dm:${botId}:${speaker}`,
        });
        ctx.note(`Opened a DM with ${bot.name}.`);
      } else {
        ctx.note(`Switched to your DM with ${bot.name}.`);
      }
      ctx.setActiveChannel(channelId);
      return true;
    },
  };

  const roomsCommand: Command = {
    name: 'rooms',
    summary: '/rooms — list rooms and DMs',
    run(text, ctx) {
      if (text !== '/rooms' && text !== '/channels') return false;
      const active = deps.surface.activeChannel;
      // Label each room by the handle that SWITCHES to it (channelId-derived, unique) — displaying
      // anything else invites typing a name that mints a duplicate room.
      const handle = (c: { channelId: string; kind: string }) =>
        c.kind === 'dm'
          ? `@${c.channelId.replace(/^tui:dm:/, '')}  (/dm ${c.channelId.replace(/^tui:dm:/, '').split(':')[0]})`
          : `#${c.channelId.replace(/^tui:/, '')}`;
      const lines = deps.registry.list().map(
        (c) =>
          `  ${c.channelId === active ? '▸' : ' '} ${handle(c)}  (${
            // A DM is workspace-level — showing its (reminders-home) project would imply binding.
            c.kind === 'dm' ? 'dm' : `${c.kind}, project '${c.project}'`
          }, members: ${c.members.join(', ') || '—'})`,
      );
      ctx.note(lines.length ? `Rooms:\n${lines.join('\n')}` : 'No rooms yet.');
      return true;
    },
  };

  const metricsCommand: Command = {
    name: 'metrics',
    summary: '/metrics — memory health this session (recall hit-rate, writes)',
    run(text, ctx) {
      if (text !== '/metrics') return false;
      const m = deps.metrics.snapshot();
      const pct = (n: number, d: number) =>
        d ? `${((n / d) * 100).toFixed(0)}%` : '—';
      const r = m.recall;
      const sum = (t: Record<string, { attempts: number }>) =>
        Object.values(t).reduce((a, p) => a + p.attempts, 0);
      ctx.note(
        [
          'Memory (this session):',
          `  recall: ${r.attempts} attempts · ${pct(r.hits, r.attempts)} surfaced ≥1 fact · ` +
            `${r.attempts ? (r.factsInjected / r.attempts).toFixed(1) : '0'} facts/pass avg`,
          `  writes: ${m.insertCount} new · ${m.dedupCount} merged · ${m.judgeCallCount} judge calls`,
          `  reconcile passes: ${sum(m.memByPath)} memory · ${sum(m.taskByPath)} task`,
        ].join('\n'),
      );
      return true;
    },
  };

  return [
    exitCommand,
    tasksCommand,
    asCommand,
    debugCommand,
    roomCommand,
    dmCommand,
    roomsCommand,
    metricsCommand,
  ];
}

/** Run the first command that accepts `text`; return `false` if none did (caller falls through to chat). */
export function runCommand(
  commands: Command[],
  text: string,
  ctx: CommandContext,
): boolean {
  for (const cmd of commands) if (cmd.run(text, ctx)) return true;
  return false;
}
