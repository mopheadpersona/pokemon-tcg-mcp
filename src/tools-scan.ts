/**
 * resolve_scanned: turn messy card identifications transcribed from photos
 * into verified printings plus clean TCG Live lines. The vision step happens
 * in the Claude client — this server only ever sees text lines.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { liveLine, marksNote, oneLineText, setRef } from "./format.js";
import { currentLegalMarks, isStandardLegal } from "./legality.js";
import { parseScannedLines } from "./scan.js";
import { resolveScanned } from "./scanresolve.js";
import type { SetResolver } from "./sets.js";
import type { TcgIoClient } from "./tcgio.js";
import { guard, textResult } from "./toolutil.js";

export function registerScanTools(server: McpServer, api: TcgIoClient, resolver: SetResolver): void {
  server.registerTool(
    "resolve_scanned",
    {
      title: "Resolve scanned cards",
      description:
        "Resolve raw card identifications transcribed from photos into verified printings. Lines may be messy: " +
        "'Slowpoke PBL 29' (quantity optional), '2 Slowpoke PBL 29', 'Mega Slowbro ex 031/084' (set inferred " +
        "from the printed total), Japanese set codes ('ヤドン m5 028', m5→PBL — JP numbering differs, so mapped " +
        "lines match by name), or a bare name ('Jacinthe' — newest standard-legal printing preferred, " +
        "alternatives listed). Returns a resolved table, unresolved lines with reasons, and clean TCG Live " +
        "lines ready for collection_add, check_deck or build_decks.",
      inputSchema: {
        lines: z
          .array(z.string())
          .min(1)
          .describe("One card identification per entry, e.g. ['2 Slowpoke PBL 29', 'ヤドラン m5 029', 'Jacinthe']"),
      },
    },
    async (args) =>
      guard(async () => {
        const { lines: parsed, skipped } = parseScannedLines(args.lines);
        if (parsed.length === 0) {
          return textResult("No usable card lines — expected entries like `2 Slowpoke PBL 29` or `Jacinthe`.", true);
        }
        const marks = currentLegalMarks();
        const resolutions = await resolveScanned(parsed, api, resolver, marks);
        const reverse = await resolver.reverseMapping();
        const codeOf = (setId: string): string | undefined => reverse.get(setId);
        const resolved = resolutions.filter((r) => r.card);
        const unresolved = resolutions.filter((r) => !r.card);

        const out: string[] = [
          `## resolve_scanned — ${args.lines.length} line(s): ${resolved.length} resolved, ${unresolved.length + skipped.length} unresolved`,
        ];

        if (resolved.length > 0) {
          out.push("| Qty | Card | Set | Std | Text |", "|---|---|---|---|---|");
          for (const r of resolved) {
            const c = r.card!;
            out.push(
              `| ${r.line.count} | ${c.name} | ${setRef(c)} | ${isStandardLegal(c, marks) ? "✓" : "✗"} | ${oneLineText(c)} |`,
            );
          }
          const notes = resolved.flatMap((r) => r.notes.map((n) => `- Line ${r.line.index} (${r.name}): ${n}`));
          if (notes.length > 0) out.push("", "**Notes:**", ...notes);
        }

        const alternates = resolved.filter((r) => r.alternates.length > 0);
        if (alternates.length > 0) {
          out.push("### Alternative printings");
          for (const r of alternates) {
            out.push(
              `- ${r.name}: picked ${setRef(r.card!)} — also ${r.alternates
                .map((c) => `${setRef(c)}${isStandardLegal(c, marks) ? "" : " (not std)"}`)
                .join(", ")}`,
            );
          }
        }

        if (unresolved.length > 0 || skipped.length > 0) {
          out.push("### Unresolved — retake or correct these");
          for (const r of unresolved) {
            // Keep the accumulated notes: they carry context the reason alone
            // lacks (e.g. the explicit unmapped-JP-set-code statement).
            const why = [...new Set([r.reason ?? "not found", ...r.notes])].join("; ");
            out.push(`- Line ${r.line.index} \`${r.line.raw}\` — ${why}`);
          }
          for (const s of skipped) out.push(`- Line ${s.index} \`${s.raw}\` — ${s.reason}`);
        }

        if (resolved.length > 0) {
          // Merge duplicate printings so the block pastes cleanly into other tools.
          const merged = new Map<string, { count: number; text: string }>();
          for (const r of resolved) {
            const c = r.card!;
            const key = `${c.set.id}|${c.number}`;
            const prev = merged.get(key);
            const count = (prev?.count ?? 0) + r.line.count;
            merged.set(key, { count, text: liveLine(c, count, codeOf) });
          }
          out.push(
            "### Clean lines (TCG Live format — paste into collection_add, check_deck or session_save)",
            "```",
            ...[...merged.values()].map((m) => m.text),
            "```",
          );
        }

        out.push(marksNote(marks));
        return textResult(out.join("\n"));
      }),
  );
}
