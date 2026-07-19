#!/usr/bin/env node
/**
 * End-to-end smoke test: spawns the built server (dist/index.js) over stdio
 * via a real MCP client and runs the acceptance scenarios. Requires network.
 *
 *   node scripts/smoke.mjs            # run everything
 *   node scripts/smoke.mjs deck meta  # run selected scenarios
 */
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

const SCENARIOS = {
  search: ["search_cards", { query: "jacinthe" }],
  effects: ["find_similar_effects", { effect_text: "heal from benched pokemon" }],
  damp: ["search_cards", { text_contains: "knock out itself", standard_legal_only: true }],
  deck: ["check_deck", { decklist: DEMO_DECK }],
  meta: ["meta_snapshot", {}],
  price: ["price_check", { name: "Jacinthe" }],
  card: ["get_card", { id: "me2pt5-39" }],
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
