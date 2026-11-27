// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
/**
 * The named API wallet an AI connection's own key trades under. An account
 * has 3 named slots and the apps use others ("Dreamcash web", "Dreamcash
 * (<env>)"); approving another key under this name replaces the previous one.
 */
export const AI_AGENT_NAME = "Dreamcash AI";

/**
 * How an AI connected to Dreamcash replies, in every instruction it reads:
 * the API's MCP instructions, the Dreamcash MCP package's and the guide.
 */
export const AI_REPLY_STYLE =
  "How to reply: lead with the answer in a line or two, in the user's own words, and add detail only when asked. No tables or extra sections for a simple question. Never show tool or field names, and skip exchange mechanics the user didn't ask about. Say once in a chat, not in each reply, that what you suggest is your own analysis, not advice from Dreamcash. A liquidation price over 90% away means the position practically can't be liquidated: say that, not the number.";

/** The longest name a paired AI client may show the user on the pairing page */
export const AI_CLIENT_NAME_MAX_LENGTH = 60;

/**
 * Whether an AI connection's own key may trade without asking: the switch
 * for all of it. Off, every trade an AI asks for waits for the user to
 * confirm it, and no connection can choose otherwise.
 */
export const AUTONOMOUS_TRADING_ENABLED: boolean = true;

/** How long an approved AI key trades unless the user picks otherwise */
export const AI_AGENT_KEY_VALID_DAYS = 30;

/** The longest Hyperliquid lets an API wallet live */
export const AI_AGENT_KEY_MAX_DAYS = 180;

/** How long a trade request waits for the user or the agent's key */
export const TRADE_REQUEST_TTL_MS = 15 * 60 * 1000;

/** How old a reviewed plan may be when the user confirms it */
export const REVIEWED_PLAN_MAX_AGE_MS = 30_000;

export const TRADE_REQUEST_STATUSES = [
  "PENDING",
  "CLAIMED",
  "EXECUTED",
  "FAILED",
  "UNKNOWN",
  "DECLINED",
  "EXPIRED",
] as const;
export type TradeRequestStatus = (typeof TRADE_REQUEST_STATUSES)[number];

/** HL's agentName with the key's expiry, as approveAgent takes it */
export const aiAgentNameUntil = (validUntilMs: number) =>
  `${AI_AGENT_NAME} valid_until ${validUntilMs}`;

/** How far an agent-signed API call's timestamp may be from the server's clock */
export const AI_AGENT_REQUEST_MAX_SKEW_MS = 60_000;

export const AI_AGENT_SIGNATURE_HEADER = "x-dreamcash-agent-signature";
export const AI_AGENT_TIMESTAMP_HEADER = "x-dreamcash-agent-timestamp";

/**
 * What an AI client's key signs (EIP-191) to call the API: one method, path,
 * moment and body (sha256 hex of its exact bytes, of "" without one).
 */
export const aiAgentRequestMessage = ({
  method,
  path,
  timestampMs,
  bodySha256,
}: {
  method: string;
  path: string;
  timestampMs: number;
  bodySha256: string;
}) =>
  `Dreamcash agent ${method.toUpperCase()} ${path} ${timestampMs} ${bodySha256}`;

/** The Dreamcash MCP package's version, on every call it signs */
export const DREAMCASH_MCP_VERSION_HEADER = "x-dreamcash-mcp-version";
