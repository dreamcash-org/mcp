import {
  AGENT_VAULT_ADDRESSES,
  DEX_INDEX_MULTIPLIER,
  getDexFromCoin,
  HIP3_ASSET_INDEX_OFFSET,
  HIP4_ASSET_INDEX_OFFSET,
  hip3DexIdOfAssetIndex,
  SPOT_ASSET_INDEX_OFFSET,
} from "./shared/constants";
import {
  AGENT_KEY_METHODS,
  type ExchangeMethod,
  noCoinId,
  outcomeAssetId,
  type PlanStep,
  type TradePlan,
  type TradeRequestToSign,
  yesCoinId,
} from "./shared/hyperliquidOrders";
import type { InfoClient } from "@nktkas/hyperliquid";
import type { AgentTradeRequest } from "./agentApi";

// The request and its plan come from Dreamcash's server. Whatever it says,
// the agent's key signs only what the agent's own request_* call asked for,
// for the account the key trades for: L1 actions an API key may sign, only
// HLP as a vault, and no order far worse than the live price.

/** How much worse than the live mid an order may be priced; market orders slip at most 5% */
const MAX_PRICE_DEVIATION = 0.1;
/** How much over the size_usd asked an order may trade: a market order's price carries its slippage, at most 5% */
const MAX_NOTIONAL_OVER_ASKED = 1.05;
/** How far a price may sit from the one asked: the market's price grid rounds it */
const PRICE_GRID_TOLERANCE = 0.01;
// a division lands a hair past an exact bound (0.55 / 0.5 - 1 > 0.1)
const EPSILON = 1e-9;
const MICRO_USD = 1_000_000;

type Address = `0x${string}`;

type MarketReader = Pick<
  InfoClient,
  "meta" | "perpDexs" | "allMids" | "spotMeta"
>;
type HyperliquidReader = MarketReader &
  Pick<InfoClient, "userRole" | "orderStatus" | "clearinghouseState">;

export class UnsafePlanError extends Error {}

const refuse = (message: string): never => {
  throw new UnsafePlanError(message);
};

type WireOrder = Extract<
  PlanStep,
  { method: "order" }
>["params"]["orders"][number];
type Trigger = Extract<WireOrder["t"], { trigger: unknown }>["trigger"];

const triggerOf = (order: WireOrder): Trigger | undefined =>
  "trigger" in order.t ? order.t.trigger : undefined;

const ordersIn = (plan: TradePlan) =>
  plan.steps.flatMap((step) =>
    step.method === "order" ? step.params.orders : [],
  );

const upper = (name: string) => name.trim().toUpperCase();

const isSpotAsset = (assetId: number) =>
  assetId >= SPOT_ASSET_INDEX_OFFSET && assetId < HIP3_ASSET_INDEX_OFFSET;

const perpMarketOf = async (
  info: MarketReader,
  assetId: number,
): Promise<string | undefined> => {
  if (assetId < SPOT_ASSET_INDEX_OFFSET) {
    return (await info.meta({ dex: "" })).universe[assetId]?.name;
  }
  const dex = (await info.perpDexs())[hip3DexIdOfAssetIndex(assetId)]?.name;
  if (!dex) return undefined;
  const indexInDex = (assetId - HIP3_ASSET_INDEX_OFFSET) % DEX_INDEX_MULTIPLIER;
  return (await info.meta({ dex })).universe[indexInDex]?.name;
};

// A spot pair, with its base token when it's quoted in USDC ("HYPE/USDC")
const spotPairOf = async (info: MarketReader, assetId: number) => {
  const { universe, tokens } = await info.spotMeta();
  const pair = universe.find(
    (entry) => entry.index === assetId - SPOT_ASSET_INDEX_OFFSET,
  );
  if (!pair) return undefined;
  const tokenName = (index: number | undefined) =>
    tokens.find((token) => token.index === index)?.name;
  const [base, quote] = pair.tokens;
  return {
    name: pair.name,
    base: tokenName(quote) === "USDC" ? tokenName(base) : undefined,
  };
};

// What a request may call the market an asset trades, as the API resolves
// names: a perp by its name or base ("NVDA" for "xyz:NVDA"), a spot pair by
// its pair, its base token or HL's "@n"
const namesOf = async (
  info: MarketReader,
  assetId: number,
): Promise<string[]> => {
  if (assetId >= HIP4_ASSET_INDEX_OFFSET) return [];
  if (isSpotAsset(assetId)) {
    const pair = await spotPairOf(info, assetId);
    if (!pair) return [];
    const names = pair.base
      ? [pair.name, `${pair.base}/USDC`, pair.base]
      : [pair.name];
    return names.map(upper);
  }
  const market = await perpMarketOf(info, assetId);
  return market ? [market, market.split(":").at(-1) ?? market].map(upper) : [];
};

// The live mid of the asset an order names, checked against the market the
// step says it trades, so a mislabeled step can't borrow another price
const midOf = async (
  info: MarketReader,
  assetId: number,
  market: string | undefined,
): Promise<number> => {
  // an outcome side's mid is keyed "#<n>", n its offset past HIP-4's range
  if (assetId >= HIP4_ASSET_INDEX_OFFSET) {
    const mids = await info.allMids();
    return Number(mids[`#${assetId - HIP4_ASSET_INDEX_OFFSET}`]);
  }
  if (isSpotAsset(assetId)) {
    const pair =
      (await spotPairOf(info, assetId)) ??
      refuse(`spot asset ${assetId} isn't listed`);
    const mids = await info.allMids();
    return Number(
      mids[pair.name] ?? mids[`@${assetId - SPOT_ASSET_INDEX_OFFSET}`],
    );
  }
  const name = await perpMarketOf(info, assetId);
  if (!name || (market !== undefined && name !== market)) {
    return refuse(
      `the order's asset ${assetId} isn't ${market ?? "a listed market"}`,
    );
  }
  const mids = await info.allMids({ dex: getDexFromCoin(name) ?? "" });
  return Number(mids[name]);
};

// how much worse a price is for its side than a reference: a buy above it, a
// sell below it
const worseBy = (price: number, reference: number, isBuy: boolean) =>
  isBuy ? price / reference - 1 : 1 - price / reference;

// A trigger fires later at its own price: one the key signs may only reduce
// a position, and a limit it then fills at stays within 10% of the trigger
const checkTrigger = (order: WireOrder, trigger: Trigger) => {
  if (!order.r) refuse("a trigger order must be reduce-only");
  const triggerPrice = Number(trigger.triggerPx);
  if (!(triggerPrice > 0)) refuse(`a trigger is set at ${trigger.triggerPx}`);
  if (
    !trigger.isMarket &&
    !(
      worseBy(Number(order.p), triggerPrice, order.b) <=
      MAX_PRICE_DEVIATION + EPSILON
    )
  ) {
    refuse(
      `a trigger's limit ${order.p} is over 10% worse than its trigger ${trigger.triggerPx}`,
    );
  }
};

const checkOrderPrice = async (
  info: MarketReader,
  order: WireOrder,
  market: string | undefined,
) => {
  const trigger = triggerOf(order);
  if (trigger) return checkTrigger(order, trigger);
  const price = Number(order.p);
  if (!(price > 0)) refuse(`an order is priced at ${order.p}`);
  // an outcome trades between 0 and 1; paying 1 is its whole value
  if (order.a >= HIP4_ASSET_INDEX_OFFSET && price >= 1) {
    refuse(`an outcome order is priced at ${order.p}`);
  }
  const named = market ?? `asset ${order.a}`;
  const mid = await midOf(info, order.a, market);
  if (!(mid > 0)) {
    refuse(`there's no live price to check an order on ${named} against`);
  }
  const worse = worseBy(price, mid, order.b);
  if (worse > MAX_PRICE_DEVIATION + EPSILON) {
    refuse(
      `an order on ${named} is priced ${(worse * 100).toFixed(1)}% worse than the live price`,
    );
  }
};

/** Throws an UnsafePlanError when the agent's key shouldn't sign the plan */
export const checkAgentPlan = async (plan: TradePlan, info: MarketReader) => {
  for (const step of plan.steps) {
    if (!AGENT_KEY_METHODS.includes(step.method)) {
      refuse(`${step.method} needs the user's own wallet, not your key`);
    }
    if (
      step.method === "vaultTransfer" &&
      !(AGENT_VAULT_ADDRESSES as readonly string[]).includes(
        step.params.vaultAddress.toLowerCase(),
      )
    ) {
      refuse(`only HLP takes vault transfers from your key`);
    }
    if (step.method === "order") {
      for (const [index, order] of step.params.orders.entries()) {
        await checkOrderPrice(
          info,
          order,
          step.markets?.[index] ?? step.market,
        );
      }
    }
    if (step.method === "modify") {
      await checkOrderPrice(info, step.params.order, step.market);
    }
  }
};

type AgentKind = Exclude<
  TradeRequestToSign["kind"],
  "APPROVE_AGENT" | "WITHDRAW" | "SPOT_PERP_TRANSFER"
>;
type ParamsOf<K extends AgentKind> = Extract<
  TradeRequestToSign,
  { kind: K }
>["params"];

/** What the agent's own request_* call asked for */
export type AskedRequest = {
  kind: AgentKind;
  /** the request's params as the API records them from the call */
  params: Record<string, unknown>;
  /** the market it named, for a request on one */
  market?: string;
  /** the wallet it named; none means the main wallet */
  wallet?: string;
};

type ToolArgs = Record<string, unknown>;

const marketArg = (args: ToolArgs) =>
  typeof args.market === "string" ? args.market : "";
const lower = (value: unknown) =>
  typeof value === "string" ? value.toLowerCase() : value;

// What each request_* tool the key may carry out records from its arguments.
// Leverage left out means 1x; the fields in SERVER_FILLED stay unset and
// take whatever the server fills in.
const REQUEST_TOOLS: Record<
  string,
  (args: ToolArgs) => Omit<AskedRequest, "wallet">
> = {
  request_order: (a) => ({
    kind: "ORDER",
    market: marketArg(a),
    params: {
      side: a.side,
      sizeUsd: a.size_usd,
      orderType: a.order_type,
      limitPrice: a.limit_price,
      leverage: a.leverage ?? 1,
      reduceOnly: a.reduce_only,
      slippagePct: a.slippage_pct,
      takeProfitPrice: a.take_profit_price,
      stopLossPrice: a.stop_loss_price,
      takeProfitPct: a.take_profit_pct,
      stopLossPct: a.stop_loss_pct,
    },
  }),
  request_close_position: (a) => ({
    kind: "CLOSE",
    market: marketArg(a),
    params: { percent: a.percent, slippagePct: a.slippage_pct },
  }),
  request_cancel_order: (a) => ({
    kind: "CANCEL",
    market: marketArg(a),
    params: { orderId: a.order_id },
  }),
  request_set_tp_sl: (a) => ({
    kind: "SET_TPSL",
    market: marketArg(a),
    params: {
      takeProfitPrice: a.take_profit_price,
      stopLossPrice: a.stop_loss_price,
    },
  }),
  request_close_all: (a) => ({
    kind: "CLOSE_ALL",
    params: { slippagePct: a.slippage_pct },
  }),
  request_cancel_all: (a) => ({
    kind: "CANCEL_ALL",
    market: marketArg(a) || undefined,
    params: {},
  }),
  request_modify_order: (a) => ({
    kind: "MODIFY_ORDER",
    market: marketArg(a),
    params: { orderId: a.order_id, price: a.price, sizeUsd: a.size_usd },
  }),
  request_remove_tp_sl: (a) => ({
    kind: "REMOVE_TPSL",
    market: marketArg(a),
    params: { which: a.which },
  }),
  request_set_leverage: (a) => ({
    kind: "SET_LEVERAGE",
    market: marketArg(a),
    params: { leverage: a.leverage, marginMode: a.margin_mode },
  }),
  request_adjust_margin: (a) => ({
    kind: "ADJUST_MARGIN",
    market: marketArg(a),
    params: { amountUsd: a.amount_usd },
  }),
  request_spot_order: (a) => ({
    kind: "SPOT_ORDER",
    market: marketArg(a),
    params: {
      side: a.side,
      sizeUsd: a.size_usd,
      orderType: a.order_type,
      limitPrice: a.limit_price,
      slippagePct: a.slippage_pct,
    },
  }),
  request_vault_transfer: (a) => ({
    kind: "VAULT_TRANSFER",
    params: {
      vaultAddress: lower(a.vault_address),
      direction: a.direction,
      amountUsd: a.amount_usd,
    },
  }),
  request_prediction_order: (a) => ({
    kind: "PREDICTION_ORDER",
    params: {
      outcomeId: a.outcome_id,
      side: a.side,
      action: a.action,
      sizeUsd: a.size_usd,
      percent: a.percent,
      orderType: a.order_type,
      limitPrice: a.limit_price,
      slippagePct: a.slippage_pct,
    },
  }),
};

/** What a call asked for, when it's a request_* tool the key may carry out */
export const askedRequest = (
  tool: string,
  args: ToolArgs,
): AskedRequest | undefined => {
  if (!Object.hasOwn(REQUEST_TOOLS, tool)) return undefined;
  const build = REQUEST_TOOLS[tool] as (typeof REQUEST_TOOLS)[string];
  return {
    ...build(args),
    wallet: typeof args.wallet === "string" ? args.wallet : undefined,
  };
};

type Account = { info: HyperliquidReader; wallet: Address };

// The plan's orders that trade now: on the side asked, reduce-only as asked,
// and worth no more than asked
const checkEntries = (
  plan: TradePlan,
  asked: { isBuy?: boolean; reduceOnly: boolean; maxUsd?: number },
) => {
  const entries = ordersIn(plan).filter((order) => !triggerOf(order));
  for (const order of entries) {
    if (asked.isBuy !== undefined && order.b !== asked.isBuy) {
      refuse(`it ${order.b ? "buys" : "sells"}, the other side from yours`);
    }
    if (order.r !== asked.reduceOnly) {
      refuse(
        asked.reduceOnly
          ? "its order isn't reduce-only"
          : "its order is reduce-only, which you didn't ask for",
      );
    }
  }
  if (asked.maxUsd === undefined) return;
  const usd = entries.reduce(
    (sum, order) => sum + Number(order.s) * Number(order.p),
    0,
  );
  if (!(usd <= asked.maxUsd * MAX_NOTIONAL_OVER_ASKED + EPSILON)) {
    refuse(`it trades $${usd.toFixed(2)}, over the $${asked.maxUsd} you asked`);
  }
};

const near = (price: number, wanted: number) =>
  Math.abs(price / wanted - 1) <= PRICE_GRID_TOLERANCE;

// Take-profit and stop-loss legs only as asked: one the agent named, at its
// price, on the side that closes the position
const checkLegs = (
  plan: TradePlan,
  asked: { takeProfitPrice?: number; stopLossPrice?: number },
  closesWithBuy?: boolean,
) => {
  for (const order of ordersIn(plan)) {
    const trigger = triggerOf(order);
    if (!trigger) continue;
    const price =
      trigger.tpsl === "tp" ? asked.takeProfitPrice : asked.stopLossPrice;
    if (price === undefined) {
      return refuse(`it sets a ${trigger.tpsl} you didn't ask for`);
    }
    if (!near(Number(trigger.triggerPx), price)) {
      refuse(
        `its ${trigger.tpsl} triggers at ${trigger.triggerPx}, not ${price}`,
      );
    }
    if (closesWithBuy !== undefined && order.b !== closesWithBuy) {
      refuse(`its ${trigger.tpsl} trades the position's own side`);
    }
  }
};

const checkLeverage = (plan: TradePlan, leverage: number, isCross: boolean) => {
  const mode = (cross: boolean) => (cross ? "cross" : "isolated");
  for (const step of plan.steps) {
    if (
      step.method === "updateLeverage" &&
      (step.params.leverage !== leverage || step.params.isCross !== isCross)
    ) {
      refuse(
        `it sets ${step.params.leverage}x ${mode(step.params.isCross)}, not the ${leverage}x ${mode(isCross)} you asked`,
      );
    }
  }
};

const positionSizeOf = async ({ info, wallet }: Account, assetId: number) => {
  const market = await perpMarketOf(info, assetId);
  const state = await info.clearinghouseState({
    user: wallet,
    dex: getDexFromCoin(market ?? "") ?? "",
  });
  const position = state.assetPositions.find(
    (entry) => entry.position.coin === market,
  );
  return Math.abs(Number(position?.position.szi ?? 0));
};

// A moved order keeps its side and kind; its price and size are the ones
// asked, or stay as they rest
const checkModify = async (
  { oid, order }: Extract<PlanStep, { method: "modify" }>["params"],
  asked: ParamsOf<"MODIFY_ORDER">,
  { info, wallet }: Account,
) => {
  if (oid !== asked.orderId) {
    refuse(`it moves order ${oid}, not ${asked.orderId}`);
  }
  const status = await info.orderStatus({ user: wallet, oid });
  if (status.status !== "order") return refuse(`order ${oid} isn't yours`);
  const resting = status.order.order;
  const trigger = triggerOf(order);
  if (
    order.b !== (resting.side === "B") ||
    order.r !== resting.reduceOnly ||
    Boolean(trigger) !== resting.isTrigger
  ) {
    refuse(
      `it changes order ${oid}'s side or kind, not only its price or size`,
    );
  }
  const price = Number(trigger ? trigger.triggerPx : order.p);
  const wantedPrice =
    asked.price ??
    Number(resting.isTrigger ? resting.triggerPx : resting.limitPx);
  if (!near(price, wantedPrice)) {
    refuse(`it moves order ${oid} to ${price}, not ${wantedPrice}`);
  }
  const size = Number(order.s);
  const withinSize =
    asked.sizeUsd === undefined
      ? size <= Number(resting.sz)
      : size * price <= asked.sizeUsd * MAX_NOTIONAL_OVER_ASKED + EPSILON;
  if (!withinSize) refuse(`it makes order ${oid} bigger than you asked`);
};

type KindRule<K extends AgentKind> = {
  /** the only exchange calls a request of this kind makes */
  methods: readonly ExchangeMethod[];
  check?(
    plan: TradePlan,
    params: ParamsOf<K>,
    account: Account,
  ): void | Promise<void>;
};

const KIND_RULES: { [K in AgentKind]: KindRule<K> } = {
  ORDER: {
    methods: ["updateLeverage", "order", "cancel"],
    check: (plan, asked) => {
      const isLong = asked.side === "long";
      checkEntries(plan, {
        isBuy: isLong,
        reduceOnly: asked.reduceOnly,
        maxUsd: asked.sizeUsd,
      });
      checkLegs(plan, asked, !isLong);
      checkLeverage(plan, asked.leverage, false);
      // a cancel only replaces the position's legs when it gets new ones
      const asksLegs =
        asked.takeProfitPrice !== undefined ||
        asked.stopLossPrice !== undefined;
      if (!asksLegs && plan.steps.some((step) => step.method === "cancel")) {
        refuse("it cancels orders you didn't ask to");
      }
    },
  },
  CLOSE: {
    methods: ["order"],
    check: async (plan, asked, account) => {
      checkEntries(plan, { reduceOnly: true });
      checkLegs(plan, {});
      for (const order of ordersIn(plan)) {
        const held = await positionSizeOf(account, order.a);
        if (
          !(Number(order.s) <= ((held * asked.percent) / 100) * (1 + EPSILON))
        ) {
          refuse(`it closes more than ${asked.percent}% of the position`);
        }
      }
    },
  },
  CLOSE_ALL: {
    methods: ["order"],
    check: (plan) => {
      checkEntries(plan, { reduceOnly: true });
      checkLegs(plan, {});
    },
  },
  CANCEL: {
    methods: ["cancel"],
    check: (plan, asked) => {
      for (const step of plan.steps) {
        if (step.method !== "cancel") continue;
        for (const { o } of step.params.cancels) {
          if (o !== asked.orderId) {
            refuse(`it cancels order ${o}, not ${asked.orderId}`);
          }
        }
      }
    },
  },
  CANCEL_ALL: { methods: ["cancel"] },
  REMOVE_TPSL: { methods: ["cancel"] },
  SET_TPSL: {
    methods: ["order", "cancel"],
    check: (plan, asked) => {
      if (ordersIn(plan).some((order) => !triggerOf(order))) {
        refuse("it places an order, not only a take-profit or stop-loss");
      }
      checkLegs(plan, asked);
    },
  },
  MODIFY_ORDER: {
    methods: ["modify"],
    check: async (plan, asked, account) => {
      for (const step of plan.steps) {
        if (step.method === "modify") {
          await checkModify(step.params, asked, account);
        }
      }
    },
  },
  SET_LEVERAGE: {
    methods: ["updateLeverage"],
    check: (plan, asked) =>
      checkLeverage(plan, asked.leverage, asked.marginMode === "cross"),
  },
  ADJUST_MARGIN: {
    methods: ["updateIsolatedMargin"],
    check: (plan, asked) => {
      const ntli = Math.trunc(asked.amountUsd * MICRO_USD);
      for (const step of plan.steps) {
        if (
          step.method === "updateIsolatedMargin" &&
          step.params.ntli !== ntli
        ) {
          refuse(
            `it moves $${step.params.ntli / MICRO_USD} of margin, not $${asked.amountUsd}`,
          );
        }
      }
    },
  },
  SPOT_ORDER: {
    methods: ["order"],
    check: (plan, asked) => {
      checkEntries(plan, {
        isBuy: asked.side === "buy",
        reduceOnly: false,
        maxUsd: asked.sizeUsd,
      });
      checkLegs(plan, {});
    },
  },
  PREDICTION_ORDER: {
    methods: ["order"],
    check: (plan, asked) => {
      const isBuy = asked.action === "buy";
      checkEntries(plan, {
        isBuy,
        reduceOnly: false,
        maxUsd: isBuy ? (asked.sizeUsd ?? 0) : undefined,
      });
      checkLegs(plan, {});
    },
  },
  VAULT_TRANSFER: {
    methods: ["vaultTransfer"],
    check: (plan, asked) => {
      for (const step of plan.steps) {
        if (step.method !== "vaultTransfer") continue;
        const { vaultAddress, isDeposit, usd } = step.params;
        if (
          vaultAddress.toLowerCase() !== asked.vaultAddress.toLowerCase() ||
          isDeposit !== (asked.direction === "deposit")
        ) {
          refuse(
            `it ${isDeposit ? "deposits into" : "withdraws from"} vault ${vaultAddress}, not as you asked`,
          );
        }
        if (!(usd > 0 && usd <= asked.amountUsd * MICRO_USD + EPSILON)) {
          refuse(`it moves $${usd / MICRO_USD}, not $${asked.amountUsd}`);
        }
      }
    },
  },
};

const assetsOf = (step: PlanStep): number[] => {
  switch (step.method) {
    case "order":
      return step.params.orders.map((order) => order.a);
    case "cancel":
      return step.params.cancels.map((cancel) => cancel.a);
    case "modify":
      return [step.params.order.a];
    case "updateLeverage":
    case "updateIsolatedMargin":
      return [step.params.asset];
    default:
      return [];
  }
};

// Everything a request on one market signs is on it: a prediction on the
// outcome side asked, anything else on the market the agent named
const checkMarket = async (
  info: MarketReader,
  plan: TradePlan,
  asked: AskedRequest,
  claimed: TradeRequestToSign,
) => {
  const assets = new Set(plan.steps.flatMap(assetsOf));
  if (claimed.kind === "PREDICTION_ORDER") {
    const { outcomeId, side } = claimed.params;
    const expected = outcomeAssetId(
      side === "yes" ? yesCoinId(outcomeId) : noCoinId(outcomeId),
    );
    for (const assetId of assets) {
      if (assetId !== expected) {
        refuse(`it trades asset ${assetId}, not outcome ${outcomeId} ${side}`);
      }
    }
    return;
  }
  if (asked.market === undefined) return;
  const wanted = upper(asked.market);
  for (const assetId of assets) {
    if (!(await namesOf(info, assetId)).includes(wanted)) {
      refuse(`it trades asset ${assetId}, which isn't ${asked.market}`);
    }
  }
};

// An API key trades for the account that approved it; HL says which
const accountOfKey = new Map<string, Address>();
const accountTradedBy = async (
  info: Pick<InfoClient, "userRole">,
  key: Address,
): Promise<Address> => {
  const known = accountOfKey.get(key.toLowerCase());
  if (known) return known;
  const role = await info.userRole({ user: key });
  if (role.role !== "agent") {
    return refuse(
      "Hyperliquid doesn't list your key as approved by an account",
    );
  }
  const account = role.data.user.toLowerCase() as Address;
  accountOfKey.set(key.toLowerCase(), account);
  return account;
};

// Fields the server fills when a call leaves them out. Whatever it picks is
// bounded by the plan checks (the price band, the asked size and side), so
// the package needn't know the server's defaults and keeps working when
// they change.
const SERVER_FILLED = new Set([
  "orderType",
  "reduceOnly",
  "slippagePct",
  "percent",
  // the wallet's current mode on the market; the plan check pins it
  "marginMode",
]);

/**
 * Throws an UnsafePlanError unless the claimed request is the one the agent's
 * call asked for, on the account the key trades for, and its plan signs only
 * that
 */
export const checkAgentRequest = async ({
  claimed,
  asked,
  agentAddress,
  info,
}: {
  claimed: AgentTradeRequest & { plan: TradePlan };
  asked: AskedRequest;
  agentAddress: Address;
  info: HyperliquidReader;
}) => {
  const wallet = await accountTradedBy(info, agentAddress);
  // the call names no wallet for the main one
  const namedWallets = [claimed.walletAddress, asked.wallet ?? wallet];
  for (const named of namedWallets) {
    if (String(named).toLowerCase() !== wallet) {
      refuse(`it's for wallet ${named}, but your key trades for ${wallet}`);
    }
  }
  const recorded = claimed.params as Record<string, unknown>;
  if (
    claimed.kind !== asked.kind ||
    !Object.entries(asked.params).every(
      ([key, value]) =>
        (value === undefined && SERVER_FILLED.has(key)) ||
        recorded[key] === value,
    )
  ) {
    refuse("Dreamcash's request isn't the one you asked for");
  }
  const rule = KIND_RULES[asked.kind] as KindRule<AgentKind>;
  const { plan } = claimed;
  for (const step of plan.steps) {
    if (!rule.methods.includes(step.method)) {
      refuse(`a ${asked.kind.toLowerCase()} request doesn't ${step.method}`);
    }
  }
  await checkMarket(info, plan, asked, claimed);
  await rule.check?.(plan, claimed.params as ParamsOf<AgentKind>, {
    info,
    wallet,
  });
  await checkAgentPlan(plan, info);
};
