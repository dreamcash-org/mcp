# @dreamcash-org/mcp

The Dreamcash MCP server an AI agent runs on its user's machine. It pairs
with the user's Dreamcash account by the code their app shows, keeps the
agent's own key, signs every call to Dreamcash's API with it, and carries out
trade requests with that key after checking each plan against what the
agent's own call asked for (`src/agentSafety.ts`).

## Commands

```bash
bun install
bun run typecheck
bun run test
bun run build    # dist/dreamcash-mcp.js, one file, with dist/THIRD_PARTY_LICENSES.md
```

## Releasing

Raise `version` in `package.json` and merge to main, then Actions →
**Publish to npm** → Run workflow. It type-checks, tests and builds main,
publishes it as the package's npm trusted publisher and tags it `v<version>`.

## Two copies: change both

This package's source also lives in Dreamcash's private monorepo, at
`packages/dreamcash-mcp`, where the API and the app use the same trade code.
A change made here goes there too, and one made there comes here. The copies
stay identical apart from import paths; files under `src/shared/` start with
a line saying they are kept in two places.

| Here | In the monorepo |
| --- | --- |
| `src/*.ts` | `packages/dreamcash-mcp/src/` (it also keeps `agentFlow.hl.test.ts`, the testnet run of the whole flow against the API's planner) |
| `src/shared/tradeRequest.ts` | `packages/utils/src/tradeRequest.ts` (the app signs plans with it too) |
| `src/shared/planTypes.ts` | `packages/hyperliquid-orders/src/planTypes.ts` (the API's planner builds these plans) |
| `src/shared/coinId.ts` | `packages/hyperliquid-orders/src/hip4/coinId.ts` |
| `src/shared/orderOutcome.ts` | `packages/hyperliquid/src/utils/orderOutcome.ts` |
| `src/shared/aiAgent.ts`, `assetIndex.ts` | `packages/constants/src/hyperliquid/` |
| `src/shared/appStores.ts`, `vault.ts` | `packages/constants/src/` |
| `src/shared/types.ts` | `Cloid` in `packages/hyperliquid/src/types.ts` |

The API checks what these files describe: the signed-request format, the
shape of a plan, which calls a key may sign. A change only one side gets
can make the key refuse every trade, or sign a plan it shouldn't. Keep
`version` the same in both `package.json` files.
