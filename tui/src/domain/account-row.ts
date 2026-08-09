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
