import packageJson from "../package.json" with { type: "json" };

/** Sent with every call, so Dreamcash can ask an agent running an old one to update */
export const DREAMCASH_MCP_VERSION: string = packageJson.version;
