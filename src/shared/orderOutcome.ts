// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
import {
  ApiRequestError,
  HttpRequestError,
  type InfoClient,
  type OrderParameters,
  type OrderStatusResponse,
  type OrderSuccessResponse,
  TransportError,
  type UserFillsResponse,
} from "@nktkas/hyperliquid";
import type { Cloid } from "./types";

type WireOrder = OrderParameters["orders"][number];
type OrderStatus =
  | OrderSuccessResponse["response"]["data"]["statuses"][number]
  | { error: string };
type FoundOrder = Extract<OrderStatusResponse, { status: "order" }>["order"];

type HlEndpoint = "info" | "exchange" | "explorer";

/**
 * The request failed before it left the device, so HL can't have seen it: a
 * transport throws this, never HttpRequestError, which reads as a lost answer.
 */
export class RequestNotSentError extends TransportError {
  readonly code = "REQUEST_NOT_SENT";

  constructor(endpoint: HlEndpoint, options: ErrorOptions) {
    super(`hl-${endpoint} request was never sent`, options);
    this.name = "RequestNotSentError";
  }
}

const isUnreadableSuccess = (response: Response) =>
  response.ok &&
  !response.headers.get("Content-Type")?.includes("application/json");

/**
 * A request HL may have acted on without its answer reaching us: the fetch
 * threw (timeout, abort, a lost native settle, a dropped connection), a
 * gateway answered 5xx, 408 or 499, which can come after it forwarded the
 * request, or a 2xx came back that isn't HL's JSON. HL's own refusals arrive
 * as an answer and aren't this
 */
export const isExchangeAnswerLost = (error: unknown): boolean =>
  error instanceof HttpRequestError &&
  (error.response === undefined ||
    isUnreadableSuccess(error.response) ||
    error.response.status >= 500 ||
    error.response.status === 408 ||
    error.response.status === 499);

/** Sent, answer lost, and HL didn't show the outcome before the poll gave up */
export class OrderOutcomeUnconfirmedError extends Error {
  readonly code = "ORDER_OUTCOME_UNCONFIRMED";

  /**
   * @param outcomeKnown settles once the package stops reading the outcome
   * back; absent, `whenOutcomeKnown` waits the read-back window
   */
  constructor(
    readonly cloids: readonly Cloid[],
    readonly outcomeKnown?: Promise<void>,
    options?: ErrorOptions,
  ) {
    super(
      "Hyperliquid's answer was lost and the outcome isn't confirmed yet",
      options,
    );
    this.name = "OrderOutcomeUnconfirmedError";
  }
}

/** The read-back window closed without HL answering its last lookups */
class LookupsUnansweredError extends OrderOutcomeUnconfirmedError {}

export const isOrderOutcomeUnconfirmed = (
  error: unknown,
): error is OrderOutcomeUnconfirmedError =>
  error instanceof OrderOutcomeUnconfirmedError;

/** The action may have gone through: never resend it, and don't call it failed */
export const isOutcomeUnknown = (error: unknown): boolean =>
  isOrderOutcomeUnconfirmed(error) || isExchangeAnswerLost(error);

/**
 * Settles when it's safe to send the same action again: at once after a
 * known outcome, when the read-back settles for an unconfirmed order, and
 * after the read-back window for a lost answer with nothing to read back.
 */
export const whenOutcomeKnown = (
  error: unknown,
  polling: OrderOutcomePolling = ORDER_OUTCOME_POLLING,
): Promise<void> => {
  if (isOrderOutcomeUnconfirmed(error) && error.outcomeKnown) {
    return error.outcomeKnown;
  }
  if (isOutcomeUnknown(error)) return polling.sleep(polling.unconfirmedHoldMs);
  return Promise.resolve();
};

/** Actions with nothing to look up by: a lost answer is only reported */
export const unconfirmedIfAnswerLost = (error: unknown): never => {
  throw isExchangeAnswerLost(error)
    ? new OrderOutcomeUnconfirmedError([], undefined, { cause: error })
    : error;
};

/**
 * - `rateLimited`: the whole request was turned away for its rate; nothing ran
 * - `refused`: the whole action was refused; nothing ran
 * - `ordersRejected`: some orders were rejected, others in the batch may have filled
 */
export type ExchangeRefusalCode = "rateLimited" | "refused" | "ordersRejected";

const RATE_LIMIT_TEXT = /too many|rate limit/i;

const refusalCodeOf = (response: unknown): ExchangeRefusalCode => {
  const answer = response as {
    status?: unknown;
    response?: unknown;
  } | null;
  if (answer?.status === "err") {
    return RATE_LIMIT_TEXT.test(String(answer.response))
      ? "rateLimited"
      : "refused";
  }
  const statuses = (answer?.response as { data?: { statuses?: unknown } })?.data
    ?.statuses;
  return Array.isArray(statuses) ? "ordersRejected" : "refused";
};

/** HL answered and turned the action down, whole or in part */
export class ExchangeRefusal extends ApiRequestError {
  readonly code: ExchangeRefusalCode;

  constructor(response: unknown, options?: ErrorOptions) {
    super(response);
    this.name = "ExchangeRefusal";
    this.code = refusalCodeOf(response);
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/** Rethrows the SDK's ApiRequestError as an ExchangeRefusal, the rest as is */
export const asExchangeRefusal = (error: unknown): never => {
  if (error instanceof ApiRequestError && !(error instanceof ExchangeRefusal)) {
    throw new ExchangeRefusal(error.response, { cause: error });
  }
  throw error;
};

/** Turned away for its rate before anything ran, so the same request may go again */
export const isRateLimitRefusal = (error: unknown): boolean =>
  (error instanceof ExchangeRefusal && error.code === "rateLimited") ||
  (error instanceof HttpRequestError && error.response?.status === 429);

export const randomHex = (hexDigitCount: number): string => {
  let hex = "";
  while (hex.length < hexDigitCount) {
    hex += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, "0");
  }
  return hex.slice(0, hexDigitCount);
};

const CLOID_HEX_DIGITS = 32;

const randomCloid = (): Cloid => `0x${randomHex(CLOID_HEX_DIGITS)}`;

/** Every order leaves with a cloid, so a lost answer can be looked up */
export const withCloids = (orders: readonly WireOrder[]): WireOrder[] =>
  orders.map((order) => (order.c ? order : { ...order, c: randomCloid() }));

const filledSizeOf = ({ order }: FoundOrder) =>
  Math.max(Number(order.origSz) - Number(order.sz), 0);

const averageFillPrice = (oid: number, fills: UserFillsResponse) => {
  let size = 0;
  let notional = 0;
  for (const fill of fills) {
    if (fill.oid !== oid) continue;
    size += Number(fill.sz);
    notional += Number(fill.sz) * Number(fill.px);
  }
  return size > 0 ? String(notional / size) : null;
};

/**
 * One order's outcome in a place answer. A fill's `avgPx` is undefined when
 * HL measured none: a fill read back before its fills were indexed.
 */
export type PlaceOutcome =
  | {
      kind: "filled";
      oid: number;
      cloid?: Cloid;
      totalSz: string;
      avgPx: string | undefined;
    }
  | { kind: "resting"; oid?: number; cloid?: Cloid }
  | { kind: "refused"; error: string };

type FilledStatus = {
  totalSz: string;
  avgPx: string;
  oid: number;
  cloid?: Cloid;
  avgPxIsLimit?: boolean;
};

const placeOutcomeOf = (status: unknown): PlaceOutcome => {
  if (typeof status === "object" && status !== null) {
    if ("error" in status) {
      return { kind: "refused", error: String(status.error) };
    }
    if ("filled" in status) {
      const { totalSz, avgPx, oid, cloid, avgPxIsLimit } =
        status.filled as FilledStatus;
      return {
        kind: "filled",
        oid,
        cloid,
        totalSz,
        avgPx: avgPxIsLimit ? undefined : avgPx,
      };
    }
    if ("resting" in status) {
      const { oid, cloid } = status.resting as { oid: number; cloid?: Cloid };
      return { kind: "resting", oid, cloid };
    }
  }
  // waitingForFill, waitingForTrigger, or a shape HL doesn't document: on
  // the book as far as anyone can tell, never a fill or a refusal
  return { kind: "resting" };
};

/** One outcome per order, in the order sent, from a place answer or the response an ExchangeRefusal carries */
export const readPlaceStatuses = (response: unknown): PlaceOutcome[] => {
  const statuses = (
    response as { response?: { data?: { statuses?: unknown } } } | undefined
  )?.response?.data?.statuses;
  return Array.isArray(statuses) ? statuses.map(placeOutcomeOf) : [];
};

// orderStatus reports a refusal by status name; the place answer carries
// these texts, which the app's error handling matches on
// (docs: for-developers/api/error-responses)
const PLACEMENT_ERROR_OF_STATUS: Partial<Record<string, string>> = {
  tickRejected: "Price must be divisible by tick size.",
  minTradeNtlRejected: "Order must have minimum value of $10.",
  perpMarginRejected: "Insufficient margin to place order.",
  marginCanceled: "Insufficient margin to place order.",
  reduceOnlyRejected: "Reduce only order would increase position.",
  badAloPxRejected: "Post only order would have immediately matched.",
  iocCancelRejected:
    "Order could not immediately match against any resting orders.",
  badTriggerPxRejected: "Invalid TP/SL price.",
  marketOrderNoLiquidityRejected: "No liquidity available for market order.",
  positionIncreaseAtOpenInterestCapRejected:
    "Order would increase open interest while open interest is capped",
  positionFlipAtOpenInterestCapRejected:
    "Order would increase open interest while open interest is capped",
  tooAggressiveAtOpenInterestCapRejected:
    "Order rejected due to price more aggressive than oracle while at open interest cap",
  openInterestIncreaseRejected:
    "Order would increase open interest too quickly",
  insufficientSpotBalanceRejected:
    "Order has insufficient spot balance to trade",
  oracleRejected: "Order price too far from oracle",
  perpMaxPositionRejected:
    "Order would cause position to exceed margin tier limit at current leverage",
};

// what HL would have answered for the order, read back from its status
const toPlacedStatus = (
  found: FoundOrder,
  cloid: Cloid,
  fills: UserFillsResponse,
): OrderStatus => {
  const { oid, limitPx, isTrigger } = found.order;
  // an order still on the book answers `resting` even after a partial fill;
  // `filled` would announce the partial size as the whole order
  if (found.status === "open" || found.status === "triggered") {
    return isTrigger ? "waitingForTrigger" : { resting: { oid, cloid } };
  }
  const filledSize = filledSizeOf(found);
  if (filledSize > 0) {
    const fillPrice = averageFillPrice(oid, fills);
    return {
      filled: {
        totalSz: String(filledSize),
        avgPx: fillPrice ?? limitPx,
        oid,
        cloid,
        ...(fillPrice === null && { avgPxIsLimit: true }),
      },
    };
  }
  return {
    error: PLACEMENT_ERROR_OF_STATUS[found.status] ?? `Order ${found.status}`,
  };
};

export type OrderOutcomePolling = {
  pollIntervalMs: number;
  windowMs: number;
  /** how long an unconfirmed batch keeps being read back, refusing new orders on its assets */
  unconfirmedHoldMs: number;
  sleep: (ms: number) => Promise<void>;
};

export const ORDER_OUTCOME_POLLING: OrderOutcomePolling = {
  pollIntervalMs: 1_000,
  windowMs: 15_000,
  unconfirmedHoldMs: 15_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// a read still out at the deadline counts as not found, so a hung request
// can't stretch the window
const readBefore = async <Answer>(
  deadlineAt: number,
  read: (signal: AbortSignal) => Promise<Answer>,
): Promise<Answer | undefined> => {
  const controller = new AbortController();
  let reachDeadline = (_value: undefined) => {};
  const deadline = new Promise<undefined>((resolve) => {
    reachDeadline = resolve;
  });
  const timer = setTimeout(
    () => reachDeadline(undefined),
    Math.max(deadlineAt - Date.now(), 0),
  );
  try {
    return await Promise.race([
      read(controller.signal).catch(() => undefined),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

/**
 * Reads a batch whose answer was lost back from HL by cloid, as the statuses
 * the answer would have carried. Throws OrderOutcomeUnconfirmedError when an
 * order still isn't known once the window closes; never sends anything.
 */
const readBackLostOrders = async (
  info: InfoClient,
  user: `0x${string}`,
  cloids: readonly Cloid[],
  polling: OrderOutcomePolling = ORDER_OUTCOME_POLLING,
): Promise<OrderStatus[]> => {
  const giveUpAt = Date.now() + polling.windowMs;
  const found = new Map<Cloid, FoundOrder>();
  while (found.size < cloids.length) {
    let everyLookupAnswered = true;
    for (const cloid of cloids) {
      if (found.has(cloid)) continue;
      const status = await readBefore(giveUpAt, (signal) =>
        info.orderStatus({ user, oid: cloid }, signal),
      );
      if (status === undefined) everyLookupAnswered = false;
      if (status?.status === "order") found.set(cloid, status.order);
    }
    if (found.size === cloids.length) break;
    if (Date.now() >= giveUpAt) {
      throw everyLookupAnswered
        ? new OrderOutcomeUnconfirmedError(cloids)
        : new LookupsUnansweredError(cloids);
    }
    await polling.sleep(polling.pollIntervalMs);
  }
  const hasFills = Array.from(found.values()).some(
    (order) => filledSizeOf(order) > 0,
  );
  const fills = hasFills
    ? await info
        .userFills({ user })
        .then((answer) => (Array.isArray(answer) ? answer : []))
        .catch(() => [] as UserFillsResponse)
    : [];
  return cloids.map((cloid) => toPlacedStatus(found.get(cloid)!, cloid, fills));
};

type UnconfirmedBatch = {
  userKey: string;
  assets: readonly string[];
  cloids: readonly Cloid[];
  /** settles when the batch stops being read back */
  outcomeKnown: Promise<void>;
};

const unconfirmedBatches: UnconfirmedBatch[] = [];

const userKeyOf = (user: `0x${string}` | undefined) =>
  user?.toLowerCase() ?? "";

const assetKeyOf = (order: WireOrder) => String(order.a);

const unconfirmedBatchOverlapping = (
  user: `0x${string}` | undefined,
  orders: readonly WireOrder[],
) => {
  const userKey = userKeyOf(user);
  // a duplicate reduce-only order can only close, so closes still go out
  return unconfirmedBatches.find(
    (batch) =>
      batch.userKey === userKey &&
      orders.some(
        (order) => !order.r && batch.assets.includes(assetKeyOf(order)),
      ),
  );
};

// A window of failed lookups says nothing about the order, so only an answer
// from HL ends this: elapsed time must not free a second send.
const readBackUntilAnswered = async (
  info: InfoClient,
  user: `0x${string}`,
  cloids: readonly Cloid[],
  polling: OrderOutcomePolling,
): Promise<void> => {
  let isAnswered = false;
  while (!isAnswered) {
    isAnswered = await readBackLostOrders(info, user, cloids, {
      ...polling,
      windowMs: polling.unconfirmedHoldMs,
    }).then(
      () => true,
      (error: unknown) => !(error instanceof LookupsUnansweredError),
    );
    if (!isAnswered) await polling.sleep(polling.pollIntervalMs);
  }
};

// Nothing identifies these actions to look up, and the window can pass with
// the device offline, leaving an account view from before the action: the
// hold ends once HL answers a read made after the action had time to land.
const whenAccountReadable = async (
  info: InfoClient,
  user: `0x${string}` | undefined,
  polling: OrderOutcomePolling,
): Promise<void> => {
  await polling.sleep(polling.unconfirmedHoldMs);
  if (!user) return;
  let isAnswered = false;
  while (!isAnswered) {
    const answer = await readBefore(Date.now() + polling.windowMs, (signal) =>
      info.clearinghouseState({ user }, signal),
    );
    isAnswered = answer !== undefined;
    if (!isAnswered) await polling.sleep(polling.pollIntervalMs);
  }
};

/** A lost answer on an action with no cloid, held until HL answers a fresh read */
export const unconfirmedUntilAccountReadable =
  (
    info: InfoClient,
    user: `0x${string}` | undefined,
    polling: OrderOutcomePolling = ORDER_OUTCOME_POLLING,
  ) =>
  (error: unknown): never => {
    throw isExchangeAnswerLost(error)
      ? new OrderOutcomeUnconfirmedError(
          [],
          whenAccountReadable(info, user, polling),
          { cause: error },
        )
      : error;
  };

// keeps reading the batch back after the caller gave up, so a re-tap of the
// same order can't go out while the first may still be on HL
const holdUnconfirmedBatch = (
  info: InfoClient,
  user: `0x${string}` | undefined,
  orders: readonly WireOrder[],
  cloids: readonly Cloid[],
  polling: OrderOutcomePolling,
  heldByCaller: boolean,
): Promise<void> => {
  const watch: Promise<unknown> = user
    ? readBackUntilAnswered(info, user, cloids, polling)
    : polling.sleep(polling.unconfirmedHoldMs);
  const batch: UnconfirmedBatch = {
    userKey: userKeyOf(user),
    assets: heldByCaller ? [] : orders.map(assetKeyOf),
    cloids,
    outcomeKnown: watch.then(
      () => undefined,
      () => undefined,
    ),
  };
  unconfirmedBatches.push(batch);
  void batch.outcomeKnown.then(() => {
    unconfirmedBatches.splice(unconfirmedBatches.indexOf(batch), 1);
  });
  return batch.outcomeKnown;
};

/**
 * Places `params.orders` (each given a cloid if it has none). An answer lost
 * on the way back is read back by cloid instead of retried, and settles like
 * HL's answer would have: a response, an ExchangeRefusal carrying the
 * statuses when one was rejected, or OrderOutcomeUnconfirmedError whose
 * `outcomeKnown` settles when the read-back does. While a batch on the same
 * asset is still unconfirmed, nothing is sent and the order fails with that
 * batch's OrderOutcomeUnconfirmedError.
 *
 * `heldByCaller` batches neither wait on an unconfirmed batch nor make others
 * wait: another trade's swap leg shares the stable pair without being the
 * same send, so the caller's own hold is what stops this one going out twice.
 */
export const placeOrdersReadingBackLost = async (
  send: (params: OrderParameters) => Promise<OrderSuccessResponse>,
  info: InfoClient,
  user: `0x${string}` | undefined,
  params: OrderParameters,
  polling: OrderOutcomePolling = ORDER_OUTCOME_POLLING,
  { heldByCaller = false }: { heldByCaller?: boolean } = {},
): Promise<OrderSuccessResponse> => {
  const pending = heldByCaller
    ? undefined
    : unconfirmedBatchOverlapping(user, params.orders);
  if (pending) {
    throw new OrderOutcomeUnconfirmedError(
      pending.cloids,
      pending.outcomeKnown,
    );
  }
  const orders = withCloids(params.orders);
  try {
    return await send({ ...params, orders });
  } catch (error) {
    if (!isExchangeAnswerLost(error)) throw error;
    const cloids = orders.map((order) => order.c as Cloid);
    const unconfirmed = () =>
      new OrderOutcomeUnconfirmedError(
        cloids,
        holdUnconfirmedBatch(info, user, orders, cloids, polling, heldByCaller),
        { cause: error },
      );
    if (!user) throw unconfirmed();
    const statuses = await readBackLostOrders(
      info,
      user,
      cloids,
      polling,
    ).catch((readBackError: unknown) => {
      throw isOrderOutcomeUnconfirmed(readBackError)
        ? unconfirmed()
        : readBackError;
    });
    const response = {
      status: "ok" as const,
      response: { type: "order" as const, data: { statuses } },
    };
    if (
      statuses.some((status) => typeof status === "object" && "error" in status)
    ) {
      throw new ExchangeRefusal(response);
    }
    return response as OrderSuccessResponse;
  }
};
