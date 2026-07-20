/**
 * Session journal tools: save/list/load kitchen-table sessions. All
 * persistence goes through the Storage interface (storage.ts) — the tools
 * never touch the filesystem directly.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { cardCountOf, listSessions, loadSession, saveSession } from "./session.js";
import type { Storage } from "./storage.js";
import { guard, textResult } from "./toolutil.js";

/** Markdown-table-safe text: no pipes or newlines (deck names are user input). */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ");
}

/** A code fence longer than any backtick run in the content, so it can't be closed early. */
function fence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

export function registerSessionTools(server: McpServer, storage: Storage): void {
  // --------------------------------------------------------------- session_save
  server.registerTool(
    "session_save",
    {
      title: "Save a kitchen-table session",
      description:
        "Save the session's card lines (TCG Live format) and optionally the built decks as a timestamped JSON " +
        "record. Name defaults to today's date; a name collision appends -2 rather than overwriting.",
      inputSchema: {
        name: z.string().optional().describe("Session name (default: today's ISO date, e.g. 2026-07-20)"),
        lines: z
          .array(z.string())
          .min(1)
          .describe("Card lines in TCG Live format, e.g. ['2 Slowpoke PBL 29', '1 Jacinthe POR 75']"),
        decks: z
          .array(z.object({ name: z.string(), decklist: z.string().describe("TCG Live decklist text") }))
          .optional()
          .describe("Decks built this session, e.g. from build_decks output"),
      },
    },
    async (args) =>
      guard(async () => {
        const { record, renamedFrom } = await saveSession(storage, {
          name: args.name,
          lines: args.lines,
          decks: args.decks,
        });
        const bits = [
          `Saved session **${record.name}** — ${cardCountOf(record.lines)} cards in ${record.lines.length} line(s)` +
            (record.decks ? `, ${record.decks.length} deck(s): ${record.decks.map((d) => cell(d.name)).join(", ")}` : "") +
            ` · ${record.savedAt}`,
        ];
        if (renamedFrom) bits.push(`_"${renamedFrom}" already existed — saved as "${record.name}" instead._`);
        return textResult(bits.join("\n"));
      }),
  );

  // --------------------------------------------------------------- session_list
  server.registerTool(
    "session_list",
    {
      title: "List saved sessions",
      description: "All saved kitchen-table sessions: name, save time, card count and deck names, newest first.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const { sessions, warnings } = await listSessions(storage);
        if (sessions.length === 0 && warnings.length === 0) {
          return textResult("No saved sessions yet — session_save creates one.");
        }
        const out = [
          `## Sessions (${sessions.length})`,
          "| Session | Saved | Cards | Decks |",
          "|---|---|---|---|",
          ...sessions.map(
            (s) =>
              `| ${cell(s.name)} | ${s.savedAt} | ${s.cardCount} | ${s.deckNames.length > 0 ? cell(s.deckNames.join(", ")) : "–"} |`,
          ),
        ];
        if (warnings.length > 0) out.push(...warnings.map((w) => `- ⚠ ${w}`));
        return textResult(out.join("\n"));
      }),
  );

  // --------------------------------------------------------------- session_load
  server.registerTool(
    "session_load",
    {
      title: "Load a saved session",
      description:
        "Load a saved session by name: card lines come back in TCG Live format (paste into collection_add / " +
        "check_deck / resolve tools) and decks as named decklists.",
      inputSchema: {
        name: z.string().describe("Session name as shown by session_list"),
      },
    },
    async (args) =>
      guard(async () => {
        const record = await loadSession(storage, args.name);
        if (!record) {
          const { sessions } = await listSessions(storage);
          const known = sessions.map((s) => s.name).join(", ") || "none saved yet";
          return textResult(`No session named "${args.name}". Known sessions: ${known}.`, true);
        }
        const linesFence = fence(record.lines.join("\n"));
        const out = [
          `## Session ${record.name} — saved ${record.savedAt}`,
          `### Cards (${cardCountOf(record.lines)})`,
          linesFence,
          ...record.lines,
          linesFence,
        ];
        for (const deck of record.decks ?? []) {
          const deckFence = fence(deck.decklist);
          out.push(`### Deck: ${cell(deck.name)}`, deckFence, deck.decklist.trimEnd(), deckFence);
        }
        return textResult(out.join("\n"));
      }),
  );
}
