#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { checkedApiUrl } from "./agentApi";
import { defaultKeyFile } from "./agentKey";
import { createDreamcashServer } from "./dreamcashServer";

const server = createDreamcashServer({
  apiUrl: checkedApiUrl(
    process.env.DREAMCASH_API_URL ?? "https://api.dreamcash.xyz",
  ),
  keyFile: defaultKeyFile(),
});
await server.connect(new StdioServerTransport());
