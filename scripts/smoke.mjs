#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built server (dist/index.js) over stdio
 * via a real MCP client and runs the acceptance scenarios. Requires network.
 *
 *   node scripts/smoke.mjs            # run everything
 *   node scripts/smoke.mjs deck meta  # run selected scenarios
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DEMO_DECK = `Pokémon: 8
4 Slowpoke PBL 29
4 Psyduck ASC 39

Trainer: 34
4 Jacinthe POR 75
1 Jacinthe POR 110
1 Iono PAL 185
4 Caretaker TWM 144
4 Gwynn PBL 78
4 Jett PBL 79
4 Dark Bell PBL 75
4 Backtrack Badge PBL 74
3 Fossil Quarry PBL 76
1 Gladion's Final Battle PBL 77
4 Antique Armor Fossil PBL 72

Energy: 18
18 Basic {P} Energy SVE 5

Total Cards: 60`;

// Collection scenarios run against a throwaway fixture file unless the caller
// already points POKEMON_COLLECTION_PATH somewhere. All printings verified
// against the live API (2026-07).
const FIXTURE_COLLECTION = `# smoke-test collection — Mega Slowbro shell
Pokémon: 15
4 Slowpoke PBL 29
2 Slowbro PBL 30
2 Mega Slowbro ex PBL 31
4 Spritzee POR 35
3 Aromatisse POR 36

Trainer: 33
4 Jacinthe POR 75
4 Caretaker TWM 144
4 Gwynn PBL 78
4 Jett PBL 79
4 Buddy-Buddy Poffin TEF 144
4 Switch MEG 130
3 Backtrack Badge PBL 74
4 Dark Bell PBL 75
2 Fossil Quarry PBL 76

Energy: 20
20 Basic Psychic Energy SVE 5
`;
if (!process.env.POKEMON_COLLECTION_PATH) {
  const path = join(mkdtempSync(join(tmpdir(), "ptcg-smoke-")), "collection.txt");
  writeFileSync(path, FIXTURE_COLLECTION);
  process.env.POKEMON_COLLECTION_PATH = path;
  console.error(`[smoke] fixture collection at ${path}`);
}

const SCENARIOS = {
  search: ["search_cards", { query: "jacinthe" }],
  effects: ["find_similar_effects", { effect_text: "heal from benched pokemon" }],
  damp: ["search_cards", { text_contains: "knock out itself", standard_legal_only: true }],
  deck: ["check_deck", { decklist: DEMO_DECK }],
  meta: ["meta_snapshot", {}],
  price: ["price_check", { name: "Jacinthe" }],
  card: ["get_card", { id: "me2pt5-39" }],
  collection: ["collection_list", {}],
  colladd: ["collection_add", { lines: "4 Jacinthe POR 75" }],
  ambig: ["collection_add", { lines: "1 Slowbro" }],
  collremove: ["collection_remove", { lines: "1 Slowpoke PBL 29" }],
  build: ["build_decks", { deck_count: 1 }],
  build2: ["build_decks", { deck_count: 2 }],
};

const picked = process.argv.slice(2);
const toRun = picked.length > 0 ? picked : Object.keys(SCENARIOS);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failed = false;
for (const key of toRun) {
  const scenario = SCENARIOS[key];
  if (!scenario) {
    console.log(`unknown scenario: ${key} (have: ${Object.keys(SCENARIOS).join(", ")})`);
    continue;
  }
  const [tool, args] = scenario;
  const label = `${key}: ${tool} ${JSON.stringify(args).slice(0, 80)}`;
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result.content.map((c) => c.text).join("\n");
    console.log(`\n${"=".repeat(20)} ${label} ${result.isError ? "[isError]" : ""}\n${text}`);
    if (result.isError) failed = true;
  } catch (err) {
    console.log(`\n${"=".repeat(20)} ${label}\nTHREW: ${err.message}`);
    failed = true;
  }
}

await client.close();
process.exit(failed ? 1 : 0);
