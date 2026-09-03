import {
  estimateCostUsd,
  type ModelCost,
  type ModelRef,
} from "@dltech/atlas-core";
import {
  NOTHING_SPENT,
  totalSpend,
  type SpendTotals,
  type TurnSpend,
} from "@dltech/atlas-harness";

import { formatTokens } from "../ui/theme";

export type ModelPriceLookup = (ref: ModelRef) => ModelCost | undefined;

/**
 * What the conversation has cost so far. The ledger only gains a row once a turn has ended, so the
 * turn in flight contributes the output tokens the clock has counted and nothing else: its input
 * and its cache figures are not known until the provider reports them.
 *
 * `costUsd` is null when nothing could be priced — a subscription-credential provider ships no
 * rates, and a figure of zero would read as a free conversation rather than an unpriced one.
 */
export type SidebarSpend = {
  totals: SpendTotals;
  costUsd: number | null;
};

export const NOTHING_TALLIED: SidebarSpend = {
  totals: NOTHING_SPENT,
  costUsd: null,
};

function costOfTurns(args: {
  turns: readonly TurnSpend[];
  priceOf: ModelPriceLookup;
}): number | null {
  let dollars: number | null = null;

  for (const turn of args.turns) {
    const cost = args.priceOf({
      providerId: turn.providerId,
      modelId: turn.modelId,
    });
    if (cost === undefined) continue;

    dollars = (dollars ?? 0) + estimateCostUsd({ spend: turn, cost });
  }

  return dollars;
}

export function sidebarSpendOf(args: {
  turns: readonly TurnSpend[];
  liveOutputTokens: number;
  priceOf?: ModelPriceLookup | undefined;
}): SidebarSpend {
  const ledger = totalSpend(args.turns);
  const totals: SpendTotals = {
    ...ledger,
    outputTokens: ledger.outputTokens + args.liveOutputTokens,
  };

  return {
    totals,
    costUsd:
      args.priceOf === undefined
        ? null
        : costOfTurns({ ...args, priceOf: args.priceOf }),
  };
}

const CENT = 0.01;

export const formatUsd = (dollars: number): string =>
  dollars > 0 && dollars < CENT
    ? `<$${CENT.toFixed(2)}`
    : `$${dollars.toFixed(2)}`;

const FIGURE_SEPARATOR = "  ";

/**
 * Cache reads are the figure worth a column of its own: they are counted inside `inputTokens` and
 * billed at a tenth of it, so an input total read without them badly over-states what a long
 * conversation costs.
 */
export function spendFigures(spend: SidebarSpend): string | null {
  const { inputTokens, outputTokens, cacheReadTokens } = spend.totals;
  if (inputTokens === 0 && outputTokens === 0) return null;

  const figures = [
    `↑ ${formatTokens(inputTokens)}`,
    `↓ ${formatTokens(outputTokens)}`,
    ...(cacheReadTokens === 0
      ? []
      : [`cache ${formatTokens(cacheReadTokens)}`]),
  ];

  return figures.join(FIGURE_SEPARATOR);
}
