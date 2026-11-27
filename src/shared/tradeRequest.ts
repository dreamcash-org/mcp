// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
import { aiAgentNameUntil } from "./constants";
import {
  type ExchangeMethod,
  type PlanStep,
  type TradePlan,
  type TradeRequestToSign,
  USER_SIGNED_METHODS,
} from "./hyperliquidOrders";
import {
  isExchangeAnswerLost,
  readPlaceStatuses,
} from "./orderOutcome";
import {
  ApiRequestError,
  ExchangeClient,
  HttpRequestError,
  HttpTransport,
  InfoClient,
} from "@nktkas/hyperliquid";
import {
  type AbstractWallet,
  AbstractWalletError,
} from "@nktkas/hyperliquid/signing";
import { hashKey } from "@tanstack/query-core";

export type {
  PlanStep,
  TradePlan,
  TradeRequestCloids,
  TradeRequestToSign,
} from "./hyperliquidOrders";

// A trade request's plan comes from the API, built from fresh prices when it
// is claimed; a signer only signs and sends its steps, in order.

type StepExchange = Pick<ExchangeClient, ExchangeMethod>;

/**
 * - `notSent`: the request's own action provably never took effect, so it
 *   may fail at once
 * - `sent`: it may have; its outcome is read back by its cloid. `accepted`:
 *   Hyperliquid answered the main step with success, which is the only
 *   outcome of an action with nothing to read back (a margin change)
 * - `followUpProblem` is a step after it that didn't go through
 */
export type PlanExecution =
  | { kind: "notSent"; reason: string }
  | { kind: "sent"; accepted: boolean; followUpProblem?: string };

// Why an action provably did nothing: HL answered and refused it, or it was
// never signed. Undefined when it may have gone through.
const refusalOf = (error: unknown): string | undefined => {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof AbstractWalletError) return "the wallet didn't sign";
  if (error instanceof HttpRequestError && !isExchangeAnswerLost(error)) {
    return error.message;
  }
  return undefined;
};

const MAYBE_SENT = "Hyperliquid's answer was lost";

const filledAnything = (response: unknown) =>
  readPlaceStatuses(response).some(
    (status) => status.kind === "filled" && Number(status.totalSz) > 0,
  );

// L1 actions carry the claim's deadline; actions the user's own wallet signs
// take none.
const sendStep = (
  exchange: StepExchange,
  step: PlanStep,
  expiresAfter: number,
): Promise<unknown> => {
  const options = USER_SIGNED_METHODS.includes(step.method)
    ? {}
    : { expiresAfter };
  const send = exchange[step.method] as (
    params: unknown,
    options: object,
  ) => Promise<unknown>;
  return send.call(exchange, step.params, options);
};

/**
 * Sends a plan's steps in order, each once, and stops at the first that
 * doesn't go through. A follow-up that needs a fill waits for the main
 * order to have filled something.
 */
export const executeTradePlan = async (
  plan: TradePlan,
  exchange: StepExchange,
  { expiresAfter }: { expiresAfter: number },
): Promise<PlanExecution> => {
  let mainResponse: { answer: unknown } | undefined;
  for (const step of plan.steps) {
    if (
      step.role === "follow_up" &&
      step.onlyIfMainFilled &&
      !filledAnything(mainResponse?.answer)
    ) {
      return {
        kind: "sent",
        accepted: true,
        followUpProblem: `didn't ${step.purpose}: the order didn't fill`,
      };
    }
    try {
      const answer = await sendStep(exchange, step, expiresAfter);
      if (step.role === "main") mainResponse = { answer };
    } catch (error) {
      const refusal = refusalOf(error);
      if (step.role === "setup") {
        // the request's own action never went out
        return {
          kind: "notSent",
          reason: `couldn't ${step.purpose}: ${refusal ?? MAYBE_SENT}`,
        };
      }
      if (step.role === "follow_up") {
        return {
          kind: "sent",
          accepted: true,
          followUpProblem: `couldn't ${step.purpose}: ${refusal ?? MAYBE_SENT}`,
        };
      }
      if (refusal === undefined) {
        const unsent = plan.steps.filter((later) => later.role === "follow_up");
        return unsent.length === 0
          ? { kind: "sent", accepted: false }
          : {
              kind: "sent",
              accepted: false,
              followUpProblem: `didn't ${unsent.map((later) => later.purpose).join(" or ")}: ${MAYBE_SENT}, so the order's outcome is unknown`,
            };
      }
      // a batch HL answered with some orders placed went through in part
      const statuses = readPlaceStatuses((error as ApiRequestError).response);
      const placedAny = statuses.some((status) => status.kind !== "refused");
      return placedAny
        ? { kind: "sent", accepted: false, followUpProblem: refusal }
        : { kind: "notSent", reason: refusal };
    }
  }
  return mainResponse
    ? { kind: "sent", accepted: true }
    : { kind: "notSent", reason: "the plan had nothing to send" };
};

/**
 * Whether two plans are the same calls, whatever order their keys are in:
 * Postgres jsonb reorders them. hashKey sorts object keys before serializing.
 */
export const samePlan = (a: TradePlan, b: TradePlan): boolean =>
  hashKey([a]) === hashKey([b]);

/** Mainnet clients for a page or agent that signs trade requests */
export const createTradeRequestClients = () => {
  const transport = new HttpTransport();
  return {
    info: new InfoClient({ transport }),
    exchangeSignedBy: (wallet: AbstractWallet) =>
      new ExchangeClient({ transport, wallet }),
  };
};

const MICRO_USD = 1_000_000;

/** A price or amount exactly as the wallet signs it, never rounded to cents */
export const signedUsd = (decimal: string) => {
  const [whole, fraction] = decimal.split(".");
  return `$${Number(whole).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
};

/** HL's micro-USD integers (margin, vault transfers), unsigned */
export const signedMicroUsd = (microUsd: number) =>
  signedUsd(String(Math.abs(microUsd) / MICRO_USD));

export type SignRefusal =
  | { reason: "foreign_withdrawal"; destination: string }
  | { reason: "unasked_key" };

/**
 * Why a reviewer won't sign a plan, checked before it claims and again on the
 * plan it claimed: a withdrawal leaves only for one of the user's own
 * wallets, and the key a user approves is the one they were asked about.
 */
export const refusalToSign = (
  plan: TradePlan,
  request: TradeRequestToSign,
  ownWallets: readonly string[],
): SignRefusal | undefined => {
  const own = new Set(ownWallets.map((wallet) => wallet.toLowerCase()));
  for (const step of plan.steps) {
    if (
      step.method === "withdraw3" &&
      !own.has(step.params.destination.toLowerCase())
    ) {
      return {
        reason: "foreign_withdrawal",
        destination: step.params.destination,
      };
    }
    if (
      step.method === "approveAgent" &&
      (request.kind !== "APPROVE_AGENT" ||
        step.params.agentAddress.toLowerCase() !==
          request.params.agentAddress.toLowerCase() ||
        step.params.agentName !== aiAgentNameUntil(request.params.validUntil))
    ) {
      return { reason: "unasked_key" };
    }
  }
  return undefined;
};
