/// <reference types="bun" />
import { afterEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AI_AGENT_SIGNATURE_HEADER,
  AI_AGENT_TIMESTAMP_HEADER,
  AI_CLIENT_NAME_MAX_LENGTH,
  aiAgentRequestMessage,
} from "./shared/constants";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { type Hex, recoverMessageAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { agentApi, checkedApiUrl } from "./agentApi";
import {
  KeyUnreadable,
  newAgentAccount,
  pendingKeyFile,
  storedAgentAccount,
} from "./agentKey";
import {
  createDreamcashServer,
  fillTotalsOf,
  legsFromFill,
  legsSetBy,
  tradeRequestToExecute,
  withExecution,
  withField,
} from "./dreamcashServer";
import { signedFetch } from "./signedFetch";

const dirs: string[] = [];
const keyFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), "dreamcash-mcp-"));
  dirs.push(dir);
  return join(dir, "nested", "agent-key.json");
};

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("the agent's key", () => {
  test("is created only when asked, readable by its owner only, and kept", async () => {
    const file = await keyFile();
    expect(await storedAgentAccount(file)).toBeUndefined();
    const created = await newAgentAccount(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await storedAgentAccount(file))?.address).toBe(created.address);
  });

  test("is never written through a link planted where it's written", async () => {
    const file = await keyFile();
    const elsewhere = join(dirname(dirname(file)), "taken.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(elsewhere, "");
    await symlink(elsewhere, `${file}.tmp`);
    const created = await newAgentAccount(file);
    expect(await readFile(elsewhere, "utf8")).toBe("");
    expect((await storedAgentAccount(file))?.address).toBe(created.address);
  });

  test("is replaced by a new pairing's fresh key", async () => {
    const file = await keyFile();
    const first = await newAgentAccount(file);
    const fresh = await newAgentAccount(file);
    expect(fresh.address).not.toBe(first.address);
    expect((await storedAgentAccount(file))?.address).toBe(fresh.address);
  });

  test("that can't be read is an error, never a missing key", async () => {
    const halfWritten = await keyFile();
    await mkdir(dirname(halfWritten), { recursive: true });
    await writeFile(halfWritten, '{"privateKey": "0xab');
    await expect(storedAgentAccount(halfWritten)).rejects.toBeInstanceOf(
      KeyUnreadable,
    );
    const directory = await keyFile();
    await mkdir(directory, { recursive: true });
    await expect(storedAgentAccount(directory)).rejects.toBeInstanceOf(
      KeyUnreadable,
    );
  });
});

describe("the Dreamcash API it calls", () => {
  test("is https, or plain http only on this machine", () => {
    expect(checkedApiUrl("https://api.dreamcash.xyz")).toBe(
      "https://api.dreamcash.xyz/",
    );
    expect(checkedApiUrl("http://127.0.0.1:5001")).toBe(
      "http://127.0.0.1:5001/",
    );
    expect(checkedApiUrl("http://localhost:5001")).toBe(
      "http://localhost:5001/",
    );
    expect(() => checkedApiUrl("http://api.dreamcash.xyz")).toThrow("https");
    expect(() => checkedApiUrl("ws://localhost:5001")).toThrow("https");
  });

  test("gets the name the user sees cut to what Dreamcash takes", async () => {
    const bodies: { clientName: string }[] = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ connectionId: "c" });
    }) as typeof fetch;
    const key = privateKeyToAccount(generatePrivateKey());
    await agentApi("https://api.dreamcash.test", key).pair(
      "K7QM2P",
      "An agent with a very long name ".repeat(4),
    );
    expect(bodies[0]?.clientName).toHaveLength(AI_CLIENT_NAME_MAX_LENGTH);
  });
});

describe("signedFetch", () => {
  test("signs the method, path, moment and exact body as the API checks them", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const sent: Request[] = [];
    globalThis.fetch = mock(async (url: URL, init: RequestInit) => {
      sent.push(new Request(url, init));
      return Response.json({});
    }) as never;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    await signedFetch(key)("https://api.example/mcp?ignored=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const [request] = sent;
    const signer = await recoverMessageAddress({
      message: aiAgentRequestMessage({
        method: "POST",
        path: "/mcp",
        timestampMs: Number(request?.headers.get(AI_AGENT_TIMESTAMP_HEADER)),
        bodySha256: createHash("sha256").update(body).digest("hex"),
      }),
      signature: request?.headers.get(
        AI_AGENT_SIGNATURE_HEADER,
      ) as `0x${string}`,
    });
    expect(signer).toBe(key.address);
    expect(request?.headers.get("content-type")).toBe("application/json");
  });

  test("refuses a body it can't hash as sent", async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    await expect(
      signedFetch(key)("https://api.example/mcp", {
        method: "POST",
        body: new Uint8Array([1]),
      }),
    ).rejects.toThrow("as text");
  });
});

describe("withExecution", () => {
  const request = {
    request_id: "r-1",
    status: "pending",
    execute_with_agent_key: true,
  };
  const textOf = (value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value) },
  ];
  const merged = (executed: object) =>
    withExecution(textOf(request), executed).map((block) =>
      block.type === "text" ? JSON.parse(block.text) : block,
    );

  test("puts what the key did in the request's own answer, its status first", () => {
    const executed = { status: "executed", result: { orderId: 7 } };
    expect(merged(executed)).toEqual([
      {
        request_id: "r-1",
        status: "executed",
        executed_with_your_key: executed,
      },
    ]);
  });

  test("leaves the status as it was when the key placed nothing", () => {
    const executed = { placed: false, error: { code: "user_approves_key" } };
    expect(merged(executed)).toEqual([
      {
        request_id: "r-1",
        status: "pending",
        executed_with_your_key: executed,
      },
    ]);
  });

  test("leaves an answer that asked no key to carry it out alone", () => {
    const plain = textOf({ request_id: "r-2", status: "pending" });
    expect(withExecution(plain, { status: "executed" })).toEqual(plain);
  });
});

describe("fillTotalsOf", () => {
  const textOf = (value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value) },
  ];

  test("reads a filled trade's realized PnL and fees from get_trade_request", () => {
    const readBack = textOf({
      status: "executed",
      result: {
        order_id: 1,
        realized_pnl_usd: -0.0132,
        fees_usd: 0.0268,
        dreamcash_part_of_fees_usd: 0.0134,
        net_pnl_usd: -0.04,
        executed_size: 0.0088,
      },
    });
    // every USD figure the API gives, a new one included; ids and sizes stay out
    expect(fillTotalsOf(readBack)).toEqual({
      realized_pnl_usd: -0.0132,
      fees_usd: 0.0268,
      dreamcash_part_of_fees_usd: 0.0134,
      net_pnl_usd: -0.04,
    });
  });

  test("gives nothing before the fills show, or for an answer it can't read", () => {
    expect(
      fillTotalsOf(textOf({ status: "executed", result: { order_id: 1 } })),
    ).toBeUndefined();
    expect(
      fillTotalsOf(textOf({ status: "failed", result: null })),
    ).toBeUndefined();
    expect(fillTotalsOf([{ type: "text", text: "not json" }])).toBeUndefined();
  });
});

describe("tradeRequestToExecute", () => {
  const answer = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError,
  });
  const marked = answer({ request_id: "r-1", execute_with_agent_key: true });
  const ORDER_ARGS = { market: "BTC", side: "long", size_usd: 20 };

  test("picks out the request its own request_* call made, with what it asked", () => {
    expect(tradeRequestToExecute("request_order", ORDER_ARGS, marked)).toEqual({
      id: "r-1",
      asked: expect.objectContaining({
        kind: "ORDER",
        market: "BTC",
        params: expect.objectContaining({ side: "long", sizeUsd: 20 }),
      }),
    });
  });

  test("leaves anything else alone", () => {
    for (const tool of [
      "get_account",
      "request_withdraw",
      "request_spot_perp_transfer",
      "request_autonomous_trading",
      "toString",
    ]) {
      expect(tradeRequestToExecute(tool, ORDER_ARGS, marked)).toBeUndefined();
    }
    expect(
      tradeRequestToExecute(
        "request_order",
        ORDER_ARGS,
        answer({ request_id: "r-1" }),
      ),
    ).toBeUndefined();
    expect(
      tradeRequestToExecute(
        "request_order",
        ORDER_ARGS,
        answer({ request_id: "r-1", execute_with_agent_key: true }, true),
      ),
    ).toBeUndefined();
    expect(
      tradeRequestToExecute("request_order", ORDER_ARGS, {
        content: [{ type: "text", text: "not json" }],
      }),
    ).toBeUndefined();
  });
});

describe("legsFromFill", () => {
  const ORDER_ARGS = {
    market: "BTC",
    side: "long",
    size_usd: 20,
    stop_loss_pct: 5,
    take_profit_pct: 10,
  };
  const askedOf = (args: Record<string, unknown>) => {
    const asked = tradeRequestToExecute("request_order", args, {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            request_id: "r-1",
            execute_with_agent_key: true,
          }),
        },
      ],
    })?.asked;
    if (!asked) throw new Error("not a request to carry out");
    return asked;
  };
  const filled = (averagePrice: number | null) => ({
    status: "executed",
    result: { orderId: 7, executedSize: 0.0002, averagePrice, detail: null },
  });

  test("prices a long's legs from its average fill, as request_set_tp_sl takes them", () => {
    expect(askedOf(ORDER_ARGS).params).toMatchObject({
      stopLossPct: 5,
      takeProfitPct: 10,
    });
    const legs = legsFromFill("r-1", askedOf(ORDER_ARGS), filled(100_000));
    expect(legs).toEqual({
      call: {
        market: "BTC",
        take_profit_price: 110_000,
        stop_loss_price: 95_000,
        idempotency_key: "legs-from-fill-r-1",
      },
    });
  });

  test("mirrors them for a short, and keeps the wallet the order named", () => {
    const legs = legsFromFill(
      "r-1",
      askedOf({ ...ORDER_ARGS, side: "short", wallet: "0xabc" }),
      filled(100_000),
    );
    expect(legs).toEqual({
      call: expect.objectContaining({
        wallet: "0xabc",
        take_profit_price: 90_000,
        stop_loss_price: 105_000,
      }),
    });
  });

  test("warns, setting nothing, while the fill or its price isn't known", () => {
    for (const executed of [
      { status: "claimed", result: null },
      filled(null),
    ]) {
      const legs = legsFromFill("r-1", askedOf(ORDER_ARGS), executed);
      expect(legs).toEqual({ problem: expect.stringContaining("has none") });
    }
  });

  test("sets nothing for an order that asked none, didn't fill or wasn't placed", () => {
    const { stop_loss_pct, take_profit_pct, ...noLegs } = ORDER_ARGS;
    expect(
      legsFromFill("r-1", askedOf(noLegs), filled(100_000)),
    ).toBeUndefined();
    expect(
      legsFromFill("r-1", askedOf(ORDER_ARGS), {
        status: "failed",
        result: null,
      }),
    ).toBeUndefined();
    expect(
      legsFromFill("r-1", askedOf(ORDER_ARGS), { placed: false }),
    ).toBeUndefined();
  });

  test("says the legs are set only once request_set_tp_sl's request executed", () => {
    const call = { take_profit_price: 110_000, stop_loss_price: 95_000 };
    const answer = (value: unknown, isError = false) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      isError,
    });
    expect(legsSetBy(call, answer({ status: "executed" }))).toEqual({
      set: true,
      ...call,
      request: { status: "executed" },
    });
    for (const result of [
      answer({ status: "claimed" }),
      answer({ error: { code: "plan_refused" } }, true),
    ]) {
      expect(legsSetBy(call, result)).toMatchObject({
        set: false,
        warning: expect.stringContaining("has none"),
      });
    }
  });

  test("adds the outcome to the order's own answer", () => {
    const content = withField(
      [{ type: "text", text: JSON.stringify({ status: "executed" }) }],
      "legs_from_fill",
      { set: true },
    );
    expect(JSON.parse((content[0] as { text: string }).text)).toEqual({
      status: "executed",
      legs_from_fill: { set: true },
    });
  });
});

describe("the MCP an agent talks to", () => {
  const servers: { stop: () => unknown }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  // an agent talking to this package over MCP, in memory
  const agentOf = async ({
    apiUrl,
    keyFile,
  }: {
    apiUrl: string;
    keyFile: string;
  }) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createDreamcashServer({ apiUrl, keyFile }).connect(serverSide);
    const client = new Client({ name: "test-agent", version: "0" });
    let toolListChanges = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      toolListChanges += 1;
    });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
      };
      const [body, carriedOut] = result.content.map((block) =>
        JSON.parse(block.text),
      );
      return { isError: result.isError === true, body, carriedOut };
    };
    return { client, call, toolListChanges: () => toolListChanges };
  };

  // nothing listens on port 1
  const NOWHERE = "http://127.0.0.1:1";

  const signerOf = async (request: Request) => {
    const body = await request.text();
    return recoverMessageAddress({
      message: aiAgentRequestMessage({
        method: request.method,
        path: new URL(request.url).pathname,
        timestampMs: Number(request.headers.get(AI_AGENT_TIMESTAMP_HEADER)),
        bodySha256: createHash("sha256").update(body).digest("hex"),
      }),
      signature: request.headers.get(AI_AGENT_SIGNATURE_HEADER) as Hex,
    }).catch(() => "unsigned");
  };

  // the code the user's app shows
  const APP_CODE = "K7QM2P";

  // Dreamcash as the package sees it: pairing by the app's code, its MCP
  // tools for the keys that paired, and one trade request
  const fakeDreamcash = ({
    tools = {},
    tradeRequest = {},
  }: {
    tools?: Record<string, unknown>;
    tradeRequest?: object;
  }) => {
    const approved = new Set<string>();
    const spentCodes = new Set<string>();
    const calls: string[] = [];
    const mcp = createMcpHandler(
      () => {
        const server = new McpServer({ name: "dreamcash", version: "0" });
        for (const [name, answer] of Object.entries(tools)) {
          server.registerTool(
            name,
            { description: name, inputSchema: z.object({}) },
            async () => ({
              content: [{ type: "text", text: JSON.stringify(answer) }],
            }),
          );
        }
        return server;
      },
      { responseMode: "json" },
    );
    const api = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        const signer = await signerOf(request.clone());
        calls.push(`${request.method} ${pathname}`);
        if (pathname === "/api/ai-agent/links/pair") {
          const { code } = (await request.json()) as { code: string };
          // as Dreamcash does: the app's code pairs once
          if (code !== APP_CODE || spentCodes.has(code)) {
            return Response.json(
              {
                message: "That code isn't valid.",
                code: "code_invalid",
                error: {
                  code: "code_invalid",
                  what_happened: "That code isn't valid.",
                  what_to_do: "Ask the user for the code their app shows.",
                  can_retry: "after_user_action",
                },
              },
              { status: 409 },
            );
          }
          spentCodes.add(code);
          approved.add(signer);
          return Response.json({ connectionId: "connection-1" });
        }
        if (!approved.has(signer)) return new Response(null, { status: 401 });
        if (pathname === "/mcp") return mcp.fetch(request);
        return Response.json(tradeRequest);
      },
    });
    servers.push(api);
    return { url: `http://127.0.0.1:${api.port}`, approved, calls };
  };

  test("a call before pairing says to connect first", async () => {
    const { call } = await agentOf({
      apiUrl: NOWHERE,
      keyFile: await keyFile(),
    });
    expect(await call("get_account")).toMatchObject({
      isError: true,
      body: {
        error: expect.objectContaining({
          code: "not_connected",
          can_retry: "after_user_action",
        }),
      },
    });
  });

  test("an unreachable Dreamcash is worth another try, and lists only connect", async () => {
    const file = await keyFile();
    await newAgentAccount(file);
    const { client, call } = await agentOf({ apiUrl: NOWHERE, keyFile: file });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["connect_dreamcash"]);
    expect(await call("connect_dreamcash")).toMatchObject({
      isError: true,
      body: { error: { code: "dreamcash_unreachable", can_retry: "yes" } },
    });
  });

  test("a key it can't save is the user's to fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dreamcash-mcp-"));
    dirs.push(dir);
    const blocker = join(dir, "a-file");
    await writeFile(blocker, "");
    const { call } = await agentOf({
      apiUrl: NOWHERE,
      // a directory can't be made under a file
      keyFile: join(blocker, "agent-key.json"),
    });
    expect(await call("connect_dreamcash", { code: "K7QM2P" })).toMatchObject({
      isError: true,
      body: {
        error: {
          code: "key_not_saved",
          tell_the_user: expect.stringContaining("DREAMCASH_AGENT_KEY_FILE"),
        },
      },
    });
  });

  test("a key it can't read is the user's to fix, and stays as it was", async () => {
    const file = await keyFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"privateKey": "0xab');
    const { call } = await agentOf({ apiUrl: NOWHERE, keyFile: file });
    expect(await call("connect_dreamcash")).toMatchObject({
      isError: true,
      body: {
        error: {
          code: "key_unreadable",
          tell_the_user: expect.stringContaining(file),
          can_retry: "after_user_action",
        },
      },
    });
    expect(await readFile(file, "utf8")).toBe('{"privateKey": "0xab');
  });

  test("Dreamcash's own guidance on a refusal reaches the agent as it was sent", async () => {
    const guidance = {
      code: "code_invalid",
      what_happened: "That code isn't valid.",
      what_to_do: "Ask the user for the code their app shows.",
      can_retry: "after_user_action",
    };
    const api = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            message: guidance.what_happened,
            code: guidance.code,
            error: guidance,
          },
          { status: 409 },
        ),
    });
    servers.push(api);
    const { call } = await agentOf({
      apiUrl: `http://127.0.0.1:${api.port}`,
      keyFile: await keyFile(),
    });
    expect(await call("connect_dreamcash", { code: "AAAAAA" })).toEqual({
      isError: true,
      body: { error: guidance },
      carriedOut: undefined,
    });
  });

  test("pairs with the code the user read off their app, and only a valid one", async () => {
    const file = await keyFile();
    const dreamcash = fakeDreamcash({ tools: { get_account: { usd: 1 } } });
    const { call } = await agentOf({ apiUrl: dreamcash.url, keyFile: file });

    expect((await call("connect_dreamcash")).body).toMatchObject({
      connected: false,
      next_step: expect.stringContaining("Settings › Connected AI"),
    });
    expect(dreamcash.calls).toEqual([]);

    const wrong = await call("connect_dreamcash", { code: "AAAAAA" });
    expect(wrong.body.error.code).toBe("code_invalid");
    expect(await storedAgentAccount(file)).toBeUndefined();

    const paired = await call("connect_dreamcash", { code: APP_CODE });
    expect(paired.body).toMatchObject({ connected: true });
    const key = await storedAgentAccount(file);
    expect(paired.body.key_address).toBe(key?.address);
    expect(await storedAgentAccount(pendingKeyFile(file))).toBeUndefined();
    expect((await call("get_account")).body).toEqual({ usd: 1 });

    // connected: a call without a code says so
    expect((await call("connect_dreamcash")).body).toMatchObject({
      connected: true,
      key_address: key?.address,
    });
  });

  test("pairing again keeps the paired key working until the new one pairs", async () => {
    const file = await keyFile();
    const paired = await newAgentAccount(file);
    const dreamcash = fakeDreamcash({ tools: { get_account: { usd: 1 } } });
    dreamcash.approved.add(paired.address);
    const { client, call, toolListChanges } = await agentOf({
      apiUrl: dreamcash.url,
      keyFile: file,
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "connect_dreamcash",
      "get_account",
    ]);

    expect(
      (await call("connect_dreamcash", { again: true })).body,
    ).toMatchObject({ connected: false });
    const fresh = await storedAgentAccount(pendingKeyFile(file));
    expect(fresh?.address).not.toBe(paired.address);
    expect((await storedAgentAccount(file))?.address).toBe(paired.address);
    expect((await call("get_account")).body).toEqual({ usd: 1 });

    expect(
      (await call("connect_dreamcash", { code: APP_CODE })).body,
    ).toMatchObject({ connected: true, key_address: fresh?.address });
    expect((await storedAgentAccount(file))?.address).toBe(fresh?.address);
    expect(await storedAgentAccount(pendingKeyFile(file))).toBeUndefined();
    expect(toolListChanges()).toBe(1);
  });

  test("connects a pending key that paired while its answer was lost", async () => {
    const file = await keyFile();
    const pending = await newAgentAccount(pendingKeyFile(file));
    const dreamcash = fakeDreamcash({ tools: { get_account: { usd: 1 } } });
    dreamcash.approved.add(pending.address);
    const { call } = await agentOf({ apiUrl: dreamcash.url, keyFile: file });

    expect((await call("connect_dreamcash")).body).toMatchObject({
      connected: true,
      key_address: pending.address,
    });
    expect((await storedAgentAccount(file))?.address).toBe(pending.address);
    expect(await storedAgentAccount(pendingKeyFile(file))).toBeUndefined();
  });

  test("carries out only its own request_* call's request, and leaves approving its key to the user", async () => {
    const file = await keyFile();
    const key = await newAgentAccount(file);
    const id = "4b7f0a52-3f1c-4a3e-9d55-0c1f3c2b9e10";
    const marked = { request_id: id, execute_with_agent_key: true };
    const dreamcash = fakeDreamcash({
      tools: { get_account: marked, request_order: marked },
      tradeRequest: {
        id,
        status: "PENDING",
        kind: "APPROVE_AGENT",
        params: { agentAddress: key.address, validUntil: Date.now() + 1 },
      },
    });
    dreamcash.approved.add(key.address);
    const { call } = await agentOf({ apiUrl: dreamcash.url, keyFile: file });
    const tradeRequestCalls = () =>
      dreamcash.calls.filter((line) => line.includes("/trade-requests/"));

    expect((await call("get_account")).carriedOut).toBeUndefined();
    expect(tradeRequestCalls()).toEqual([]);

    const ordered = await call("request_order", {
      market: "BTC",
      side: "long",
      size_usd: 20,
    });
    // one answer: the request's own, with what the key did in it
    expect(ordered.carriedOut).toBeUndefined();
    expect(ordered.body).toEqual({
      request_id: id,
      executed_with_your_key: {
        placed: false,
        error: expect.objectContaining({
          code: "user_approves_key",
          what_to_do: expect.stringContaining("Dreamcash app"),
        }),
      },
    });
    expect(tradeRequestCalls()).toEqual([
      `GET /api/ai-connections/agent/trade-requests/${id}`,
    ]);
  });
});
