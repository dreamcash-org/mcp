// Kept in two places, the Dreamcash monorepo and dreamcash-org/mcp, the same apart from import paths: change both (their AGENTS.md maps the copies).
export const SPOT_ASSET_INDEX_OFFSET = 10_000;
export const HIP3_ASSET_INDEX_OFFSET = 100_000;
export const DEX_INDEX_MULTIPLIER = 10_000;
export const HIP4_ASSET_INDEX_OFFSET = 100_000_000;

/** The asset id HL takes in an order's `a` for the `indexInDex`th market of HIP-3 dex `dexId` */
export const getHip3AssetIndex = (dexId: number, indexInDex: number): number =>
  HIP3_ASSET_INDEX_OFFSET + dexId * DEX_INDEX_MULTIPLIER + indexInDex;

export const hip3DexIdOfAssetIndex = (assetIndex: number): number =>
  Math.floor((assetIndex - HIP3_ASSET_INDEX_OFFSET) / DEX_INDEX_MULTIPLIER);

/** "xyz:TSLA" */
export const isHip3Coin = (coin: string): boolean => coin.includes(":");

/** "@107" or "PURR/USDC"; a spot token's own name ("UETH") isn't one */
export const isSpotCoin = (coin: string): boolean =>
  coin.includes("/") || coin.startsWith("@");

/** "xyz:GOOGL" → "xyz"; undefined for a coin off HIP-3 */
export const getDexFromCoin = (coin: string): string | undefined =>
  isHip3Coin(coin) ? coin.split(":")[0] : undefined;
