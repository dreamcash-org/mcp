import { AI_CLIENT_NAME_MAX_LENGTH } from "./shared/constants";
import type {
  TradePlan,
  TradeRequestCloids,
  TradeRequestToSign,
} from "./shared/tradeRequest";
import type { LocalAccount } from "viem";
import { signedFetch } from "./signedFetch";

export type TradeRequestStatus =
  | "PENDING"
  | "CLAIMED"
  | "EXECUTED"
  | "FAILED"
  | "DECLINED"
  | "EXPIRED"
  | "UNKNOWN";

export type AgentTradeRequest = TradeRequestToSign & {
  id: string;
  status: TradeRequestStatus;
  market: string;
  walletAddress: `0x${string}`;
  cloids: TradeRequestCloids;
  plan: TradePlan | null;
  result: {
    orderId: number | null;
    executedSize: number | null;
    averagePrice: number | null;
    detail: string | null;
  } | null;
};

/** What an agent should do about a failure, in the shape Dreamcash answers it */
export type AgentGuidance = {
  code: string;
  what_happened: string;
  what_to_do: string;
  tell_the_user?: string;
  can_retry: "yes" | "no" | "after_changes" | "after_user_action";
};

/**
 * Dreamcash refused a call; `code` names the case (e.g. "over_daily_limit")
 * and `guidance` is Dreamcash's own advice about it, when it gave some
 */
export class AgentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly guidance?: AgentGuidance,
  ) {
    super(message);
  }
}

const THIS_MACHINE = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The API the key talks to, checked: https, or plain http only on this
 * machine. Over plain http anyone on the way could change what Dreamcash
 * answers, the plans the key signs included.
 */
export const checkedApiUrl = (value: string) => {
  const url = new URL(value);
  const onThisMachine =
    url.protocol === "http:" && THIS_MACHINE.has(url.hostname);
  if (url.protocol !== "https:" && !onThisMachine) {
    throw new Error(
      `DREAMCASH_API_URL must be an https URL (plain http only for localhost), not ${value}`,
    );
  }
  return url.href;
};

/** The Dreamcash API as the agent's key calls it, every call signed */
export const agentApi = (baseUrl: string, account: LocalAccount) => {
  const send = signedFetch(account);
  const call = async <Answer>(
    method: "GET" | "POST",
    path: string,
    body?: object,
  ): Promise<Answer> => {
    const response = await send(new URL(path, baseUrl), {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const answer = (await response.json().catch(() => ({}))) as {
      message?: string;
      code?: string;
      error?: AgentGuidance;
    };
    if (!response.ok) {
      throw new AgentApiError(
        answer.message ?? `Dreamcash answered ${response.status}`,
        response.status,
        answer.code,
        answer.error,
      );
    }
    return answer as Answer;
  };
  const tradeRequest = (id: string, action = "") =>
    `/api/ai-connections/agent/trade-requests/${encodeURIComponent(id)}${action}`;

  return {
    get: (id: string) => call<AgentTradeRequest>("GET", tradeRequest(id)),
    claim: (id: string) =>
      call<AgentTradeRequest & { plan: TradePlan; expiresAfter: number }>(
        "POST",
        tradeRequest(id, "/claim"),
        {},
      ),
    sent: (id: string) =>
      call<{ status: TradeRequestStatus }>(
        "POST",
        tradeRequest(id, "/sent"),
        {},
      ),
    notSent: (id: string, reason: string) =>
      call<{ status: TradeRequestStatus }>(
        "POST",
        tradeRequest(id, "/not-sent"),
        { reason: reason.slice(0, 200) },
      ),
    // the code the user read off their Dreamcash app names the account
    pair: (code: string, clientName: string) =>
      call<{ connectionId: string }>("POST", "/api/ai-agent/links/pair", {
        code,
        clientName: clientName.slice(0, AI_CLIENT_NAME_MAX_LENGTH),
      }),
  };
};

export type AgentApi = ReturnType<typeof agentApi>;
