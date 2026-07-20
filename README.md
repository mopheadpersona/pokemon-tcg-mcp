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
| `collection_list` | Parsed & resolved view of your local collection file: counts, sets, kinds, standard legality, summary totals. |
| `collection_add` | Add cards to the collection (TCG Live line format). Ambiguous bare names change nothing and list the candidate printings. |
| `collection_remove` | Decrement/drop cards, matched against the file itself (no API). Ambiguity and over-removal are refused/clamped with notes. |
| `build_decks` | Deterministic deck builder over your collection: evolution-line cores, starter/draw/search/switch/energy proportions, check_deck validation — and for two decks, a counter-score minimized across rebuilds. |
| `resolve_scanned` | Turn card identifications transcribed from photos into verified printings: quantities optional, `031/084` totals infer the set, JP set codes (`m5`) and common JP names map to English, name-only lines pick the newest standard-legal printing. Outputs clean TCG Live lines. |
| `session_save` | Journal a kitchen-table session (card lines + built decks) as a timestamped JSON file. Name collisions append `-2`. |
| `session_list` | All saved sessions: name, date, card count, deck names. |
| `session_load` | Reload a session's lines and decks in the formats the other tools accept. |

The server also registers two **MCP prompts** for one-tap mobile flows:
`kitchen-table` (photograph cards on the table → resolve → build 1–2 decks →
save the session) and `table-judge` (explain what a card does from verified
data, with a play example). The vision step — reading the photos — happens in
the Claude client; this server only ever receives text lines and **never
calls any LLM API**.

## Setup

Requires Node 20+.

```bash
npm install
npm run build
npm test        # unit tests (parsers, query builder, deck builder, counter-score, collection)
```

### API key (optional but recommended)

The server works without a key, at lower rate limits. Get a free key at
[dev.pokemontcg.io](https://dev.pokemontcg.io), then export it as
`POKEMONTCG_API_KEY`.

### Collection file (for the collection & deck-builder tools)

Your collection lives in a plain text file — same line format as TCG Live
decklist exports, one printing per line, `#` comments allowed, section
headers optional and ignored:

```
# binder, sorted 2026-07
Pokémon:
4 Slowpoke PBL 29
2 Slowbro PBL 21
2 Mega Slowbro ex PBL 22

Trainer:
4 Jacinthe POR 75

Energy:
20 Basic Psychic Energy SVE 5
```

The path comes from `POKEMON_COLLECTION_PATH` (default: `./collection.txt`
relative to the server's working directory). Set it alongside the API key:

```bash
claude mcp add pokemon-tcg \
  --env POKEMONTCG_API_KEY=your-key-here \
  --env POKEMON_COLLECTION_PATH=/absolute/path/to/collection.txt \
  -- node /absolute/path/to/pokemon-tcg-mcp/dist/index.js
```

You can edit the file by hand or through `collection_add` /
`collection_remove` — comments and unrelated lines are preserved. Lines that
fail to resolve on pokemontcg.io show up as warnings and are skipped by the
deck builder; they never break anything.

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
├── index.ts             server entry — registers tools, connects stdio transport
├── tools.ts             the 6 original MCP tools (zod-validated inputs, markdown outputs)
├── tools-collection.ts  collection_list / collection_add / collection_remove
├── tools-build.ts       build_decks (rendering + acquisition suggestions)
├── tools-scan.ts        resolve_scanned (kitchen-table photo workflow)
├── tools-session.ts     session_save / session_list / session_load
├── prompts.ts           kitchen-table + table-judge MCP prompts
├── scan.ts              parser for messy scanned card lines (pure, tested)
├── scanresolve.ts       scanned-line resolution: EN codes, JP sets by name, /NNN totals, name-only
├── jpsets.ts            JP→EN set-code + card-name tables (plain constants, easy to extend)
├── session.ts           session journal records over the Storage interface (pure, tested)
├── storage.ts           Storage interface + FsStorage (SESSIONS_DIR, default ./sessions)
├── deckbuilder.ts       deterministic deck engine: evolution lines, core scoring, assembly (pure, tested)
├── counterscore.ts      5-component weighted counter-score between two decks (pure, tested)
├── effects.ts           text-pattern detectors: draw/search/switch/status/denial/snipe… (pure, tested)
├── collection.ts        collection file parse/mutate, comment-preserving (pure, tested)
├── resolve.ts           shared decklist-line → card resolution (one query per set code)
├── validate.ts          shared deck rule checks (size, ≤4/name, ACE SPEC, legality)
├── tcgio.ts             pokemontcg.io v2 client (cached searches, sets, card-by-id)
├── sets.ts              TCG Live set code → pokemontcg.io set-id mapping (from /sets)
├── qbuilder.ts          Lucene `q` builder + keyword extraction (pure, tested)
├── deck.ts              TCG Live/PTCGO decklist parser (pure, tested)
├── legality.ts          standard legality from regulation marks (see Design notes)
├── limitless.ts         Limitless meta table (light, cached fetch — marked in code)
├── format.ts            markdown/price/text-condensing helpers
├── toolutil.ts          shared MCP result/guard plumbing
├── http.ts              fetch with timeout, retry-with-jitter, User-Agent
└── cache.ts             LRU + TTL cache with in-flight request dedup
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

Collection & deck-builder flows:

- "Add these pulls to my collection: 4 Jacinthe POR 75, 2 Slowpoke PBL 29" →
  `collection_add`, then "what's in my collection?" → `collection_list`.
- "Build me two 60-card decks from my collection that won't counter each
  other" → `build_decks {deck_count: 2}`: two lists plus the counter-score
  breakdown (weakness overlap, status vs no-cure, energy denial, snipe vs
  bench, tempo) and a verdict — the builder rebuilds up to 5 times, swapping
  the worst offenders, before settling.
- "Build one deck around Aromatisse" →
  `build_decks {must_include: ["Aromatisse"]}` — the Spritzee/Aromatisse line
  is forced into the core and the rest is assembled around it.
- "Make a 40-card home-play deck, anything I own goes" →
  `build_decks {deck_size: 40, format: "unrestricted"}` (regulation marks
  ignored, copy limits still enforced, proportions scaled by 2/3).
- "What should I buy to round this deck out?" →
  `build_decks {owned_only: false, max_proxies: 5}` — gap-filling cards are
  suggested separately with prices, never silently mixed into the list.

Kitchen-table flows (the `kitchen-table` prompt walks through this):

- Photograph the cards on the table → the client transcribes lines like
  `2 Slowpoke PBL 29`, `Mega Slowbro ex 031/084`, `ヤドラン m5 029`,
  `Jacinthe` → `resolve_scanned` verifies every printing, flags what needs a
  retake, and emits clean Live-format lines.
- `collection_add` the clean lines, `build_decks {deck_size: 40}` for a quick
  game, then `session_save` so next week's session can `session_load` the
  same pool.
- "What does this card do?" (photo or name, JP or EN) → the `table-judge`
  prompt: `resolve_scanned`/`get_card` for ground truth, then a plain-language
  explanation with a play example.

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
- **Deck builder is deterministic code, not LLM guesswork.** Collection
  Pokémon are grouped into evolution lines via `evolvesFrom`, scored as
  attacker cores (damage, energy efficiency, HP, prize liability, abilities),
  and the deck is assembled to hard proportions: 8+ starter basics per 60
  cards (mulligan threshold), 6–10 draw supporters, 2–4 switch effects,
  12–15 energy matched to the cores' attack costs — scaled by 2/3 for
  40-card decks. Every built deck passes the same rule checks as
  `check_deck` before it is returned.
- **Counter-score:** for `deck_count=2`, five weighted 0–10 components
  (weakness exploitation ×3, status vs no-cure ×2, energy denial vs
  expensive attacks ×2, snipe vs bench reliance ×2, tempo mismatch ×1) are
  computed from text patterns over the decks' own cards; the weighted
  average <3 is a balanced pair, 3–6 playable, >6 rebuild recommended. The
  builder retries up to 5 times, banning the worst offenders, and keeps the
  best pair seen.
- **Scanned-card resolution never trusts what it can't verify.** EN set code
  + number is authoritative (a disagreeing scanned name gets a warning);
  mapped JP sets (`m5`→`PBL`, table in `jpsets.ts`) are matched **by name**
  because JP collector numbers don't line up with EN numbering; `031/084`
  totals infer candidate sets from `/sets` printed totals; unmapped JP codes
  and untranslatable JP names are reported explicitly instead of guessed.
  Lookups are batched (one query per set code / JP code / printed total).
- **Sessions are dumb JSON files** in `SESSIONS_DIR` (default `./sessions`),
  one per session, written through a small `Storage` interface so another
  backend could replace the filesystem without touching tool logic. Name
  collisions append `-2` rather than overwriting.
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
