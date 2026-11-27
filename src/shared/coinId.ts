// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
import { HIP4_ASSET_INDEX_OFFSET } from "./constants";

export const yesCoinId = (outcomeId: number): string => `#${outcomeId * 10}`;

export const noCoinId = (outcomeId: number): string => `#${outcomeId * 10 + 1}`;

/** Convert any outcome coin (`+30` or `#30`) to the `#`-prefixed form used
 * by `mids` / `l2Book`. Returns null if the input isn't an outcome coin. */
export const outcomeMidKey = (coin: string): string | null => {
  const body = stripOutcomePrefix(coin);
  return body === null ? null : `#${body}`;
};

const stripOutcomePrefix = (coin: string): string | null => {
  if (!coin.startsWith("+") && !coin.startsWith("#")) return null;
  const body = coin.slice(1);
  return body === "" ? null : body;
};

/** Parse "+22430" or "#22430" back to { outcomeId: 2243, side: "yes" }. */
export const parseOutcomeCoin = (
  coin: string,
): { outcomeId: number; side: "yes" | "no" } | null => {
  const body = stripOutcomePrefix(coin);
  if (body === null) return null;
  const n = Number(body);
  if (!Number.isInteger(n) || n < 0) return null;
  const side = n % 10 === 0 ? "yes" : n % 10 === 1 ? "no" : null;
  if (!side) return null;
  return { outcomeId: Math.floor(n / 10), side };
};

export const isOutcomeCoin = (coin: string): boolean =>
  parseOutcomeCoin(coin) !== null;

/** Numeric asset index Hyperliquid expects in `order.a` for an outcome coin.
 * `+90` (YES of outcome 9) → 100000090, `+91` (NO of outcome 9) → 100000091. */
export const outcomeAssetId = (coin: string): number | null => {
  const body = stripOutcomePrefix(coin);
  if (body === null) return null;
  const n = Number(body);
  if (!Number.isInteger(n) || n < 0) return null;
  return HIP4_ASSET_INDEX_OFFSET + n;
};
