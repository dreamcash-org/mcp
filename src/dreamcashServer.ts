import {
  AI_REPLY_STYLE,
  DREAMCASH_APP_STORE_URL,
  DREAMCASH_PLAY_STORE_URL,
} from "./shared/constants";
import { createTradeRequestClients } from "./shared/tradeRequest";
import {
  Client,
  ProtocolError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { type CallToolResult, Server } from "@modelcontextprotocol/server";
import type { LocalAccount } from "viem";
import { AgentApiError, type AgentGuidance, agentApi } from "./agentApi";
import {
  adoptPendingKey,
  KeyUnreadable,
  newAgentAccount,
  pendingKeyFile,
  storedAgentAccount,
} from "./agentKey";
import { type AskedRequest, askedRequest } from "./agentSafety";
import { executeTradeRequest, KeyApprovalRequest } from "./executeTradeRequest";
import { signedFetch } from "./signedFetch";
import { messageOf } from "./util";
import { DREAMCASH_MCP_VERSION } from "./version";

const INSTRUCTIONS = `Dreamcash is a Hyperliquid trading app. This server connects you to the user's Dreamcash account. Until you're connected, connect_dreamcash is your only tool: ask the user for the 6-character code their Dreamcash app shows (Settings › Connected AI) and call it with that code. You then get tools to read their account (balances, positions, orders, history, PnL, XP, vaults) and Hyperliquid markets, and to ask for trades, which the user approves in their Dreamcash app, or, if they let you, to trade on your own with your own key, kept on this machine (Dreamcash never sees it). Once connected, call how_to_use_dreamcash first: it explains every tool, what you may do and how to behave.

Anything that fails answers {"error": {code, what_happened, what_to_do, tell_the_user, can_retry}}: do what_to_do, and pass tell_the_user on to the user. Amounts are USD unless stated.

${AI_REPLY_STYLE}`;

const CONNECT_TOOL = {
  name: "connect_dreamcash",
  title: "Connect to Dreamcash",
  description:
    "Connects you to the user's Dreamcash account with the 6-character code their Dreamcash app shows under Settings › Connected AI. Without a code it answers whether you're connected, and if not, what to ask the user. again: true pairs a new key, e.g. after the user disconnected you, which revoked your key at once (on Hyperliquid and at Dreamcash). If a new pairing fails, the package keeps the key it had, which works only while that connection is still on.",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string",
        description:
          'The code the user read off their Dreamcash app, e.g. "K7QM2P".',
      },
      again: {
        type: "boolean",
        description: "Pair a new key.",
      },
      agent_name: {
        type: "string",
        description: 'How the user sees you in their app, e.g. "Grok Bot".',
      },
    },
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
};

const ASK_FOR_THE_CODE = {
  connected: false,
  next_step: `Ask the user for the code: in the Dreamcash app, Settings › Connected AI shows a 6-character code. Then call connect_dreamcash with it. No Dreamcash account yet? They get the app first (iPhone: ${DREAMCASH_APP_STORE_URL}, Android: ${DREAMCASH_PLAY_STORE_URL}) and make one there.`,
};

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  ...(isError && { isError: true }),
});

const failure = (guidance: AgentGuidance) => text({ error: guidance }, true);

class KeyNotSaved extends Error {
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super("the agent key couldn't be saved", { cause });
  }
}

const NOT_CONNECTED: AgentGuidance = {
  code: "not_connected",
  what_happened: "This agent isn't connected to a Dreamcash account.",
  what_to_do:
    "Ask the user for the code their Dreamcash app shows under Settings › Connected AI, then call connect_dreamcash with it.",
  can_retry: "after_user_action",
};

const DISCONNECTED: AgentGuidance = {
  code: "disconnected",
  what_happened:
    "Dreamcash no longer accepts this agent: the user disconnected it, or it was never approved.",
  what_to_do:
    "If the user wants to connect again, ask them for a new code from their Dreamcash app (Settings › Connected AI) and call connect_dreamcash with it and again: true.",
  can_retry: "after_user_action",
};

const USER_APPROVES_KEY: AgentGuidance = {
  code: "user_approves_key",
  what_happened:
    "This request approves your own key to trade, which only the user can sign. Your key signed nothing.",
  what_to_do:
    "The user approves it in their Dreamcash app, which got a push for it: tell them, then call get_trade_request with request_id.",
  can_retry: "after_user_action",
};

const unreachable = (error: unknown): AgentGuidance => ({
  code: "dreamcash_unreachable",
  what_happened: `Couldn't reach Dreamcash: ${messageOf(error)}`,
  what_to_do:
    "Try again in a minute. If it keeps failing, tell the user Dreamcash may be down or this machine may be offline.",
  can_retry: "yes",
});

const keyNotSaved = ({ file, cause }: KeyNotSaved): AgentGuidance => ({
  code: "key_not_saved",
  what_happened: `Couldn't save this agent's key at ${file}: ${messageOf(cause)}`,
  what_to_do: "Tell the user; nothing works until the key can be saved.",
  tell_the_user:
    "Set DREAMCASH_AGENT_KEY_FILE to a file this machine can write, then restart your agent.",
  can_retry: "after_user_action",
});

const keyUnreadable = ({ file, cause }: KeyUnreadable): AgentGuidance => ({
  code: "key_unreadable",
  what_happened: `Couldn't read this agent's key at ${file}: ${messageOf(cause)}`,
  what_to_do:
    "Tell the user; nothing works until the key can be read. Don't pair again: the key the user approved is in that file.",
  tell_the_user: `Make ${file} readable by the user your agent runs as, and check it still holds the key Dreamcash MCP saved there, then restart your agent.`,
  can_retry: "after_user_action",
});

// without an auth provider the client surfaces an HTTP 401 as an error
// carrying the status
const isUnauthorized = (error: unknown) => {
  const { status, data } = (error ?? {}) as {
    status?: number;
    data?: { status?: number };
  };
  return status === 401 || data?.status === 401;
};

/** What the agent should do about a failed call */
const guidanceFor = (error: unknown): AgentGuidance => {
  if (error instanceof KeyNotSaved) return keyNotSaved(error);
  if (error instanceof KeyUnreadable) return keyUnreadable(error);
  if (error instanceof KeyApprovalRequest) return USER_APPROVES_KEY;
  if (error instanceof AgentApiError) {
    return (
      error.guidance ?? {
        code: error.code ?? "dreamcash_refused",
        what_happened: error.message,
        what_to_do:
          error.status === 429
            ? "Wait a minute, then try again."
            : "Tell the user what happened; try again only if it changes.",
        can_retry: error.status === 429 ? "yes" : "after_changes",
      }
    );
  }
  if (isUnauthorized(error)) return DISCONNECTED;
  // Dreamcash answered the call itself with an error: a wrong tool or input
  if (ProtocolError.isInstance(error)) {
    return {
      code: "tool_failed",
      what_happened: error.message,
      what_to_do:
        "Check the tool name and arguments against the tool list; get_status says what this connection may do.",
      can_retry: "after_changes",
    };
  }
  return unreachable(error);
};

/**
 * The request's own answer, carrying what the key did with it: its status
 * becomes the outcome, so "pending" never sits beside an executed trade.
 */
export const withExecution = (
  content: CallToolResult["content"],
  executed: object,
): CallToolResult["content"] =>
  content.map((block) => {
    if (block.type !== "text") return block;
    try {
      const answer = JSON.parse(block.text) as {
        execute_with_agent_key?: boolean;
        status?: string;
      };
      if (answer.execute_with_agent_key !== true) return block;
      const { execute_with_agent_key: _carriedOut, ...asked } = answer;
      return {
        ...block,
        text: JSON.stringify({
          ...asked,
          // a key that couldn't place it leaves the request as it was
          status:
            "status" in executed && typeof executed.status === "string"
              ? executed.status
              : asked.status,
          executed_with_your_key: executed,
        }),
      };
    } catch {
      return block;
    }
  });

/**
 * What a filled trade came to, from get_trade_request's answer once the key
 * ran it: realized PnL (before fees) and fees, the numbers a user asks for
 * after a close. Undefined until the fills show.
 */
export const fillTotalsOf = (content: CallToolResult["content"]) => {
  const text = content.find((block) => block.type === "text");
  if (!text || text.type !== "text") return undefined;
  try {
    const { result } = JSON.parse(text.text) as {
      result?: {
        realized_pnl_usd?: unknown;
        fees_usd?: unknown;
        dreamcash_part_of_fees_usd?: unknown;
      } | null;
    };
    if (typeof result?.fees_usd !== "number") return undefined;
    return {
      realized_pnl_usd: result.realized_pnl_usd,
      fees_usd: result.fees_usd,
      dreamcash_part_of_fees_usd: result.dreamcash_part_of_fees_usd,
    };
  } catch {
    return undefined;
  }
};

/**
 * The request a request_* call's answer asks this key to carry out, with
 * what the call asked for. Only the package's own call of a request_* tool
 * the key may carry out counts, whatever another answer says.
 */
export const tradeRequestToExecute = (
  tool: string,
  args: Record<string, unknown>,
  result: CallToolResult,
): { id: string; asked: AskedRequest } | undefined => {
  if (result.isError) return undefined;
  const asked = askedRequest(tool, args);
  if (!asked) return undefined;
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try {
      const answer = JSON.parse(block.text) as {
        execute_with_agent_key?: boolean;
        request_id?: unknown;
      };
      if (
        answer.execute_with_agent_key === true &&
        typeof answer.request_id === "string"
      ) {
        return { id: answer.request_id, asked };
      }
    } catch {
      // not JSON: nothing to carry out
    }
  }
  return undefined;
};

/**
 * The one Dreamcash MCP an agent installs: Dreamcash's own tools, reached with
 * the agent's key, plus pairing, and in autonomous mode it places each
 * recorded trade with that key before answering.
 */
export const createDreamcashServer = ({
  apiUrl,
  keyFile,
}: {
  apiUrl: string;
  keyFile: string;
}) => {
  const server = new Server(
    {
      name: "dreamcash",
      title: "Dreamcash",
      version: DREAMCASH_MCP_VERSION,
      websiteUrl: "https://dreamcash.xyz",
      icons: [
        {
          src: new URL("/dreamcash-icon.png", apiUrl).href,
          mimeType: "image/png",
          sizes: ["256x256"],
        },
      ],
    },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: INSTRUCTIONS,
    },
  );
  const pendingFile = pendingKeyFile(keyFile);
  // the paired key
  let account: LocalAccount | undefined;
  // a new key waiting for the user to approve its pairing
  let pairingKey: LocalAccount | undefined;
  let upstream: Client | undefined;
  // the client's tool list is out of date, and it must hear when that changes
  let toolsStale = true;

  const connectUpstream = async (key: LocalAccount) => {
    const client = new Client({
      name: "dreamcash-mcp",
      version: DREAMCASH_MCP_VERSION,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", apiUrl), {
        fetch: signedFetch(key),
      }),
    );
    return client;
  };

  // Dreamcash's tools, once the user paired this machine's key
  const upstreamFor = async (key: LocalAccount) => {
    try {
      return await connectUpstream(key);
    } catch (error) {
      if (isUnauthorized(error)) return undefined;
      throw error;
    }
  };

  const linked = async () => {
    if (upstream) return upstream;
    account ??= await storedAgentAccount(keyFile);
    if (!account) return undefined;
    upstream = await upstreamFor(account);
    return upstream;
  };

  // Connected: the client learns its tools changed (it may not see the new
  // ones until told), and the model which it has now and how Dreamcash wants
  // them used.
  const connected = async (client: Client) => {
    if (toolsStale) {
      await server.notification({ method: "notifications/tools/list_changed" });
    }
    const { tools } = await client.listTools();
    return text({
      connected: true,
      key_address: account?.address,
      tools: tools.map((tool) => tool.name),
      how_to_use: client.getInstructions(),
      next_step:
        "Call how_to_use_dreamcash: it explains every tool, what you may do and how to behave.",
    });
  };

  const freshAccount = async (file: string) => {
    try {
      return await newAgentAccount(file);
    } catch (error) {
      throw new KeyNotSaved(file, error);
    }
  };

  // Paired: the pending key becomes this machine's key
  const finishPairing = async (key: LocalAccount) => {
    await adoptPendingKey(keyFile).catch((error: unknown) => {
      throw new KeyNotSaved(keyFile, error);
    });
    account = key;
    pairingKey = undefined;
    upstream = undefined;
    // the new pairing may allow other tools than the key before it
    toolsStale = true;
    const client = await linked();
    if (!client) {
      return failure({
        code: "pairing_not_accepted",
        what_happened:
          "The code paired, but Dreamcash doesn't accept this agent's key.",
        what_to_do:
          "Ask the user for a new code from their Dreamcash app, then call connect_dreamcash with it and again: true.",
        can_retry: "after_user_action",
      });
    }
    return connected(client);
  };

  // A new key pairs from the pending file and replaces the paired one only
  // once Dreamcash accepts it, so the paired key works until then.
  const connect = async ({
    code,
    again = false,
    agent_name,
  }: {
    code?: string;
    again?: boolean;
    agent_name?: string;
  }) => {
    if (again) {
      pairingKey = await freshAccount(pendingFile);
    } else {
      // a key from before this server started, or whose answer was lost,
      // that paired meanwhile
      pairingKey ??= await storedAgentAccount(pendingFile);
      if (pairingKey && (await upstreamFor(pairingKey))) {
        return finishPairing(pairingKey);
      }
      // a code with a pending key pairs that key; otherwise the paired one serves
      const client = pairingKey && code ? undefined : await linked();
      if (client) return connected(client);
    }
    if (!code) return text(ASK_FOR_THE_CODE);
    pairingKey ??= await freshAccount(pendingFile);
    const clientName =
      agent_name ?? server.getClientVersion()?.name ?? "Your AI";
    await agentApi(apiUrl, pairingKey).pair(code, clientName);
    return finishPairing(pairingKey);
  };

  const executeWithKey = async (
    id: string,
    asked: AskedRequest,
    key: LocalAccount,
  ) => {
    const { info, exchangeSignedBy } = createTradeRequestClients();
    try {
      const outcome = await executeTradeRequest({
        id,
        asked,
        agentAddress: key.address,
        api: agentApi(apiUrl, key),
        info,
        exchange: exchangeSignedBy(key),
      });
      const status = outcome.request.status.toLowerCase();
      return {
        status,
        result: outcome.request.result,
        ...(outcome.refused && { refused: outcome.refused }),
        ...(outcome.followUpProblem && {
          follow_up_problem: outcome.followUpProblem,
        }),
        ...(status === "claimed" &&
          !outcome.refused && {
            note: "Sent; Hyperliquid hasn't shown the outcome yet. Read it with get_trade_request, and never request this trade again.",
          }),
      };
    } catch (error) {
      // it fails before anything is signed
      return { placed: false, error: guidanceFor(error) };
    }
  };

  server.setRequestHandler("tools/list", async () => {
    const tools = await linked()
      .then((client) => client?.listTools())
      .then((listed) => listed?.tools)
      .catch((error: unknown) => {
        if (isUnauthorized(error)) upstream = undefined;
        // unreachable: connect_dreamcash explains why when called
        return undefined;
      });
    toolsStale = tools === undefined;
    return { tools: [CONNECT_TOOL, ...(tools ?? [])] };
  });

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === CONNECT_TOOL.name) return await connect(args);

      const client = await linked();
      if (!client || !account) return failure(NOT_CONNECTED);
      const result = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;

      const toExecute = tradeRequestToExecute(name, args, result);
      if (!toExecute) return result;
      const executed = await executeWithKey(
        toExecute.id,
        toExecute.asked,
        account,
      );
      // read back once: the answer that placed a trade also says what it
      // came to; a failed read leaves that out, never the answer
      const totals =
        "status" in executed && executed.status === "executed"
          ? await client
              .callTool({
                name: "get_trade_request",
                arguments: { request_id: toExecute.id },
              })
              .then((readBack) =>
                fillTotalsOf((readBack as CallToolResult).content),
              )
              .catch(() => undefined)
          : undefined;
      return {
        ...result,
        content: withExecution(result.content, { ...executed, ...totals }),
      };
    } catch (error) {
      if (isUnauthorized(error)) upstream = undefined;
      return failure(guidanceFor(error));
    }
  });

  return server;
};
