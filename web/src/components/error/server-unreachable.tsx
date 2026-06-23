'use client';

import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { auth } from '@/lib/auth';
import { env } from '@/lib/env';

/**
 * Full-screen backend-outage state (design: `Atlas Server Unreachable.dc.html`). Rendered by the
 * auth guards / root redirect hub when `AuthState.backendUnreachable` is set. Auto-retries on a
 * countdown and re-probes the backend via `auth.recheck()`; on success the auth state flips and the
 * parent guard unmounts this screen. Token-driven, so it tracks the daylight/terminal/warm themes.
 */
export function ServerUnreachable() {
  const [retrying, setRetrying] = useState(false);
  const [secs, setSecs] = useState(AUTO_RETRY_SECS);
  const retryingRef = useRef(false);

  const runRetry = useCallback(async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await auth.recheck();
    } catch {
      // Still unreachable — the countdown resumes below.
    } finally {
      retryingRef.current = false;
      setRetrying(false);
      setSecs(AUTO_RETRY_SECS);
    }
  }, []);

  // Tick the countdown once a second (paused while a probe is in flight).
  useEffect(() => {
    const id = setInterval(() => {
      if (!retryingRef.current) setSecs((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Fire the auto-retry when the countdown runs out.
  useEffect(() => {
    if (secs <= 1 && !retryingRef.current) void runRetry();
  }, [secs, runRetry]);

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6">
      {/* grid + warm vignette + top accent line — matches the workspace canvas */}
      <div aria-hidden style={GRID} />
      <div aria-hidden style={VIGNETTE} />
      <div aria-hidden style={TOP_LINE} />

      <div className="relative flex max-w-[560px] flex-col items-center px-6 text-center">
        {/* ===== ILLUSTRATION ===== */}
        <div className="anim-fadeUp" style={ILLUSTRATION}>
          {/* local node */}
          <div className="flex flex-col items-center gap-2.5">
            <div style={NODE_CARD}>
              <span style={{ ...BAR, background: 'var(--border-2)' }} />
              <span style={{ ...BAR, background: 'var(--border-2)' }} />
              <span style={{ ...BAR, background: 'var(--accent)', opacity: 0.85 }} />
            </div>
            <span style={NODE_LABEL}>atlas</span>
          </div>

          {/* broken link */}
          <div style={CABLE_WRAP}>
            <div style={CABLE_LEFT} />
            <div style={CABLE_RIGHT} />
            <div style={BREAK_MARKER}>
              <span style={{ ...BREAK_BAR, transform: 'rotate(45deg)' }} />
              <span style={{ ...BREAK_BAR, transform: 'rotate(-45deg)' }} />
            </div>
          </div>

          {/* server node (offline) */}
          <div style={SERVER_NODE}>
            <div style={{ position: 'relative', width: 60, height: 60 }}>
              <div style={{ ...PING_RING }} />
              <div style={{ ...PING_RING, animationDelay: '1.2s' }} />
              <div style={SERVER_CARD}>
                <div style={OFFLINE_GLYPH} />
                <div style={OFFLINE_DOT} />
              </div>
            </div>
            <span style={NODE_LABEL}>server</span>
          </div>
        </div>

        {/* ===== TEXT ===== */}
        <div className="anim-fadeUp" style={{ ...BADGE, animationDelay: '0.06s' }}>
          <span style={BADGE_DOT} />
          connection lost
        </div>

        <h1 className="anim-fadeUp font-disp" style={{ ...HEADLINE, animationDelay: '0.1s' }}>
          Can’t reach the server
        </h1>

        <p className="anim-fadeUp text-dim" style={{ ...BODY, animationDelay: '0.14s' }}>
          Atlas lost its connection to the workspace backend. Your work is safe — running threads keep
          going and the board will resync the moment we’re back.
        </p>

        {/* error detail */}
        <div className="anim-fadeUp font-mono" style={{ ...DETAIL, animationDelay: '0.18s' }}>
          <span style={{ color: 'var(--red)', fontWeight: 600 }}>UNREACHABLE</span>
          <span style={DETAIL_DIV} />
          <span>{backendHost()}</span>
        </div>

        {/* action */}
        <div className="anim-fadeUp" style={{ marginTop: 26, animationDelay: '0.22s' }}>
          <Button
            variant="primary"
            loading={retrying}
            loadingText="Reconnecting…"
            icon={<RotateCw size={14} />}
            onClick={() => void runRetry()}
          >
            Retry now
          </Button>
        </div>

        {/* auto-retry line */}
        <div className="anim-fadeUp font-mono" style={{ ...AUTO_LINE, animationDelay: '0.26s' }}>
          {retrying ? 'attempting to reconnect…' : `auto-retry in 0:0${Math.max(secs, 1)}`}
        </div>
      </div>
    </main>
  );
}

const AUTO_RETRY_SECS = 8;

/** Real backend host for the detail chip (browsers never surface the design's mock `ECONNREFUSED`). */
function backendHost(): string {
  try {
    return new URL(env.NEXT_PUBLIC_ATLAS_HTTP_URL).host;
  } catch {
    return env.NEXT_PUBLIC_ATLAS_HTTP_URL;
  }
}

// ── decorative overlays ──────────────────────────────────────────────────────────────────────
const GRID: CSSProperties = {
  position: 'absolute',
  inset: 0,
  backgroundImage:
    'linear-gradient(var(--bg-grid) 1px, transparent 1px), linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px)',
  backgroundSize: '34px 34px',
  pointerEvents: 'none',
};
const VIGNETTE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'radial-gradient(120% 80% at 50% -10%, var(--glow), transparent 55%)',
  pointerEvents: 'none',
};
const TOP_LINE: CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  height: 1,
  background: 'linear-gradient(90deg, transparent, var(--accent-line), transparent)',
  opacity: 0.6,
  pointerEvents: 'none',
};

// ── illustration ─────────────────────────────────────────────────────────────────────────────
const ILLUSTRATION: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 148,
  marginBottom: 34,
};
const NODE_CARD: CSSProperties = {
  width: 60,
  height: 60,
  borderRadius: 14,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow-card)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5,
};
const BAR: CSSProperties = { width: 24, height: 3, borderRadius: 2 };
const NODE_LABEL: CSSProperties = {
  fontFamily: 'var(--f-mono)',
  fontSize: 9.5,
  letterSpacing: '0.14em',
  color: 'var(--faint)',
  textTransform: 'uppercase',
};
const CABLE_WRAP: CSSProperties = {
  position: 'relative',
  width: 150,
  height: 60,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: '0 6px',
};
const CABLE_LEFT: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: '50%',
  width: 54,
  height: 2,
  transform: 'translateY(-50%)',
  backgroundImage: 'linear-gradient(90deg, var(--border-2) 60%, transparent 0)',
  backgroundSize: '9px 2px',
  backgroundRepeat: 'repeat-x',
  animation: 'atlas-cable-dash 1.1s linear infinite',
};
const CABLE_RIGHT: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: '50%',
  width: 54,
  height: 2,
  transform: 'translateY(-50%)',
  backgroundImage: 'linear-gradient(90deg, var(--border-2) 60%, transparent 0)',
  backgroundSize: '9px 2px',
  backgroundRepeat: 'repeat-x',
  opacity: 0.5,
};
const BREAK_MARKER: CSSProperties = {
  position: 'relative',
  width: 30,
  height: 30,
  borderRadius: '50%',
  background: 'var(--bg)',
  border: '1.5px solid color-mix(in srgb, var(--red) 50%, transparent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 0 0 5px var(--bg), 0 2px 10px color-mix(in srgb, var(--red) 22%, transparent)',
  animation: 'atlas-ping-blink 2.4s ease-in-out infinite',
};
const BREAK_BAR: CSSProperties = {
  position: 'absolute',
  width: 14,
  height: 2,
  borderRadius: 2,
  background: 'var(--red)',
};
const SERVER_NODE: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  animation: 'atlas-node-float 5s ease-in-out infinite',
};
const PING_RING: CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: 16,
  border: '1.5px solid var(--red)',
  animation: 'atlas-ping 2.4s ease-out infinite',
};
const SERVER_CARD: CSSProperties = {
  position: 'relative',
  width: 60,
  height: 60,
  borderRadius: 14,
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const OFFLINE_GLYPH: CSSProperties = {
  width: 26,
  height: 18,
  borderRadius: 11,
  background: 'var(--surface-3)',
  border: '1px solid var(--border-2)',
};
const OFFLINE_DOT: CSSProperties = {
  position: 'absolute',
  bottom: 9,
  right: 11,
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: 'var(--red)',
  border: '2px solid var(--surface-2)',
  boxShadow: '0 0 7px color-mix(in srgb, var(--red) 50%, transparent)',
};

// ── text + chips ─────────────────────────────────────────────────────────────────────────────
const BADGE: CSSProperties = {
  fontFamily: 'var(--f-mono)',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--red)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '4px 11px',
  border: '1px solid color-mix(in srgb, var(--red) 32%, transparent)',
  background: 'color-mix(in srgb, var(--red) 7%, transparent)',
  borderRadius: 100,
  marginBottom: 18,
};
const BADGE_DOT: CSSProperties = { width: 5, height: 5, borderRadius: '50%', background: 'var(--red)' };
const HEADLINE: CSSProperties = {
  fontWeight: 600,
  fontSize: 27,
  letterSpacing: '-0.015em',
  lineHeight: 1.1,
  margin: 0,
};
const BODY: CSSProperties = { fontSize: 14, lineHeight: 1.6, marginTop: 11, maxWidth: 430 };
const DETAIL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 9,
  fontSize: 11.5,
  color: 'var(--faint)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  padding: '7px 12px',
  marginTop: 20,
};
const DETAIL_DIV: CSSProperties = { width: 1, height: 11, background: 'var(--border-2)' };
const AUTO_LINE: CSSProperties = {
  fontSize: 11,
  color: 'var(--faint)',
  marginTop: 16,
  letterSpacing: '0.02em',
};
