import { describe, expect, it } from 'bun:test';
import {
  accountRowLayout,
  extraUsageFlag,
  FLAGS,
  GUTTER,
  policyForms,
  type MeterWidths,
} from '../account-row.js';

/** The shipped style's numbers: `5h ▰▰▱▱▱  34%` twice, with the gap between them. */
const METERS: MeterWidths = { withGauge: 28, withoutGauge: 16 };

const layout = (width: number, badged = true) => accountRowLayout(width, METERS, badged);

describe('accountRowLayout', () => {
  it('spends a wide terminal on the label, up to the point where more stops helping', () => {
    expect(layout(200)).toEqual({
      lines: 1,
      label: 40,
      plan: 10,
      showBar: true,
      badge: 'text',
      flags: FLAGS,
    });
  });

  it('buys the policy flags only out of columns the label cannot use', () => {
    // gutter 6 + plan 10 + meters 28 + flags 12 + badge 12 + margin 2 + a full 40-wide label = 110.
    expect(layout(110).flags).toBe(FLAGS);
    expect(layout(110).label).toBe(40);
    // One column short, and the flags go rather than the label — which still gets its full 40 from
    // the columns they were asking for.
    expect(layout(109).flags).toBe(0);
    expect(layout(109).label).toBe(40);
  });

  it('sheds the flags before any measurement, at every shape', () => {
    expect(layout(80)).toMatchObject({ lines: 1, showBar: true, plan: 10, flags: 0 });
    expect(layout(56)).toMatchObject({ lines: 2, showBar: true, flags: 0 });
  });

  it('keeps one line, the plan and the gauges as long as the label still fits beside them', () => {
    const wide = layout(100);
    expect(wide.lines).toBe(1);
    expect(wide.showBar).toBe(true);
    expect(wide.plan).toBe(10);
    expect(wide.label).toBe(40);
  });

  it('gives the label every column it is owed and no more', () => {
    // 80 - gutter 6 - plan 10 - meters 28 - badge 12 - margin 2.
    expect(layout(80).label).toBe(22);
  });

  it('drops the badge to its glyph before it costs the label anything', () => {
    expect(layout(64)).toMatchObject({ lines: 1, badge: 'glyph', plan: 10, showBar: true });
  });

  it('wraps rather than shedding the gauges — vertical space is what a short list has spare', () => {
    const wrapped = layout(56);
    expect(wrapped.lines).toBe(2);
    expect(wrapped.showBar).toBe(true);
    expect(wrapped.plan).toBe(10);
  });

  it('gives a wrapped label the whole line, minus the badge that shares it', () => {
    expect(layout(56).label).toBe(56 - GUTTER - 12 - 2);
  });

  it('sheds the gauges only once the second line cannot hold them', () => {
    // 6 + 10 + 28 + 2 = 46 is the last width the gauges fit on their own line.
    expect(layout(46).showBar).toBe(true);
    expect(layout(45).showBar).toBe(false);
  });

  it('sheds the plan after the gauges', () => {
    // 6 + 10 + 16 = 32, plus the margin: 34 is the last width the bare meters and the plan share.
    expect(layout(45).plan).toBe(10);
    expect(layout(34).plan).toBe(10);
    expect(layout(33).plan).toBe(0);
  });

  it('never returns a label narrower than something can be read from', () => {
    expect(layout(20).label).toBeGreaterThanOrEqual(3);
    expect(layout(1).label).toBeGreaterThanOrEqual(3);
  });

  it('reserves the badge column only when an account actually carries one', () => {
    expect(layout(80, false).label).toBe(layout(80, true).label + 12);
  });

  it('stops reserving it once the label has all it can use', () => {
    expect(layout(200, false).label).toBe(layout(200, true).label);
  });
});
