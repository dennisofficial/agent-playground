import { EAccountStatus } from '../generated/prisma/enums.js';

export type AccountRowLayout = {
  lines: 1 | 2;
  label: number;
  plan: number;
  showBar: boolean;
  badge: BadgeForm;
};

export type BadgeForm = "text" | "glyph" | "none";

export type MeterWidths = { withGauge: number; withoutGauge: number };

export const GUTTER = 6;
const MARGIN = 2;
const PLAN = 10;
const LABEL_MIN = 12;
const LABEL_MAX = 40;

const BADGE: Record<BadgeForm, number> = { text: 12, glyph: 4, none: 0 };

type Form = Omit<AccountRowLayout, "label">;

const FORMS: Form[] = [
  { lines: 1, plan: PLAN, showBar: true, badge: "text" },
  { lines: 1, plan: PLAN, showBar: true, badge: "glyph" },
  { lines: 2, plan: PLAN, showBar: true, badge: "text" },
  { lines: 2, plan: PLAN, showBar: true, badge: "glyph" },
  { lines: 2, plan: PLAN, showBar: false, badge: "glyph" },
  { lines: 2, plan: 0, showBar: false, badge: "glyph" },
  { lines: 2, plan: 0, showBar: false, badge: "none" },
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

/** The word a status badge carries, or `null` for the statuses that need no announcement. */
export function badgeText(account: { status: EAccountStatus }): string | null {
  if (account.status === EAccountStatus.expired) return 'expired';
  if (account.status === EAccountStatus.limited) return 'limited';
  return null;
}

function usageWidth(form: Form, meters: MeterWidths): number {
  return form.plan + (form.showBar ? meters.withGauge : meters.withoutGauge);
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
    if (room !== null && room >= LABEL_MIN)
      return { ...form, label: Math.min(LABEL_MAX, room) };
  }

  const poorestForm = FORMS[FORMS.length - 1] as Form;
  return { ...poorestForm, label: Math.max(3, width - GUTTER - MARGIN) };
}
