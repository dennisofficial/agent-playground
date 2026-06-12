import {
  CHAT_MODEL,
  GATE_MODEL,
  calculateCost,
} from '@harness/llm/usage-format';
import { Subject } from 'rxjs';
import type { ConductorService } from '../conductor/conductor.service';
import { ConductorEventsBus } from '../conductor/conductor-events.bus';
import type { ChatSurface, OutboundChatMessage } from './chat-surface.port';
import { SurfaceBridge } from './surface-bridge.service';

/** Minimal fake surface — records post() calls. */
function makeSurface() {
  const posts: OutboundChatMessage[] = [];
  const surface: ChatSurface = {
    name: 'test',
    inbound$: new Subject<never>().asObservable(),
    post: vi.fn((msg: OutboundChatMessage): Promise<void> => {
      posts.push(msg);
      return Promise.resolve();
    }),
    react: vi.fn((): Promise<void> => Promise.resolve()),
  };
  return { surface, posts };
}

/** Build a SurfaceBridge wired to a real ConductorEventsBus and a fake surface. */
function makeBridge() {
  const bus = new ConductorEventsBus();
  const { surface, posts } = makeSurface();
  const conductor = { submitFrom: vi.fn() } as unknown as ConductorService;
  const bridge = new SurfaceBridge(conductor, bus, surface);
  bridge.onApplicationBootstrap();
  return { bridge, bus, surface, posts };
}

// Shared seq counter — stable across tests in this file
const SEQ = (() => {
  let n = 0;
  return () => `test-${n++}`;
})();

describe('SurfaceBridge usage accumulation', () => {
  it('accumulates gate usage per botId and attaches it to the next post', () => {
    const { bus, posts } = makeBridge();

    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'respond',
      reasoning: 'mine',
      usage: { input: 100, output: 10 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'done!',
      ts: '00:00:01',
    });

    expect(posts).toHaveLength(1);
    const usage = posts[0].usage!;
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(10);
    const expectedCost = calculateCost(GATE_MODEL, { input: 100, output: 10 });
    expect(usage.costUsd).toBeCloseTo(expectedCost, 10);
  });

  it('accumulates chat usage (usage event) per botId', () => {
    const { bus, posts } = makeBridge();

    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 1000, output: 80, cacheRead: 400, cacheWrite: 0 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'here you go',
      ts: '00:00:02',
    });

    expect(posts).toHaveLength(1);
    const usage = posts[0].usage!;
    expect(usage.input).toBe(1000);
    expect(usage.output).toBe(80);
    expect(usage.cacheRead).toBe(400);
    expect(usage.cacheWrite).toBe(0);
    const expectedCost = calculateCost(CHAT_MODEL, {
      input: 1000,
      output: 80,
      cacheRead: 400,
    });
    expect(usage.costUsd).toBeCloseTo(expectedCost, 10);
  });

  it('posting flushes and resets the accumulator (next post starts fresh)', () => {
    const { bus, posts } = makeBridge();

    // First turn: gate + chat usage + message
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'respond',
      reasoning: 'mine',
      usage: { input: 200, output: 20 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 500, output: 60 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'first',
      ts: '00:00:01',
    });

    // Second turn: only chat usage + message (no gate)
    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 300, output: 30 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'second',
      ts: '00:00:02',
    });

    expect(posts).toHaveLength(2);
    // First post: gate (200+20) + chat (500+60)
    expect(posts[0].usage!.input).toBe(700);
    expect(posts[0].usage!.output).toBe(80);
    // Second post: ONLY the second chat call (accumulator was reset after first post)
    expect(posts[1].usage!.input).toBe(300);
    expect(posts[1].usage!.output).toBe(30);
  });

  it('applies gate rates (Haiku) and chat rates (Sonnet) correctly', () => {
    const { bus, posts } = makeBridge();

    // 1M input + 100K output via the gate (Haiku)
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'respond',
      reasoning: 'mine',
      usage: { input: 1_000_000, output: 100_000 },
    });
    // 1M input + 100K output via chat (Sonnet)
    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 1_000_000, output: 100_000 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'cost check',
      ts: '00:00:03',
    });

    expect(posts).toHaveLength(1);
    const usage = posts[0].usage!;
    // Gate: Haiku $1/MTok input, $5/MTok output
    const gateCost = calculateCost(GATE_MODEL, {
      input: 1_000_000,
      output: 100_000,
    });
    expect(gateCost).toBeCloseTo(1.5, 6); // $1.00 input + $0.50 output = $1.50
    // Chat: Sonnet $3/MTok input, $15/MTok output
    const chatCost = calculateCost(CHAT_MODEL, {
      input: 1_000_000,
      output: 100_000,
    });
    expect(chatCost).toBeCloseTo(4.5, 6); // $3.00 input + $1.50 output = $4.50
    expect(usage.costUsd).toBeCloseTo(gateCost + chatCost, 6);
    // Sanity: Sonnet should cost more than Haiku for the same tokens
    expect(chatCost).toBeGreaterThan(gateCost);
  });

  it('rolls gate cost from ignore turns into the next real post', () => {
    const { bus, posts } = makeBridge();

    // Turn 1: gate says ignore — cost accumulates, no message
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'ignore',
      reasoning: 'not mine',
      usage: { input: 150, output: 15 },
    });

    // Turn 2: gate says acknowledge — cost accumulates, no message
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'acknowledge',
      reasoning: 'noted',
      usage: { input: 120, output: 12 },
    });

    // Turn 3: gate says respond, chat runs, bot posts
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'respond',
      reasoning: 'mine now',
      usage: { input: 200, output: 20 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 800, output: 70 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'here you go',
      ts: '00:00:04',
    });

    expect(posts).toHaveLength(1);
    const usage = posts[0].usage!;
    // Input: 150 (ignore gate) + 120 (ack gate) + 200 (respond gate) + 800 (chat) = 1270
    expect(usage.input).toBe(1270);
    // Output: 15 + 12 + 20 + 70 = 117
    expect(usage.output).toBe(117);

    const totalCost =
      calculateCost(GATE_MODEL, { input: 150, output: 15 }) +
      calculateCost(GATE_MODEL, { input: 120, output: 12 }) +
      calculateCost(GATE_MODEL, { input: 200, output: 20 }) +
      calculateCost(CHAT_MODEL, { input: 800, output: 70 });
    expect(usage.costUsd).toBeCloseTo(totalCost, 10);
  });

  it('accumulates independently per botId — one bot does not pollute another', () => {
    const { bus, posts } = makeBridge();

    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'respond',
      reasoning: 'mine',
      usage: { input: 500, output: 50 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'riley',
      botName: 'Riley',
      action: 'respond',
      reasoning: 'mine',
      usage: { input: 300, output: 30 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'alex reply',
      ts: '00:00:01',
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'riley',
      authorName: 'Riley',
      fromHuman: false,
      text: 'riley reply',
      ts: '00:00:02',
    });

    expect(posts).toHaveLength(2);
    const alexUsage = posts.find((p) => p.authorBotId === 'alex')!.usage!;
    const rileyUsage = posts.find((p) => p.authorBotId === 'riley')!.usage!;
    expect(alexUsage.input).toBe(500);
    expect(rileyUsage.input).toBe(300);
  });

  it('attaches undefined usage when no events were accumulated (no footer for zero-cost messages)', () => {
    const { bus, posts } = makeBridge();

    // Message with no preceding gate or usage events
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'step-cap message (no usage)',
      ts: '00:00:05',
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].usage).toBeUndefined();
  });

  it('does NOT accumulate when gate event has no usage field (hard-rule decisions)', () => {
    const { bus, posts } = makeBridge();

    // Hard-rule gate event: no usage (DM always-respond, own-message ignore, etc.)
    bus.emit({
      id: SEQ(),
      kind: 'gate',
      botId: 'alex',
      botName: 'Alex',
      action: 'respond',
      reasoning: 'direct message',
      // usage deliberately absent
    });
    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 400, output: 40 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'reply',
      ts: '00:00:06',
    });

    expect(posts).toHaveLength(1);
    const usage = posts[0].usage!;
    // Only the chat usage should be present (gate had no usage to accumulate)
    expect(usage.input).toBe(400);
    expect(usage.output).toBe(40);
    expect(usage.costUsd).toBeCloseTo(
      calculateCost(CHAT_MODEL, { input: 400, output: 40 }),
      10,
    );
  });

  it('prices Sonnet cacheWrite at $6.00/MTok (1-hour TTL rate, not 5-min $3.75)', () => {
    // This test asserts LITERAL dollar amounts so a wrong rate in PRICING won't hide behind a
    // tautological calculateCost() call. The chat path uses ttl:'1h' (extended-cache-ttl beta),
    // billed by Anthropic at 2× base ($3.00 × 2 = $6.00/MTok). The 5-min rate is $3.75 — wrong.
    const { bus, posts } = makeBridge();

    // 1M cacheWrite tokens via chat (Sonnet) — no fresh input, no output.
    // cacheWrite is included in `input` (langchain folds it in), so set input = cacheWrite.
    bus.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 1_000_000, output: 0, cacheWrite: 1_000_000 },
    });
    bus.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'cache-write cost check',
      ts: '00:00:07',
    });

    expect(posts).toHaveLength(1);
    // 1M cacheWrite tokens @ $6.00/MTok = $6.00 exactly
    expect(posts[0].usage!.costUsd).toBeCloseTo(6.0, 6);

    // Also assert cacheRead rate: 1M cacheRead tokens @ $0.30/MTok = $0.30.
    const { bus: bus2, posts: posts2 } = makeBridge();
    bus2.emit({
      id: SEQ(),
      kind: 'usage',
      botId: 'alex',
      role: 'chat',
      usage: { input: 1_000_000, output: 0, cacheRead: 1_000_000 },
    });
    bus2.emit({
      id: SEQ(),
      kind: 'message',
      channelId: 'slack:T1:C1',
      authorId: 'alex',
      authorName: 'Alex',
      fromHuman: false,
      text: 'cache-read cost check',
      ts: '00:00:08',
    });
    // 1M cacheRead tokens @ $0.30/MTok = $0.30 exactly
    expect(posts2[0].usage!.costUsd).toBeCloseTo(0.3, 6);
  });
});
