// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
/** Deposit values under this amount will not count as a deposit for the vault overview endpoint, thus should not show up in the "Deposited" tables/filters */
export const VAULT_DEPOSIT_THRESHOLD = 0.01;

export const PROTOCOL_VAULT_ADDRESSES = [
  "0x63c621a33714ec48660e32f2374895c8026a3a00", // HL liquidator
  "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", // HLP
] as const;

/** The only vault an AI agent trading on its own may move funds into or out of: HLP */
export const AGENT_VAULT_ADDRESSES = [
  "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303",
] as const;
