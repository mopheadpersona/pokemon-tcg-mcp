export const VERSION = "0.1.0";

export const USER_AGENT = `pokemon-tcg-mcp/${VERSION} (local MCP server; personal use)`;

export const TCGIO_API_BASE = "https://api.pokemontcg.io/v2";
export const LIMITLESS_BASE = "https://limitlesstcg.com";

export const REQUEST_TIMEOUT_MS = 10_000;

/** Cards and sets change rarely — cache for a day. */
export const CARD_TTL_MS = 24 * 60 * 60 * 1000;
/** Meta / deck data moves fast — cache for an hour. */
export const META_TTL_MS = 60 * 60 * 1000;

export function pokemonTcgApiKey(): string | undefined {
  const key = process.env.POKEMONTCG_API_KEY?.trim();
  return key ? key : undefined;
}
