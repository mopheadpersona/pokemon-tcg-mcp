#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { VERSION, pokemonTcgApiKey } from "./config.js";
import { SetResolver } from "./sets.js";
import { TcgIoClient } from "./tcgio.js";
import { registerTools } from "./tools.js";
import { registerBuildTools } from "./tools-build.js";
import { registerCollectionTools } from "./tools-collection.js";

async function main(): Promise<void> {
  const api = new TcgIoClient();
  const resolver = new SetResolver(api);

  const server = new McpServer({ name: "pokemon-tcg", version: VERSION });
  registerTools(server, api, resolver);
  registerCollectionTools(server, api, resolver);
  registerBuildTools(server, api, resolver);

  // Warm the set-code mapping in the background; tools retry on demand if it fails.
  resolver.mapping().then(
    (m) => console.error(`[pokemon-tcg-mcp] set mapping ready (${m.size} PTCGO/Live codes)`),
    (err) => console.error(`[pokemon-tcg-mcp] set mapping warm-up failed (will retry on demand): ${err.message}`),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[pokemon-tcg-mcp] v${VERSION} ready on stdio` +
      (pokemonTcgApiKey() ? " (pokemontcg.io API key set)" : " (no POKEMONTCG_API_KEY — lower rate limits)"),
  );
}

main().catch((err) => {
  console.error(`[pokemon-tcg-mcp] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
