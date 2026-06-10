import { z } from 'zod';
import {
  ChannelRegistryService,
  type ChannelInfo,
} from '../../channel/channel-registry.service';
import { ChannelService } from '../../channel/channel.service';
import { ConductorEventsBus } from '../../conductor/conductor-events.bus';
import { DEFAULT_PROJECT } from '../../domain/identity';
import { EmployeeRegistry } from '../../employees/employee.registry';
import { HarnessTool } from '../harness-tool.decorator';
import type { HarnessToolContext, IHarnessTool } from '../tool.types';

/**
 * Cross-room relay — what lets an employee carry information BETWEEN conversations, like a person
 * walking over to another channel: "when you finish, let Dimitri know" → the bot posts into its DM
 * with Dimitri (or into another room it's a member of). The message lands on that room's shared
 * log, so its members' gates fire normally and the surface renders it there.
 */

/** The short handle a room is addressed by ('#main', '@dimitri') — mirrors the TUI's /rooms. */
const handleOf = (c: ChannelInfo): string =>
  c.kind === 'dm'
    ? `@${c.channelId.replace(/^tui:dm:/, '')}`
    : `#${c.channelId.replace(/^tui:/, '')}`;

const clock = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const listSchema = z.object({});

@HarnessTool()
export class ListRoomsTool implements IHarnessTool<typeof listSchema> {
  readonly name = 'list_rooms';
  readonly description =
    "The rooms you're in — channels and your DMs — with each one's project and members. Use it before send_message to see where a message can go.";
  readonly schema = listSchema;

  constructor(private readonly registry: ChannelRegistryService) {}

  execute(
    _args: z.infer<typeof listSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    const self = ctx.identity.selfAgent;
    const mine = this.registry.list().filter((c) => c.members.includes(self));
    if (mine.length === 0)
      return Promise.resolve("You're not a member of any room.");
    const lines = mine.map(
      (c) =>
        `- ${handleOf(c)}${c.channelId === ctx.identity.surface ? ' (this conversation)' : ''}  ` +
        `(${c.kind === 'dm' ? 'dm' : `channel, project '${c.project}'`}, members: ${c.members.join(', ')})`,
    );
    return Promise.resolve(`Your rooms:\n${lines.join('\n')}`);
  }
}

const sendSchema = z.object({
  to: z
    .string()
    .describe(
      "Where to send it: a room handle from list_rooms ('#project-a'), or '@<person>' for a private 1:1 with a HUMAN (e.g. '@dimitri' — opens the DM if it doesn't exist yet). Teammate bots can't be DM'd — reach them by @mentioning them in a shared room.",
    ),
  message: z
    .string()
    .describe('What to say there, in your own voice — it posts as you.'),
});

@HarnessTool()
export class SendMessageTool implements IHarnessTool<typeof sendSchema> {
  readonly name = 'send_message';
  readonly description =
    'Post a message into ANOTHER room — a different channel you belong to, or a private 1:1 with a human. Use it to relay information across conversations ("let Dimitri know when the deploy lands"). Your reply in THIS conversation still goes out normally; this is only for crossing rooms.';
  readonly schema = sendSchema;

  private mintSeq = 0;
  /** Per-boot tag so minted ids can't collide with a previous run's persisted rows. */
  private readonly mintTag = Date.now().toString(36);

  constructor(
    private readonly registry: ChannelRegistryService,
    private readonly channel: ChannelService,
    private readonly bus: ConductorEventsBus,
    private readonly employees: EmployeeRegistry,
  ) {}

  execute(
    { to, message }: z.infer<typeof sendSchema>,
    ctx: HarnessToolContext,
  ): Promise<string> {
    return Promise.resolve(this.send(to, message, ctx));
  }

  private send(to: string, message: string, ctx: HarnessToolContext): string {
    const self = ctx.identity.selfAgent;
    const bot = this.employees.byId(self);
    if (!bot) return `Unknown sender '${self}'.`;
    const text = message.trim();
    if (!text) return 'Nothing to send — the message was empty.';

    const target = this.resolve(to.trim().toLowerCase(), self);
    if ('error' in target) return target.error;
    const room = target.room;
    if (room.channelId === ctx.identity.surface)
      return "That's THIS conversation — just reply normally instead of send_message.";

    // Post as the bot onto the target room's shared log + the events bus: members' gates fire via
    // the channel subscription, and the surface renders/post()s it from the bus event.
    const id = `${self}:x:${this.mintTag}:${this.mintSeq++}`;
    this.channel.append({
      id,
      channelId: room.channelId,
      author: bot.name,
      authorId: self,
      authorBotId: self,
      text,
    });
    this.bus.emit({
      id,
      kind: 'message',
      channelId: room.channelId,
      authorId: self,
      authorName: bot.name,
      fromHuman: false,
      text,
      ts: clock(),
    });
    return `Sent to ${handleOf(room)}.`;
  }

  /** '#room' / 'room' → an existing room you're in; '@person' → your 1:1 with that human
   * (find-or-create). Bots are NOT DM-able: two always-respond parties would ping-pong forever. */
  private resolve(
    raw: string,
    self: string,
  ): { room: ChannelInfo } | { error: string } {
    const bare = raw.replace(/^[#@]/, '');

    // A known room id/handle first (explicit '#' always means a room).
    const room = this.registry.get(bare) ?? this.registry.get(`tui:${bare}`);
    if (room && (raw.startsWith('#') || !raw.startsWith('@'))) {
      if (!room.members.includes(self))
        return {
          error: `You're not a member of ${handleOf(room)} — ask to be added before posting there.`,
        };
      return { room };
    }

    // A person → your DM with them. Humans only — a bot↔bot DM would hard-respond in a loop.
    if (this.employees.byId(bare))
      return {
        error: `${bare} is a teammate bot — @mention them in a room you share instead of DMing them.`,
      };
    const knownHuman = this.registry
      .list()
      .some((c) => c.members.includes(bare));
    if (!knownHuman)
      return {
        error: `Nobody called '${bare}' here — check list_rooms for who's around.`,
      };
    const dm = this.registry.ensure({
      channelId: `tui:dm:${self}:${bare}`,
      kind: 'dm',
      project: DEFAULT_PROJECT,
      members: [self, bare],
      displayName: `dm:${self}:${bare}`,
    });
    return { room: dm };
  }
}
