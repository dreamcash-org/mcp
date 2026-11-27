import { executeTradePlan } from "./shared/tradeRequest";
import type { AgentApi, AgentTradeRequest } from "./agentApi";
import {
  type AskedRequest,
  checkAgentRequest,
  UnsafePlanError,
} from "./agentSafety";
import { messageOf, sleep as defaultSleep } from "./util";

type Info = Parameters<typeof checkAgentRequest>[0]["info"];
type Exchange = Parameters<typeof executeTradePlan>[1];

const OUTCOME_WAIT_MS = 25_000;
const OUTCOME_POLL_MS = 1_500;

/** The request approves the key itself: only the user signs that, at its confirm_url */
export class KeyApprovalRequest extends Error {}

export type ExecutedTradeRequest = {
  request: AgentTradeRequest;
  /** why your MCP signed nothing; the request is reported never sent */
  refused?: string;
  /** a step after the request's own action that didn't go through (TP/SL, replaced legs) */
  followUpProblem?: string;
};

/**
 * Carries out the trade request the agent's own call made, with its key:
 * claims it (the API builds the plan from prices now, within the user's
 * limits, and lets one claim through), checks the request and plan are what
 * the call asked for, signs and sends it once, then waits for the outcome
 * Hyperliquid shows.
 */
export const executeTradeRequest = async ({
  id,
  asked,
  agentAddress,
  api,
  info,
  exchange,
  sleep = defaultSleep,
}: {
  id: string;
  asked: AskedRequest;
  agentAddress: `0x${string}`;
  api: AgentApi;
  info: Info;
  exchange: Exchange;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<ExecutedTradeRequest> => {
  const request = await api.get(id);
  if (request.status !== "PENDING") return { request };
  if (request.kind === "APPROVE_AGENT") throw new KeyApprovalRequest();
  const claimed = await api.claim(id);
  const refused = await checkAgentRequest({
    claimed,
    asked,
    agentAddress,
    info,
  }).then(
    () => undefined,
    (error: unknown) =>
      error instanceof UnsafePlanError
        ? `refused by your Dreamcash MCP: ${error.message}`
        : `your Dreamcash MCP couldn't check it against Hyperliquid: ${messageOf(error)}`,
  );
  if (refused) {
    // nothing was signed
    await api.notSent(id, refused).catch(() => undefined);
    return { request: await api.get(id).catch(() => claimed), refused };
  }

  // from here something may reach Hyperliquid: only its own refusal says
  // otherwise, so an unexpected error is an unknown outcome
  const execution = await executeTradePlan(claimed.plan, exchange, {
    expiresAfter: claimed.expiresAfter,
  }).catch((error: unknown) => ({
    kind: "sent" as const,
    accepted: false,
    followUpProblem: `outcome unknown: ${messageOf(error)}`,
  }));
  let followUpProblem: string | undefined;
  if (execution.kind === "notSent") {
    // unreported, the API fails it on its own once the signed deadline passed
    await api.notSent(id, execution.reason).catch(() => undefined);
  } else {
    followUpProblem = execution.followUpProblem;
    // settles an action with nothing to read back (a margin change)
    if (execution.accepted) await api.sent(id).catch(() => undefined);
  }

  // a read that fails leaves it claimed: the agent reads it again later
  const deadline = Date.now() + OUTCOME_WAIT_MS;
  let current: AgentTradeRequest = claimed;
  while (current.status === "CLAIMED" && Date.now() < deadline) {
    await sleep(OUTCOME_POLL_MS);
    const read = await api.get(id).catch(() => undefined);
    if (!read) break;
    current = read;
  }
  return { request: current, followUpProblem };
};
