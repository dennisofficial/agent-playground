'use client';
import type { SaveCredentialsBody } from '@/redux/query/api/credentials.api';
import type { SaveCredentialsResult } from '@workspace/shared';
import { type ReactNode, useState } from 'react';
import { EditPill } from './EditPill';
import { StatusChip } from './StatusChip';
export interface Mode {
  id: string;
  toggleLabel?: string;
  fieldLabel: string;
  placeholder: string;
  maskedPrefix: string;
  tag: string;
  serverValidated?: boolean;
  /** Optional "how to get this token" guidance, shown inside the edit form. */
  help?: ReactNode;
  validate: (v: string) => { ok: boolean; reason: string };
  buildBody: (v: string) => SaveCredentialsBody;
}

export type Tone = 'green' | 'dim' | 'faint';
export type Status = 'idle' | 'testing' | 'valid' | 'invalid';

export function CredentialCard({
  icon,
  iconAccent = false,
  title,
  sub,
  present,
  pill,
  modes,
  onSave,
}: {
  icon: ReactNode;
  iconAccent?: boolean;
  title: string;
  sub: string;
  present: boolean;
  pill: { label: string; tone: Tone };
  modes: Mode[];
  onSave: (body: SaveCredentialsBody) => Promise<SaveCredentialsResult>;
}) {
  const [editing, setEditing] = useState(false);
  const [modeIdx, setModeIdx] = useState(0);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [reason, setReason] = useState('');
  const mode = modes[modeIdx];

  function reset() {
    setValue('');
    setStatus('idle');
    setReason('');
  }
  function startEdit() {
    reset();
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    reset();
  }

  function switchMode(i: number) {
    setModeIdx(i);
    reset();
  }
  function test() {
    const r = mode.validate(value.trim());
    setStatus(r.ok ? 'valid' : 'invalid');
    setReason(r.reason);
  }
  async function submit() {
    const v = value.trim();
    if (!v) {
      setStatus('invalid');
      setReason('Enter a value.');
      return;
    }
    const r = mode.validate(v);
    if (!r.ok) {
      setStatus('invalid');
      setReason(r.reason);
      return;
    }
    setStatus('testing');
    setReason('');
    try {
      // The vault stores the secret but does not probe it (LLM-key validation is the future engine
      // module's job) — a successful save is success. Client-side format checks ran above.
      await onSave(mode.buildBody(v));
      setEditing(false);
      reset();
    } catch (e) {
      setStatus('invalid');
      setReason((e as Error)?.message || 'Could not save.');
    }
  }

  return (
    <div className="mb-3.5 rounded-lg border border-border bg-surface p-4.5">
      <div className="flex items-center gap-3">
        <span
          className="flex h-7.5 w-7.5 shrink-0 items-center justify-center rounded-lg border"
          style={
            iconAccent
              ? {
                  background: 'var(--accent-soft)',
                  borderColor: 'var(--accent-line)',
                  color: 'var(--accent)',
                }
              : {
                  background: 'var(--surface-3)',
                  borderColor: 'var(--border-2)',
                  color: 'var(--dim)',
                }
          }
        >
          {icon}
        </span>
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold text-text">{title}</div>
          <div className="mt-0.5 text-[11px] text-faint">{sub}</div>
        </div>
        <StatusChip label={pill.label} tone={pill.tone} />
      </div>

      {!editing ? (
        <>
          <div className="mt-3.5 flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3.5 py-2.5">
            {present ? (
              <>
                <span className="flex-1 font-mono text-[12.5px] text-dim">
                  {mode.maskedPrefix}
                  {'•'.repeat(14)}
                </span>
                <span className="rounded-[3px] bg-surface-3 px-1.5 py-0.5 font-mono text-[9px] text-dim">
                  {mode.tag}
                </span>
              </>
            ) : (
              <span className="flex-1 font-mono text-[12px] text-faint">No key set.</span>
            )}
            <button
              type="button"
              onClick={startEdit}
              className="rounded-sm border border-accent-line px-3 py-1.5 text-[11.5px] font-semibold text-accent transition hover:bg-accent-soft"
            >
              {present ? 'Rotate' : 'Add key'}
            </button>
          </div>
          {/* When no key is set yet, surface the "how to get this" guidance up front — that's when it's needed. */}
          {!present && mode.help ? <div className="mt-3">{mode.help}</div> : null}
        </>
      ) : (
        <div className="mt-3.5">
          {modes.length > 1 ? (
            <div className="mb-3 flex gap-1 rounded-md border border-border-2 bg-surface-2 p-1">
              {modes.map((m, i) => {
                const on = i === modeIdx;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => switchMode(i)}
                    className="flex-1 rounded-sm py-1.5 text-[12px] font-semibold transition"
                    style={{
                      background: on ? 'var(--surface)' : 'transparent',
                      color: on ? 'var(--accent)' : 'var(--dim)',
                    }}
                  >
                    {m.toggleLabel}
                  </button>
                );
              })}
            </div>
          ) : null}

          {mode.help ? <div className="mb-3">{mode.help}</div> : null}

          <div className="mb-2 flex items-center gap-2">
            <label className="flex-1 text-[12px] font-medium text-dim">{mode.fieldLabel}</label>
            <EditPill status={status} />
          </div>
          <div
            className="flex items-center rounded-md border bg-surface-2 pl-3 pr-1.5"
            style={{ borderColor: borderForStatus(status) }}
          >
            <input
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setStatus('idle');
                setReason('');
              }}
              onBlur={() => {
                if (value.trim() && status === 'idle') test();
              }}
              type="password"
              placeholder={mode.placeholder}
              className="flex-1 bg-transparent py-2.5 font-mono text-[12.5px] text-text outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={test}
              className="rounded-sm border border-border-2 px-2.5 py-1.5 text-[11px] font-semibold text-dim transition hover:bg-surface-3"
            >
              Test
            </button>
          </div>
          {reason ? (
            <p
              className="mt-2 text-[11.5px]"
              style={{
                color: status === 'valid' ? 'var(--green)' : 'var(--red)',
              }}
            >
              {reason}
            </p>
          ) : null}
          <div className="mt-3.5 flex gap-2.5">
            <button
              type="button"
              onClick={submit}
              disabled={status === 'testing'}
              className="rounded-md px-4 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:opacity-60"
              style={{ background: 'var(--accent)' }}
            >
              {status === 'testing' ? 'Saving…' : 'Save new key'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-border-2 px-3.5 py-2 text-[12px] font-medium text-dim transition hover:bg-surface-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function borderForStatus(status: Status): string {
  if (status === 'valid') return 'color-mix(in srgb, var(--green) 50%, transparent)';
  if (status === 'invalid') return 'color-mix(in srgb, var(--red) 55%, transparent)';
  return 'var(--border-2)';
}
