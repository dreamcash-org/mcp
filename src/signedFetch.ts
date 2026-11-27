import { createHash } from "node:crypto";
import {
  AI_AGENT_SIGNATURE_HEADER,
  AI_AGENT_TIMESTAMP_HEADER,
  aiAgentRequestMessage,
  DREAMCASH_MCP_VERSION_HEADER,
} from "./shared/constants";
import type { LocalAccount } from "viem";
import { DREAMCASH_MCP_VERSION } from "./version";

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * fetch with every call signed by the agent's key over its method, path,
 * moment and exact body: how Dreamcash knows the call comes from the key
 * the user paired. The body must be text, as JSON calls send it.
 */
export const signedFetch =
  (account: LocalAccount): Fetch =>
  async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    if (init.body != null && typeof init.body !== "string") {
      throw new Error("Dreamcash calls send their body as text");
    }
    const body = init.body ?? "";
    const at = Date.now();
    const signature = await account.signMessage({
      message: aiAgentRequestMessage({
        method,
        path: url.pathname,
        timestampMs: at,
        bodySha256: createHash("sha256").update(body).digest("hex"),
      }),
    });
    const headers = new Headers(init.headers ?? request?.headers);
    headers.set(AI_AGENT_TIMESTAMP_HEADER, String(at));
    headers.set(AI_AGENT_SIGNATURE_HEADER, signature);
    headers.set(DREAMCASH_MCP_VERSION_HEADER, DREAMCASH_MCP_VERSION);
    return fetch(url, { ...init, method, headers });
  };
