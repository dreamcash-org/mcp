/// <reference types="bun" />
import { describe, expect, mock, test } from "bun:test";
import type { PlanStep, TradePlan } from "./shared/hyperliquidOrders";
import { ApiRequestError, HttpRequestError } from "@nktkas/hyperliquid";
import type { AgentTradeRequest } from "./agentApi";
import {
  type AskedRequest,
  askedRequest,
  checkAgentPlan,
  checkAgentRequest,
} from "./agentSafety";
import { executeTradeRequest, KeyApprovalRequest } from "./executeTradeRequest";

const ID = "4b7f0a52-3f1c-4a3e-9d55-0c1f3c2b9e10";
const WALLET = "0xabc0000000000000000000000000000000000001";
const OTHER_WALLET = "0xabc0000000000000000000000000000000000002";
// the agent's key, approved by WALLET; another key, approved by OTHER_WALLET
const KEY = "0x00000000000000000000000000000000000000a1";
const OTHER_KEY = "0x00000000000000000000000000000000000000a2";
const HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

const pending: AgentTradeRequest = {
  id: ID,
  status: "PENDING",
  kind: "CANCEL",
  params: { orderId: 77 },
  market: "BTC",
  walletAddress: WALLET,
  cloids: {
    main: "0x00000000000000000000000000000001",
    takeProfit: "0x00000000000000000000000000000002",
    stopLoss: "0x00000000000000000000000000000003",
  },
  plan: null,
  result: null,
};

// BTC is perp 0, xyz:NVDA is HIP-3 dex 1's second market, PURR/USDC spot pair 0
const info = {
  meta: async ({ dex }: { dex?: string }) => ({
    universe:
      dex === "xyz"
        ? [{ name: "xyz:TSLA" }, { name: "xyz:NVDA" }]
        : [{ name: "BTC" }, { name: "ETH" }],
  }),
  perpDexs: async () => [null, { name: "xyz" }],
  allMids: async ({ dex }: { dex?: string } = {}) =>
    dex === "xyz"
      ? { "xyz:NVDA": "180" }
      : {
          BTC: "100000",
          ETH: "3000",
          "PURR/USDC": "0.2",
          // YES of outcomes 9 and 10
          "#90": "0.40",
          "#100": "0.5",
        },
  spotMeta: async () => ({
    tokens: [
      { name: "USDC", index: 0 },
      { name: "PURR", index: 1 },
    ],
    universe: [{ name: "PURR/USDC", index: 0, tokens: [1, 0] }],
  }),
  userRole: async ({ user }: { user: string }) =>
    user === KEY
      ? { role: "agent", data: { user: WALLET } }
      : user === OTHER_KEY
        ? { role: "agent", data: { user: OTHER_WALLET } }
        : { role: "missing" },
  // order 88 rests as a BTC buy of 0.002 at 99000
  orderStatus: async ({ oid }: { oid: number }) =>
    oid === 88
      ? {
          status: "order",
          order: {
            order: {
              side: "B",
              limitPx: "99000",
              triggerPx: "0.0",
              sz: "0.002",
              isTrigger: false,
              reduceOnly: false,
            },
          },
        }
      : { status: "unknownOid" },
  // a 0.01 BTC short
  clearinghouseState: async () => ({
    assetPositions: [{ position: { coin: "BTC", szi: "-0.01" } }],
  }),
};

const step = (
  overrides: Partial<PlanStep> & Pick<PlanStep, "method" | "params">,
) => ({ role: "main", purpose: "test", ...overrides }) as PlanStep;

type Order = Extract<PlanStep, { method: "order" }>["params"]["orders"][number];

const limit = (
  a: number,
  b: boolean,
  p: string,
  s = "1",
  r = false,
): Order => ({ a, b, p, s, r, t: { limit: { tif: "Gtc" } } });

const trigger = (
  b: boolean,
  triggerPx: string,
  tpsl: "tp" | "sl",
  { r = true, isMarket = true, p = triggerPx } = {},
): Order => ({
  a: 0,
  b,
  p,
  s: "0",
  r,
  t: { trigger: { isMarket, triggerPx, tpsl } },
});

const orderStep = (
  orders: Order[],
  market?: string,
  overrides: Partial<Pick<PlanStep, "role" | "markets">> = {},
) =>
  step({
    method: "order",
    params: { orders, grouping: "na" },
    market,
    ...overrides,
  });

const order = (a: number, b: boolean, p: string, market?: string) =>
  orderStep([limit(a, b, p)], market);

const cancelPlan: TradePlan = {
  steps: [step({ method: "cancel", params: { cancels: [{ a: 0, o: 77 }] } })],
};

const askedCancel = askedRequest("request_cancel_order", {
  market: "BTC",
  order_id: 77,
}) as AskedRequest;

const fakeApi = (
  statuses: AgentTradeRequest["status"][],
  plan = cancelPlan,
  claimed: Partial<AgentTradeRequest> = {},
) => {
  const reads = [...statuses];
  return {
    get: mock(async () => ({ ...pending, status: reads.shift() ?? "CLAIMED" })),
    claim: mock(async () => ({
      ...pending,
      status: "CLAIMED" as const,
      plan,
      expiresAfter: 1_800_000_000_000,
      ...claimed,
    })),
    sent: mock(async () => ({ status: "CLAIMED" as const })),
    notSent: mock(async () => ({ status: "FAILED" as const })),
  };
};

const run = (
  api: ReturnType<typeof fakeApi>,
  cancel: () => Promise<unknown> = async () => ({ status: "ok" }),
) => {
  const exchange = {
    cancel: mock(cancel),
    approveAgent: mock(async () => ({})),
  };
  return {
    exchange,
    outcome: executeTradeRequest({
      id: ID,
      asked: askedCancel,
      agentAddress: KEY,
      api: api as never,
      info: info as never,
      exchange: exchange as never,
      sleep: async () => undefined,
    }),
  };
};

describe("executeTradeRequest", () => {
  test("claims once, sends the claimed plan with its deadline, then waits for the outcome", async () => {
    const api = fakeApi(["PENDING", "CLAIMED", "CLAIMED", "EXECUTED"]);
    const { exchange, outcome } = run(api);
    expect((await outcome).request.status).toBe("EXECUTED");
    expect(api.claim).toHaveBeenCalledTimes(1);
    expect(exchange.cancel).toHaveBeenCalledTimes(1);
    expect(exchange.cancel).toHaveBeenCalledWith(
      { cancels: [{ a: 0, o: 77 }] },
      { expiresAfter: 1_800_000_000_000 },
    );
    expect(api.sent).toHaveBeenCalledWith(ID);
    expect(api.notSent).not.toHaveBeenCalled();
  });

  test("reports a request Hyperliquid refused as never sent", async () => {
    const api = fakeApi(["PENDING", "FAILED"]);
    const { outcome } = run(api, async () => {
      throw new ApiRequestError({ status: "err", response: "never placed" });
    });
    expect((await outcome).request.status).toBe("FAILED");
    expect(api.notSent).toHaveBeenCalledTimes(1);
    expect(api.sent).not.toHaveBeenCalled();
  });

  test("leaves a request that isn't pending alone", async () => {
    const api = fakeApi(["EXECUTED"]);
    const { exchange, outcome } = run(api);
    expect((await outcome).request.status).toBe("EXECUTED");
    expect(api.claim).not.toHaveBeenCalled();
    expect(exchange.cancel).not.toHaveBeenCalled();
  });

  test("leaves approving its own key to the user", async () => {
    const api = {
      ...fakeApi([]),
      get: mock(async () => ({
        ...pending,
        kind: "APPROVE_AGENT" as const,
        params: { agentAddress: KEY, validUntil: Date.now() + 1 },
      })),
    };
    const { outcome } = run(api as never);
    await expect(outcome).rejects.toBeInstanceOf(KeyApprovalRequest);
    expect(api.claim).not.toHaveBeenCalled();
  });

  test("signs nothing from a plan it refuses, and says so", async () => {
    const unsafe: TradePlan = {
      steps: [
        step({
          method: "approveAgent",
          params: { agentAddress: KEY, agentName: "x" },
        }),
      ],
    };
    const api = fakeApi(["PENDING", "FAILED"], unsafe);
    const { exchange, outcome } = run(api);
    expect((await outcome).refused).toContain("refused by your Dreamcash MCP");
    expect(exchange.approveAgent).not.toHaveBeenCalled();
    expect(api.notSent).toHaveBeenCalledWith(
      ID,
      expect.stringContaining("refused by your Dreamcash MCP"),
    );
  });

  test("signs nothing for a wallet its key doesn't trade for", async () => {
    const api = fakeApi(["PENDING", "FAILED"], cancelPlan, {
      walletAddress: OTHER_WALLET,
    });
    const { exchange, outcome } = run(api);
    expect((await outcome).refused).toContain("your key trades for");
    expect(exchange.cancel).not.toHaveBeenCalled();
    expect(api.notSent).toHaveBeenCalledTimes(1);
  });

  test("reports nothing when Hyperliquid's answer was lost", async () => {
    const api = fakeApi(["PENDING", "CLAIMED", "UNKNOWN"]);
    const { outcome } = run(api, async () => {
      throw new HttpRequestError(undefined, {
        cause: new Error("socket hang up"),
      });
    });
    expect((await outcome).request.status).toBe("UNKNOWN");
    expect(api.sent).not.toHaveBeenCalled();
    expect(api.notSent).not.toHaveBeenCalled();
  });
});

describe("checkAgentPlan", () => {
  const check = (steps: PlanStep[]) => checkAgentPlan({ steps }, info as never);

  test("passes orders near the live price, on perps, HIP-3 and spot", async () => {
    await expect(
      check([
        order(0, true, "105000", "BTC"),
        order(0, false, "95000", "BTC"),
        order(110_001, true, "190", "xyz:NVDA"),
        order(10_000, true, "0.21"),
        // an outcome buy within its slippage, and a sell above the mid
        order(100_000_090, true, "0.432"),
        order(100_000_090, false, "0.5"),
        // exactly 10% over, which floats past 0.1 (0.55 / 0.5 - 1)
        order(100_000_100, true, "0.55"),
        // a buy far below the price only rests
        order(1, true, "1000", "ETH"),
      ]),
    ).resolves.toBeUndefined();
  });

  test("checks each order of a close-all batch against its own market", async () => {
    const batch = [limit(0, true, "101000"), limit(110_001, false, "178")];
    await expect(check([orderStep(batch)])).resolves.toBeUndefined();
    await expect(
      check([orderStep(batch, undefined, { markets: ["BTC", "xyz:NVDA"] })]),
    ).resolves.toBeUndefined();
    await expect(
      check([orderStep(batch, undefined, { markets: ["BTC", "xyz:TSLA"] })]),
    ).rejects.toThrow("isn't xyz:TSLA");
  });

  test.each([
    [
      "a buy far above the price",
      order(0, true, "120000", "BTC"),
      "worse than the live price",
    ],
    [
      "a sell far below it",
      order(0, false, "80000", "BTC"),
      "worse than the live price",
    ],
    [
      "a step naming another market than its asset",
      order(1, true, "100000", "BTC"),
      "isn't BTC",
    ],
    [
      "an outcome priced at its whole value",
      order(100_000_090, true, "1"),
      "outcome order",
    ],
    [
      "an outcome buy far above its odds",
      order(100_000_090, true, "0.999"),
      "worse than the live price",
    ],
    [
      "an outcome with no live price",
      order(100_000_120, true, "0.5"),
      "no live price",
    ],
    [
      "a trigger that can open a position",
      orderStep([trigger(false, "50000", "sl", { r: false })]),
      "reduce-only",
    ],
    [
      "a trigger's limit far worse than its trigger",
      orderStep([
        trigger(false, "50000", "sl", { isMarket: false, p: "40000" }),
      ]),
      "worse than its trigger",
    ],
    [
      "an action only the user's wallet may sign",
      step({
        method: "withdraw3",
        params: { destination: WALLET, amount: "1" },
      }),
      "needs the user's own wallet",
    ],
    [
      "a vault other than HLP",
      step({
        method: "vaultTransfer",
        params: { vaultAddress: WALLET, isDeposit: true, usd: 1 },
      }),
      "only HLP",
    ],
  ])("refuses %s", async (_, unsafe, message) => {
    await expect(check([unsafe])).rejects.toThrow(message);
  });

  test("lets HLP and reduce-only triggers through", async () => {
    await expect(
      check([
        step({
          method: "vaultTransfer",
          params: { vaultAddress: HLP, isDeposit: true, usd: 1_000_000 },
        }),
        orderStep([
          trigger(false, "50000", "sl"),
          trigger(false, "50000", "sl", { isMarket: false, p: "45000" }),
        ]),
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("checkAgentRequest", () => {
  // what the API fills in for fields a call leaves out
  const serverFilled = (params: Record<string, unknown>) => {
    const filled = { ...params };
    for (const [key, value] of Object.entries({
      orderType: "market",
      reduceOnly: false,
      slippagePct: 1,
      percent: 100,
      // the wallet's current mode, as the server reads it
      marginMode: "cross",
    })) {
      if (key in filled && filled[key] === undefined) filled[key] = value;
    }
    return filled;
  };

  // Dreamcash recorded what the call asked unless `recorded` says otherwise
  const check = (
    tool: string,
    args: Record<string, unknown>,
    steps: PlanStep[],
    {
      recorded = {},
      agentAddress = KEY,
    }: {
      recorded?: Partial<AgentTradeRequest>;
      agentAddress?: `0x${string}`;
    } = {},
  ) => {
    const asked = askedRequest(tool, args) as AskedRequest;
    return checkAgentRequest({
      claimed: {
        ...pending,
        kind: asked.kind,
        params: serverFilled(asked.params),
        ...recorded,
        plan: { steps },
      } as never,
      asked,
      agentAddress,
      info: info as never,
    });
  };

  const BTC_LONG = {
    market: "BTC",
    side: "long",
    size_usd: 1000,
    leverage: 5,
    take_profit_price: 110000,
  };
  const btcLong = ({
    entry = limit(0, true, "101000", "0.01"),
    leverage = 5,
    legs = [trigger(false, "110000", "tp")],
  } = {}) => [
    step({
      method: "updateLeverage",
      params: { asset: 0, isCross: false, leverage },
      role: "setup",
    }),
    orderStep([entry], "BTC"),
    orderStep(legs, undefined, { role: "follow_up" }),
    step({
      method: "cancel",
      params: { cancels: [{ a: 0, o: 5 }] },
      role: "follow_up",
    }),
  ];

  test.each([
    ["a perp order with its take-profit", "request_order", BTC_LONG, btcLong()],
    [
      "an order on a HIP-3 market named by its base",
      "request_order",
      { market: "NVDA", side: "short", size_usd: 180 },
      [orderStep([limit(110_001, false, "178", "1")], "xyz:NVDA")],
    ],
    [
      "half a position's close",
      "request_close_position",
      { market: "BTC", percent: 50 },
      [orderStep([limit(0, true, "101000", "0.005", true)], "BTC")],
    ],
    [
      "a close-all batch",
      "request_close_all",
      {},
      [
        orderStep([
          limit(0, true, "101000", "0.01", true),
          limit(110_001, false, "178", "2", true),
        ]),
      ],
    ],
    [
      "a cancel",
      "request_cancel_order",
      { market: "BTC", order_id: 77 },
      cancelPlan.steps,
    ],
    [
      "a moved order",
      "request_modify_order",
      { market: "BTC", order_id: 88, price: 98000 },
      [
        step({
          method: "modify",
          params: { oid: 88, order: limit(0, true, "98000", "0.002") },
          market: "BTC",
        }),
      ],
    ],
    [
      "a leverage change",
      "request_set_leverage",
      { market: "ETH", leverage: 3, margin_mode: "cross" },
      [
        step({
          method: "updateLeverage",
          params: { asset: 1, isCross: true, leverage: 3 },
        }),
      ],
    ],
    [
      "a leverage change that leaves the mode as the wallet has it",
      "request_set_leverage",
      { market: "ETH", leverage: 3 },
      [
        step({
          method: "updateLeverage",
          params: { asset: 1, isCross: true, leverage: 3 },
        }),
      ],
    ],
    [
      "margin taken out",
      "request_adjust_margin",
      { market: "BTC", amount_usd: -25 },
      [
        step({
          method: "updateIsolatedMargin",
          params: { asset: 0, isBuy: false, ntli: -25_000_000 },
        }),
      ],
    ],
    [
      "a spot buy named by its token",
      "request_spot_order",
      { market: "PURR", side: "buy", size_usd: 20 },
      [orderStep([limit(10_000, true, "0.21", "95")], "PURR/USDC")],
    ],
    [
      "a prediction buy at exactly 10% slippage",
      "request_prediction_order",
      {
        outcome_id: 10,
        side: "yes",
        action: "buy",
        size_usd: 10,
        slippage_pct: 10,
      },
      [orderStep([limit(100_000_100, true, "0.55", "18")])],
    ],
    [
      "an HLP deposit",
      "request_vault_transfer",
      {
        vault_address: HLP.toUpperCase(),
        direction: "deposit",
        amount_usd: 100,
      },
      [
        step({
          method: "vaultTransfer",
          params: { vaultAddress: HLP, isDeposit: true, usd: 100_000_000 },
        }),
      ],
    ],
  ])("passes %s", async (_, tool, args, steps) => {
    await expect(check(tool, args, steps)).resolves.toBeUndefined();
  });

  test.each([
    [
      "a wallet its key doesn't trade for",
      () =>
        check("request_order", BTC_LONG, btcLong(), {
          recorded: { walletAddress: OTHER_WALLET },
        }),
      "your key trades for",
    ],
    [
      "a wallet the call named that its key doesn't trade for",
      () =>
        check(
          "request_order",
          { ...BTC_LONG, wallet: OTHER_WALLET },
          btcLong(),
        ),
      "your key trades for",
    ],
    [
      "a key Hyperliquid doesn't list as approved",
      () =>
        check("request_order", BTC_LONG, btcLong(), {
          agentAddress: "0x00000000000000000000000000000000000000a3",
        }),
      "doesn't list your key",
    ],
    [
      "another kind than asked",
      () =>
        check("request_order", BTC_LONG, btcLong(), {
          recorded: { kind: "CLOSE", params: { percent: 100, slippagePct: 2 } },
        }),
      "isn't the one you asked for",
    ],
    [
      "a leverage the call left at its default",
      () =>
        check(
          "request_order",
          { ...BTC_LONG, leverage: undefined },
          btcLong(),
          {
            recorded: {
              params: {
                ...(askedRequest("request_order", BTC_LONG) as AskedRequest)
                  .params,
                leverage: 5,
              } as never,
            },
          },
        ),
      "isn't the one you asked for",
    ],
    [
      "a stop-loss the call didn't ask for",
      () =>
        check("request_order", BTC_LONG, btcLong(), {
          recorded: {
            params: {
              ...(askedRequest("request_order", BTC_LONG) as AskedRequest)
                .params,
              stopLossPrice: 99000,
            } as never,
          },
        }),
      "isn't the one you asked for",
    ],
    [
      "an order worth more than asked",
      () =>
        check(
          "request_order",
          BTC_LONG,
          btcLong({
            entry: limit(0, true, "101000", "0.011"),
          }),
        ),
      "over the $1000 you asked",
    ],
    [
      "an order on the other side",
      () =>
        check(
          "request_order",
          BTC_LONG,
          btcLong({
            entry: limit(0, false, "99000", "0.01"),
          }),
        ),
      "the other side",
    ],
    [
      "another leverage than asked",
      () => check("request_order", BTC_LONG, btcLong({ leverage: 20 })),
      "not the 5x isolated you asked",
    ],
    [
      "an order on another market",
      () =>
        check("request_order", BTC_LONG, [
          orderStep([limit(1, true, "3000", "0.3")], "ETH"),
        ]),
      "which isn't BTC",
    ],
    [
      "a take-profit at another price",
      () =>
        check(
          "request_order",
          BTC_LONG,
          btcLong({
            legs: [trigger(false, "101000", "tp")],
          }),
        ),
      "triggers at 101000",
    ],
    [
      "a stop-loss nobody asked for",
      () =>
        check(
          "request_order",
          BTC_LONG,
          btcLong({
            legs: [trigger(false, "99000", "sl")],
          }),
        ),
      "you didn't ask for",
    ],
    [
      "cancels with an order that sets no legs",
      () =>
        check(
          "request_order",
          { ...BTC_LONG, take_profit_price: undefined },
          btcLong({ legs: [] }),
        ),
      "cancels orders you didn't ask to",
    ],
    [
      "a close that isn't reduce-only",
      () =>
        check("request_close_position", { market: "BTC" }, [
          orderStep([limit(0, true, "101000", "0.01")], "BTC"),
        ]),
      "isn't reduce-only",
    ],
    [
      "a close of more than the share asked",
      () =>
        check("request_close_position", { market: "BTC", percent: 50 }, [
          orderStep([limit(0, true, "101000", "0.01", true)], "BTC"),
        ]),
      "more than 50%",
    ],
    [
      "a cancel of another order",
      () =>
        check("request_cancel_order", { market: "BTC", order_id: 77 }, [
          step({ method: "cancel", params: { cancels: [{ a: 0, o: 78 }] } }),
        ]),
      "not 77",
    ],
    [
      "a cancel that moves an order",
      () =>
        check("request_cancel_order", { market: "BTC", order_id: 77 }, [
          step({
            method: "modify",
            params: { oid: 77, order: limit(0, true, "99000") },
            market: "BTC",
          }),
        ]),
      "doesn't modify",
    ],
    [
      "a move that flips the order's side",
      () =>
        check(
          "request_modify_order",
          { market: "BTC", order_id: 88, price: 101000 },
          [
            step({
              method: "modify",
              params: { oid: 88, order: limit(0, false, "101000", "0.002") },
              market: "BTC",
            }),
          ],
        ),
      "side or kind",
    ],
    [
      "a move that grows the order",
      () =>
        check(
          "request_modify_order",
          { market: "BTC", order_id: 88, price: 98000 },
          [
            step({
              method: "modify",
              params: { oid: 88, order: limit(0, true, "98000", "1") },
              market: "BTC",
            }),
          ],
        ),
      "bigger than you asked",
    ],
    [
      "a leverage change that moves margin",
      () =>
        check(
          "request_set_leverage",
          { market: "ETH", leverage: 3, margin_mode: "cross" },
          [
            step({
              method: "updateIsolatedMargin",
              params: { asset: 1, isBuy: true, ntli: 1 },
            }),
          ],
        ),
      "doesn't updateIsolatedMargin",
    ],
    [
      "margin added where it was asked out",
      () =>
        check("request_adjust_margin", { market: "BTC", amount_usd: -25 }, [
          step({
            method: "updateIsolatedMargin",
            params: { asset: 0, isBuy: false, ntli: 25_000_000 },
          }),
        ]),
      "not $-25",
    ],
    [
      "a spot sell where a buy was asked",
      () =>
        check(
          "request_spot_order",
          { market: "PURR", side: "buy", size_usd: 20 },
          [orderStep([limit(10_000, false, "0.19", "95")], "PURR/USDC")],
        ),
      "the other side",
    ],
    [
      "another outcome than asked",
      () =>
        check(
          "request_prediction_order",
          { outcome_id: 10, side: "yes", action: "buy", size_usd: 10 },
          [orderStep([limit(100_000_090, true, "0.42", "20")])],
        ),
      "not outcome 10 yes",
    ],
    [
      "more moved into the vault than asked",
      () =>
        check(
          "request_vault_transfer",
          { vault_address: HLP, direction: "deposit", amount_usd: 100 },
          [
            step({
              method: "vaultTransfer",
              params: { vaultAddress: HLP, isDeposit: true, usd: 200_000_000 },
            }),
          ],
        ),
      "not $100",
    ],
  ])("refuses %s", async (_, checked, message) => {
    await expect(checked()).rejects.toThrow(message);
  });
});

describe("fields the server fills in", () => {
  test("leaves what a call left out to the server, but not leverage or TP/SL", () => {
    const asked = askedRequest("request_order", {
      market: "BTC",
      side: "long",
      size_usd: 100,
    }) as AskedRequest;
    expect(asked.params).toMatchObject({
      orderType: undefined,
      reduceOnly: undefined,
      slippagePct: undefined,
      leverage: 1,
      takeProfitPrice: undefined,
    });
  });
});
