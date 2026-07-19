# pokemon-tcg-mcp

An MCP (Model Context Protocol) server that gives Claude access to Pokémon TCG
card data and competitive meta information, over stdio.

**Data sources**

- [pokemontcg.io](https://pokemontcg.io) API v2 — card database, legality data, cardmarket (EUR) and TCGplayer (USD) prices.
- [Limitless TCG](https://limitlesstcg.com) — metagame share from major tournaments (light, cached fetch of the public `/decks` stats page; Limitless' documented API only covers its online tournament platform, so there is no JSON endpoint for this table).

## Tools

| Tool | What it does |
|---|---|
| `search_cards` | Search cards by name, raw Lucene `q`, supertype/subtypes/types, or text phrase. Compact results with prices. |
| `get_card` | Full details for one card (by id, or exact name + optional set code): text, image URL, prices. |
| `find_similar_effects` | "What cards do X?" — forgiving keyword search across attack/ability/rules text, ranked by match count. |
| `check_deck` | Validate a TCG Live decklist export: 60 cards, max 4 per name (basic energy exempt), 1 ACE SPEC max, standard legality, price estimate in EUR. |
| `meta_snapshot` | Current top archetypes with points/share from Limitless (or a clear "source unavailable" message). |
| `price_check` | EUR/USD prices for every printing of a card; cheapest standard-playable copy highlighted. |

## Setup

Requires Node 20+.

```bash
npm install
npm run build
npm test        # unit tests (deck parser, query builder)
```

### API key (optional but recommended)

The server works without a key, at lower rate limits. Get a free key at
[dev.pokemontcg.io](https://dev.pokemontcg.io), then export it as
`POKEMONTCG_API_KEY`.

### Add to Claude Code

```bash
claude mcp add pokemon-tcg --env POKEMONTCG_API_KEY=your-key-here -- node /absolute/path/to/pokemon-tcg-mcp/dist/index.js
```

### Add to Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pokemon-tcg": {
      "command": "node",
      "args": ["/absolute/path/to/pokemon-tcg-mcp/dist/index.js"],
      "env": { "POKEMONTCG_API_KEY": "your-key-here" }
    }
  }
}
```

## How it works

The server speaks MCP over stdio: Claude launches `node dist/index.js` as a
child process, calls the tools above, and gets compact markdown back
(designed to be read by an LLM, not a UI — condensed card text, no giant
JSON dumps).

```
src/
├── index.ts      server entry — registers tools, connects stdio transport
├── tools.ts      the 6 MCP tools (zod-validated inputs, markdown outputs)
├── tcgio.ts      pokemontcg.io v2 client (cached searches, sets, card-by-id)
├── sets.ts       TCG Live set code → pokemontcg.io set-id mapping (from /sets)
├── qbuilder.ts   Lucene `q` builder + keyword extraction (pure, tested)
├── deck.ts       TCG Live/PTCGO decklist parser (pure, tested)
├── legality.ts   standard legality from regulation marks (see Design notes)
├── limitless.ts  Limitless meta table (light, cached fetch — marked in code)
├── format.ts     markdown/price/text-condensing helpers
├── http.ts       fetch with timeout, retry-with-jitter, User-Agent
└── cache.ts      LRU + TTL cache with in-flight request dedup
```

A typical `check_deck` call: parse the decklist → group lines by set code →
resolve each code to set ids via the cached mapping → one API query per set
ORing the card numbers → name-search fallback for anything unresolved → run
the rule checks (60 cards, ≤4 per name, ≤1 ACE SPEC, regulation-mark
legality) → render the problems list, per-card table and EUR estimate.

## Example prompts

- "Find all standard-legal psychic supporters that heal."
- "What cards exist that prevent abilities that knock out their own user?"
- "Check this decklist: … (paste a TCG Live export)"
- "What's the current standard meta looking like?"
- "How much does the cheapest Ethan's Ho-Oh ex cost?"

## Design notes

- **Standard legality is computed from regulation marks, not the API's
  `legalities.standard` field.** The live pokemontcg.io data lags rotation in
  both directions (rotated reg-G cards still say "Legal"; the newest reg-J
  sets say "Not Legal"). The server derives the currently legal marks from
  the date (three newest marks after the ~April rotation; anchor G = 2023)
  and treats basic energy as always legal. Override with
  `STANDARD_REGULATION_MARKS=H,I,J` if the schedule ever changes.
- **Set-code mapping:** TCG Live codes (`PBL`, `POR`, `TWM`, …) are resolved
  via the `ptcgoCode` field of `/sets`, fetched once and cached 24h. Deck
  resolution queries use `set.id` (the embedded `ptcgoCode` on card documents
  is missing for several sets). Unknown codes fall back to name search and
  say so in the output.
- **Caching:** in-memory LRU with TTL — cards/sets 24h, meta 1h. Identical
  concurrent requests are deduplicated.
- **Politeness:** identifying User-Agent, 10s timeouts, a single retry with
  jitter on 429/5xx/timeout, bounded page fetches (never loops).

## Smoke test

End-to-end acceptance scenarios through a real MCP client (needs network):

```bash
npm run build && npm run smoke            # all scenarios
node scripts/smoke.mjs deck meta          # a subset
```

## License

[MIT](LICENSE)
