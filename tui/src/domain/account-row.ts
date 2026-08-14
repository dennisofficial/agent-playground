import { EAccountStatus } from '../generated/prisma/enums.js';

export type AccountRowLayout = {
  lines: 1 | 2;
  label: number;
  plan: number;
  showBar: boolean;
  badge: BadgeForm;
  /**
   * Room for the policy flags (`xu 24%  fast`) — 0 when the row is too narrow to afford them. They
   * are the first thing dropped at every shape, because unlike a meter they are a setting rather
   * than a measurement, and the footer names the highlighted account's settings regardless.
   */
  flags: number;
};

export type BadgeForm = "text" | "glyph" | "none";

export type MeterWidths = { withGauge: number; withoutGauge: number };

export const GUTTER = 6;
const MARGIN = 2;
const PLAN = 10;
const LABEL_MIN = 12;
const LABEL_MAX = 40;

const BADGE: Record<BadgeForm, number> = { text: 12, glyph: 4, none: 0 };

/** `xu 24%` + a gap + `fast` — the widest the flag column ever draws. */
export const FLAGS = 12;

type Form = Omit<AccountRowLayout, "label">;

/**
 * Longest-first, and the flag column is paired with each shape rather than appended to the ladder:
 * at every width the concession made first is the settings, not the numbers.
 */
const FORMS: Form[] = [
  { lines: 1, plan: PLAN, showBar: true, badge: "text", flags: FLAGS },
  { lines: 1, plan: PLAN, showBar: true, badge: "text", flags: 0 },
  { lines: 1, plan: PLAN, showBar: true, badge: "glyph", flags: 0 },
  { lines: 2, plan: PLAN, showBar: true, badge: "text", flags: FLAGS },
  { lines: 2, plan: PLAN, showBar: true, badge: "text", flags: 0 },
  { lines: 2, plan: PLAN, showBar: true, badge: "glyph", flags: 0 },
  { lines: 2, plan: PLAN, showBar: false, badge: "glyph", flags: 0 },
  { lines: 2, plan: 0, showBar: false, badge: "glyph", flags: 0 },
  { lines: 2, plan: 0, showBar: false, badge: "none", flags: 0 },
];

/** `5h ` before the gauge, ` 34%` after it — the fixed cells every meter spends. */
const METER_LABEL = 3;
const METER_PERCENT = 4;

/**
 * The widest ONE meter gets. `gaugeCells: 0` is the gauge-less form, which is narrower by the bar
 * plus the space in front of it.
 */
export function meterColumnWidth(args: { gaugeCells: number }): number {
  return METER_LABEL + METER_PERCENT + (args.gaugeCells > 0 ? args.gaugeCells + 1 : 0);
}

/**
 * What the layout budgets for the 5h/wk pair, so the two forms agree by construction. Taking the
 * gauge width and the gap as arguments keeps the style tokens in `ui/` — this file must not know
 * what a meter looks like, only how many cells it costs.
 */
export function accountMeterWidths(args: { gaugeCells: number; gap: number }): MeterWidths {
  return {
    withGauge: meterColumnWidth({ gaugeCells: args.gaugeCells }) * 2 + args.gap,
    withoutGauge: meterColumnWidth({ gaugeCells: 0 }) * 2 + args.gap,
  };
}

/**
 * The word a status badge carries, or `null` for the statuses that need no announcement.
 *
 * `limited` still says `limited` on an account permitted to spend credits, and deliberately: the
 * SUBSCRIPTION really has walled, which is the fact the badge is about. That the account can keep
 * working anyway is what the `xu` flag beside it says.
 */
export function badgeText(account: { status: EAccountStatus }): string | null {
  if (account.status === EAccountStatus.expired) return 'expired';
  if (account.status === EAccountStatus.limited) return 'limited';
  return null;
}

/** What the extra-usage flag reads, and why — the colour is `ui`'s to pick from the state. */
export type ExtraUsageFlag =
  /** Atlas may spend here. `percent` is what the wallet has already cost. */
  | { state: 'on'; percent: number | null }
  /** Permitted, but the subscription has no credits provisioned — a setting away from working. */
  | { state: 'unavailable' }
  /** Permitted, and the wallet is empty. This account is genuinely out of everything. */
  | { state: 'spent' }
  | { state: 'off' };

export function extraUsageFlag(account: {
  extraUsageAllowed: boolean;
  extraUsageEnabled: boolean | null;
  extraUsageUtil: number | null;
}): ExtraUsageFlag {
  if (!account.extraUsageAllowed) return { state: 'off' };
  if (account.extraUsageEnabled === false) return { state: 'unavailable' };
  if ((account.extraUsageUtil ?? 0) >= 100) return { state: 'spent' };
  return { state: 'on', percent: account.extraUsageUtil };
}

/**
 * The highlighted account's two settings, spelled out — longest-first for `fitHints`.
 *
 * This is what makes the feature discoverable and what makes it legible at any width: the `flags`
 * column is dropped on a narrow terminal, and the toggles are two unlabelled letters until something
 * says what they currently are. The `n/a` case earns its own sentence because it is the one the
 * human cannot fix from this page — no local toggle provisions credits on a subscription.
 */
export function policyForms(account: {
  extraUsageAllowed: boolean;
  extraUsageEnabled: boolean | null;
  extraUsageUtil: number | null;
  fastMode: boolean;
}): string[] {
  const flag = extraUsageFlag(account);
  const extra =
    flag.state === 'off'
      ? 'extra usage off'
      : flag.state === 'unavailable'
        ? 'extra usage on · none on this plan'
        : flag.state === 'spent'
          ? 'extra usage on · credits spent'
          : flag.percent === null
            ? 'extra usage on'
            : `extra usage on · ${flag.percent}% of credits`;
  const fast = `fast mode ${account.fastMode ? 'on' : 'off'}`;
  return [
    `${extra} · ${fast}`,
    `${flag.state === 'off' ? 'xu off' : 'xu on'} · ${fast}`,
    `xu ${flag.state === 'off' ? 'off' : 'on'} · fast ${account.fastMode ? 'on' : 'off'}`,
  ];
}

function usageWidth(form: Form, meters: MeterWidths): number {
  return (
    form.plan +
    (form.showBar ? meters.withGauge : meters.withoutGauge) +
    form.flags
  );
}

function labelRoom(
  form: Form,
  width: number,
  meters: MeterWidths,
  badged: boolean,
): number | null {
  const badge = badged ? BADGE[form.badge] : 0;
  if (form.lines === 1)
    return width - GUTTER - usageWidth(form, meters) - badge - MARGIN;

  const usageFitsOnItsOwnLine =
    GUTTER + usageWidth(form, meters) + MARGIN <= width;
  if (!usageFitsOnItsOwnLine) return null;
  return width - GUTTER - badge - MARGIN;
}

export function accountRowLayout(
  width: number,
  meters: MeterWidths,
  anyAccountBadged: boolean,
): AccountRowLayout {
  for (const form of FORMS) {
    const room = labelRoom(form, width, meters, anyAccountBadged);
    // The flag column is affordable only once the label has everything it can use — the same rule
    // the badge already follows. Held to `LABEL_MIN` instead it won every width above ~90 and paid
    // for itself out of the label, which is the one column that is actually identifying the row.
    const floor = form.flags > 0 ? LABEL_MAX : LABEL_MIN;
    if (room !== null && room >= floor)
      return { ...form, label: Math.min(LABEL_MAX, room) };
  }

  const poorestForm = FORMS[FORMS.length - 1] as Form;
  return { ...poorestForm, label: Math.max(3, width - GUTTER - MARGIN) };
}
