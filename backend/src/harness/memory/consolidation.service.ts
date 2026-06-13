import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createMutex } from '../domain/async';
import { Identity } from '../domain/identity';
import type { EmployeeDefinition } from '../employees/employee.types';
import { ReconcileService } from './reconcile.service';

const DEFAULT_DEBOUNCE_MS = 60_000;

interface Pending {
  bot: EmployeeDefinition;
  id: Identity;
  transcript: string;
}

/**
 * The async, off-the-hot-path driver for durable-fact CONSOLIDATION. It exists because the inline
 * post-turn fact pass was disabled (2026-06-12) for being too credulous — reacting to one turn's
 * fragment, it stored anticipatory chatter as fact. This instead DEBOUNCES per room: each turn the
 * conductor calls `schedule(...)` with the latest windowed transcript; bursts coalesce, and only once
 * a room goes quiet for the debounce interval does a single consolidation pass run — over the whole
 * recent window, with full context, via `ReconcileService.consolidateMemory` (the hardened prompt).
 *
 * Single-process by design: timers + a per-room mutex live in memory. Gated behind
 * MEMORY_CONSOLIDATION_ENABLED (default OFF) so it ships dark until the eval clears it. `schedule` never
 * blocks a turn — it only (re)arms a timer; the pass runs detached. NOT tenant-locked across processes
 * (the underlying write mutex is process-local too — the documented multi-process gap).
 */
@Injectable()
export class ConsolidationService implements OnModuleDestroy {
  private readonly logger = new Logger(ConsolidationService.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, Pending>();
  /** One mutex per room key, so two fires for the same room never overlap. */
  private readonly locks = new Map<string, ReturnType<typeof createMutex>>();

  constructor(
    private readonly reconcile: ReconcileService,
    private readonly env: EnvService,
  ) {}

  private enabled(): boolean {
    return this.env.get('MEMORY_CONSOLIDATION_ENABLED') === true;
  }

  private debounceMs(): number {
    return (
      this.env.get('MEMORY_CONSOLIDATION_DEBOUNCE_MS') ?? DEFAULT_DEBOUNCE_MS
    );
  }

  /** Per (bot, room) key — a room is identified by its surface id. */
  private keyOf(bot: EmployeeDefinition, id: Identity): string {
    return `${bot.id}:${id.surface}`;
  }

  private lockFor(key: string): ReturnType<typeof createMutex> {
    let l = this.locks.get(key);
    if (!l) {
      l = createMutex();
      this.locks.set(key, l);
    }
    return l;
  }

  /**
   * Note this room's latest transcript window and (re)arm its debounce timer. No-op when disabled or
   * the transcript is empty. Cheap and non-blocking — safe to call at the end of every turn.
   */
  schedule(bot: EmployeeDefinition, id: Identity, transcript: string): void {
    if (!this.enabled() || !transcript.trim()) return;
    const key = this.keyOf(bot, id);
    this.pending.set(key, { bot, id, transcript });
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      void this.fire(key);
    }, this.debounceMs());
    // Don't let a pending consolidation keep the process alive (TUI/CLI shutdown).
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /** Run the consolidation for one room (serialized per key). Errors are swallowed downstream. */
  private async fire(key: string): Promise<void> {
    this.timers.delete(key);
    const payload = this.pending.get(key);
    if (!payload) return;
    this.pending.delete(key);
    await this.lockFor(key)(async () => {
      this.logger.debug(`consolidating memory for ${key}`);
      await this.reconcile.consolidateMemory(
        payload.bot,
        payload.transcript,
        payload.id,
      );
    });
  }

  /** Run all armed consolidations immediately (tests / graceful shutdown). */
  async flushAll(): Promise<void> {
    const keys = [...this.timers.keys()];
    for (const key of keys) {
      const t = this.timers.get(key);
      if (t) clearTimeout(t);
      await this.fire(key);
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.pending.clear();
  }
}
