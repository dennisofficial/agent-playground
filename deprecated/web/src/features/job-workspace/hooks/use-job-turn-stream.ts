'use client';

import { applyStreamFrame, endLiveTurn, MAIN_LANE } from '@/lib/api/job-stream';
import { refreshSession } from '@/lib/api/refresh';
import { env } from '@/lib/env';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { LiveTurnFrame } from '@workspace/shared';
import { useEffect } from 'react';

export function useJobTurnStream(jobId: string | undefined): void {
  useEffect(() => {
    if (!jobId) return;
    const ctrl = new AbortController();
    const url = new URL(`/jobs/${jobId}/turn/stream`, env.NEXT_PUBLIC_BACKEND_URL).toString();
    const norm = new TurnNormalizer(jobId);

    void fetchEventSource(url, {
      signal: ctrl.signal,
      openWhenHidden: true,
      credentials: 'include',
      async onopen(res) {
        if (res.ok) return;
        if (res.status === 401) {
          // Re-auth once, then let onerror's retry reconnect with the fresh cookie.
          await refreshSession();
          throw new Error('reauth');
        }
        // 4xx (not 429) is fatal; anything else is retriable.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          ctrl.abort();
        }
        throw new Error(`turn stream ${res.status}`);
      },
      onmessage(ev) {
        if (!ev.data) return;
        try {
          norm.handle(JSON.parse(ev.data) as LiveTurnFrame);
        } catch {
          // A malformed frame must never sink the stream.
        }
      },
      onerror(err) {
        // Returning a number = reconnect after that delay; throwing = stop. Reconnect with backoff on any
        // transient failure so a backend restart heals; a fatal abort above stops us here.
        if (ctrl.signal.aborted) throw err;
        return 2_000;
      },
    }).catch(() => {
      // Aborted / fatal — the store keeps whatever it last had; a fresh mount reopens.
    });

    return () => {
      ctrl.abort();
      norm.dispose();
    };
  }, [jobId]);
}

/** Loose views of the raw SDK frames we translate — only the fields we read. */
interface RawStreamEvent {
  type: 'stream_event';
  parent_tool_use_id?: string | null;
  event?: {
    type?: string;
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  };
}
interface RawUserMessage {
  type: 'user';
  parent_tool_use_id?: string | null;
  message?: {
    content?: Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>;
  };
}

class TurnNormalizer {
  private seq = 0;
  private emittedAt: number | undefined;
  private readonly tools = new Map<
    number,
    { id: string; name: string; json: string; pid?: string }
  >();
  private readonly prose = new Map<number, 'text' | 'thinking'>();

  constructor(private readonly jobId: string) {}

  handle(frame: LiveTurnFrame): void {
    switch (frame.kind) {
      case 'turn_start':
        this.tools.clear();
        this.prose.clear();
        this.apply({ kind: 'turn_start', startedAt: frame.startedAt });
        return;
      case 'turn_end':
        this.tools.clear();
        this.prose.clear();
        endLiveTurn(this.jobId, MAIN_LANE);
        return;
      case 'event':
        this.emittedAt = frame.emittedAt;
        try {
          this.event(frame.event);
        } finally {
          this.emittedAt = undefined;
        }
        return;
    }
  }

  dispose(): void {
    this.tools.clear();
    this.prose.clear();
  }

  private event(raw: unknown): void {
    const type = (raw as { type?: string })?.type;
    if (type === 'stream_event') return this.streamEvent(raw as RawStreamEvent);
    if (type === 'user') return this.toolResults(raw as RawUserMessage);
  }

  private streamEvent(m: RawStreamEvent): void {
    const ev = m.event;
    if (!ev?.type) return;
    const pid = m.parent_tool_use_id ?? undefined;

    if (ev.type === 'content_block_start') {
      const cb = ev.content_block;
      if (typeof ev.index === 'number') {
        if (cb?.type === 'tool_use') {
          this.tools.set(ev.index, { id: cb.id ?? '', name: cb.name ?? 'tool', json: '', pid });
        } else if (cb?.type === 'text' || cb?.type === 'thinking') {
          this.prose.set(ev.index, cb.type);
        }
      }
      return;
    }

    if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (d?.type === 'text_delta' && d.text)
        this.apply({ kind: 'text_delta', text: d.text, parentToolUseId: pid });
      else if (d?.type === 'thinking_delta' && d.thinking)
        this.apply({ kind: 'thinking_delta', text: d.thinking, parentToolUseId: pid });
      else if (d?.type === 'input_json_delta' && typeof ev.index === 'number') {
        const t = this.tools.get(ev.index);
        if (t) t.json += d.partial_json ?? '';
      }
      return;
    }

    if (ev.type === 'content_block_stop' && typeof ev.index === 'number') {
      const proseKind = this.prose.get(ev.index);
      if (proseKind) {
        this.prose.delete(ev.index);
        this.apply({ kind: 'block_done', blockKind: proseKind, parentToolUseId: pid });
        return;
      }
      const t = this.tools.get(ev.index);
      if (t) {
        this.tools.delete(ev.index);
        let input: unknown = undefined;
        try {
          input = t.json ? JSON.parse(t.json) : {};
        } catch {
          input = {};
        }
        this.apply({ kind: 'tool_use', id: t.id, name: t.name, input, parentToolUseId: t.pid });
      }
      return;
    }
  }

  private toolResults(m: RawUserMessage): void {
    const pid = m.parent_tool_use_id ?? undefined;
    for (const c of m.message?.content ?? []) {
      if (c?.type !== 'tool_result') continue;
      this.apply({
        kind: 'tool_result',
        id: c.tool_use_id,
        result: c.content,
        isError: Boolean(c.is_error),
        parentToolUseId: pid,
      });
    }
  }

  private apply(payload: Record<string, unknown>): void {
    applyStreamFrame(this.jobId, MAIN_LANE, this.seq++, {
      ...(this.emittedAt != null ? { emittedAt: this.emittedAt } : {}),
      ...payload,
    });
  }
}
