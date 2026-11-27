// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
import { sha256, toBytes } from "viem";

// The params of a trade request an AI client made, as the API stores them
// (apps/api/src/services/trade-request.service.ts).
export type OrderRequestParams = {
  side: "long" | "short";
  sizeUsd: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  leverage: number;
  reduceOnly: boolean;
  slippagePct: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  /** % from a market order's fill; a key trading on its own sets these once it filled */
  takeProfitPct?: number;
  stopLossPct?: number;
};
export type CloseRequestParams = { percent: number; slippagePct: number };
export type CancelRequestParams = { orderId: number };
export type SetTpslRequestParams = {
  takeProfitPrice?: number;
  stopLossPrice?: number;
};
export type ApproveAgentRequestParams = {
  agentAddress: string;
  /** ms since epoch */
  validUntil: number;
};

export type CloseAllRequestParams = { slippagePct: number };
export type CancelAllRequestParams = Record<string, never>;
export type ModifyOrderRequestParams = {
  orderId: number;
  /** a limit order's new price, or a TP/SL's new trigger */
  price?: number;
  sizeUsd?: number;
};
export type RemoveTpslRequestParams = { which: "tp" | "sl" | "both" };
export type SetLeverageRequestParams = {
  leverage: number;
  marginMode: "cross" | "isolated";
};
/** positive adds margin to an isolated position, negative takes it out */
export type AdjustMarginRequestParams = { amountUsd: number };
export type SpotOrderRequestParams = {
  side: "buy" | "sell";
  sizeUsd: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  slippagePct: number;
};
export type VaultTransferRequestParams = {
  vaultAddress: string;
  direction: "deposit" | "withdraw";
  amountUsd: number;
};
export type WithdrawRequestParams = { amountUsd: number; destination: string };
export type PredictionOrderRequestParams = {
  outcomeId: number;
  side: "yes" | "no";
  action: "buy" | "sell";
  /** a buy's budget: it never spends more */
  sizeUsd?: number;
  /** a sell's share of the holding, 1-100 */
  percent?: number;
  orderType: "market" | "limit";
  /** the price of one share, between 0 and 1 */
  limitPrice?: number;
  slippagePct: number;
};
export type SpotPerpTransferRequestParams = {
  amountUsd: number;
  toPerp: boolean;
};

export type TradeRequestToSign =
  | { kind: "ORDER"; params: OrderRequestParams }
  | { kind: "CLOSE"; params: CloseRequestParams }
  | { kind: "CANCEL"; params: CancelRequestParams }
  | { kind: "SET_TPSL"; params: SetTpslRequestParams }
  | { kind: "APPROVE_AGENT"; params: ApproveAgentRequestParams }
  | { kind: "CLOSE_ALL"; params: CloseAllRequestParams }
  | { kind: "CANCEL_ALL"; params: CancelAllRequestParams }
  | { kind: "MODIFY_ORDER"; params: ModifyOrderRequestParams }
  | { kind: "REMOVE_TPSL"; params: RemoveTpslRequestParams }
  | { kind: "SET_LEVERAGE"; params: SetLeverageRequestParams }
  | { kind: "ADJUST_MARGIN"; params: AdjustMarginRequestParams }
  | { kind: "SPOT_ORDER"; params: SpotOrderRequestParams }
  | { kind: "VAULT_TRANSFER"; params: VaultTransferRequestParams }
  | { kind: "WITHDRAW"; params: WithdrawRequestParams }
  | { kind: "PREDICTION_ORDER"; params: PredictionOrderRequestParams }
  | { kind: "SPOT_PERP_TRANSFER"; params: SpotPerpTransferRequestParams };

export type TradeRequestCloids = {
  main: `0x${string}`;
  takeProfit: `0x${string}`;
  stopLoss: `0x${string}`;
};

export type TpslKind = "tp" | "sl";

/** The trigger of a take-profit or stop-loss `pct` % from the entry's fill */
export const tpslPriceFromFill = (
  fillPrice: number,
  pct: number,
  kind: TpslKind,
  isLong: boolean,
) => (fillPrice * (100 + ((kind === "tp") === isLong ? pct : -pct))) / 100;

export type Leverage = { type: "cross" | "isolated"; value: number };

/** The account and market as they stand when the plan is built */
export type TradeRequestMarketState = {
  assetId: number;
  szDecimals: number;
  midPrice: number;
  /** the position's signed size (HL's `szi`), 0 when there is none */
  positionSize: number;
  /** what HL applies to this market's next order (`activeAssetData`) */
  leverage: Leverage;
  /** the position's resting TP/SL orders */
  restingTpslLegs: { oid: number; tpsl: TpslKind }[];
};

export type PositionState = {
  market: string;
  assetId: number;
  szDecimals: number;
  midPrice: number;
  /** signed, as HL's `szi` */
  size: number;
};

export type OrderRef = { oid: number; assetId: number; market: string };

/** A resting order, as the account shows it, to move */
export type RestingOrder = OrderRef & {
  szDecimals: number;
  isBuy: boolean;
  /** on the lot, as HL shows it */
  size: string;
  limitPrice: number;
  reduceOnly: boolean;
  tif: "Gtc" | "Ioc" | "Alo";
  trigger?: { tpsl: TpslKind; isMarket: boolean; triggerPrice: number };
};

export type SpotState = {
  assetId: number;
  /** the base token's lot decimals */
  szDecimals: number;
  midPrice: number;
  /** base token the wallet holds and may sell */
  baseAvailable: number;
};

/** One side of a prediction market (an outcome's YES or NO shares) */
export type PredictionState = {
  assetId: number;
  /** this side's mid, the price of one share */
  midPrice: number;
  /** shares of this side the wallet holds and may sell */
  sharesAvailable: number;
};

/** What a plan reads: each request kind uses its own part */
export type PlanContext = {
  market?: TradeRequestMarketState;
  positions?: PositionState[];
  openOrders?: OrderRef[];
  order?: RestingOrder;
  spot?: SpotState;
  prediction?: PredictionState;
};

/** The cloid of a request's order after its first, for batches (close all) */
export const cloidAt = (main: `0x${string}`, index: number): `0x${string}` =>
  index === 0 ? main : `0x${sha256(toBytes(`${main}:${index}`)).slice(2, 34)}`;

export type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t:
    | { limit: { tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } }
    | { trigger: { isMarket: boolean; triggerPx: string; tpsl: TpslKind } };
  c?: `0x${string}`;
};

export type Builder = { builder?: { b: `0x${string}`; f: number } };

/**
 * One exchange call, as @nktkas/hyperliquid's ExchangeClient takes it. A
 * signer sends `params` to `exchange[method]` unchanged.
 */
export type ExchangeStep =
  | {
      method: "order";
      params: {
        orders: OrderWire[];
        grouping: "na" | "normalTpsl" | "positionTpsl";
      } & Builder;
    }
  | { method: "cancel"; params: { cancels: { a: number; o: number }[] } }
  | { method: "modify"; params: { oid: number; order: OrderWire } }
  | {
      method: "updateLeverage";
      params: { asset: number; isCross: boolean; leverage: number };
    }
  | {
      method: "updateIsolatedMargin";
      params: { asset: number; isBuy: boolean; ntli: number };
    }
  | {
      method: "vaultTransfer";
      params: { vaultAddress: `0x${string}`; isDeposit: boolean; usd: number };
    }
  | {
      method: "approveAgent";
      params: { agentAddress: `0x${string}`; agentName: string };
    }
  | {
      method: "approveBuilderFee";
      params: { maxFeeRate: string; builder: `0x${string}` };
    }
  | {
      method: "withdraw3";
      params: { destination: `0x${string}`; amount: string };
    }
  | {
      method: "usdClassTransfer";
      params: { amount: string; toPerp: boolean };
    };

export type ExchangeMethod = ExchangeStep["method"];

/** What an AI client's own HL API key may sign: L1 actions on the account */
export const AGENT_KEY_METHODS: readonly ExchangeMethod[] = [
  "order",
  "cancel",
  "modify",
  "updateLeverage",
  "updateIsolatedMargin",
  "vaultTransfer",
];

/** Signed by the user's own wallet (EIP-712 user actions): they take no expiresAfter */
export const USER_SIGNED_METHODS: readonly ExchangeMethod[] = [
  "approveAgent",
  "approveBuilderFee",
  "withdraw3",
  "usdClassTransfer",
];

/**
 * - `setup`: before the request's own action; failing means it never went
 * - `main`: the request's own action
 * - `follow_up`: after it; failing is reported, the request still happened
 */
export type StepRole = "setup" | "main" | "follow_up";

export type PlanStep = ExchangeStep & {
  role: StepRole;
  /** what the step does, in words a person reads ("set 5x isolated leverage") */
  purpose: string;
  /** a follow-up that only makes sense once the main order filled something */
  onlyIfMainFilled?: boolean;
  /** the market an order step trades, for a signer's live-price check */
  market?: string;
  /** a batch's market per order, at the same index as `params.orders` (close all) */
  markets?: string[];
};

/** The exchange calls a request signs, in the order they go out */
export type TradePlan = {
  steps: PlanStep[];
  /** the leverage an order trades at, for the review */
  leverage?: Leverage;
  /** the order's notional at its reference price, for the review */
  notionalUsd?: number;
};
