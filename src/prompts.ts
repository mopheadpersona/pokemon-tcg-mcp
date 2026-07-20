/**
 * MCP prompts for the kitchen-table workflow: one-tap flows a mobile client
 * can offer. The prompt text instructs the CLIENT (which does the vision work
 * on photos); this server only ever receives transcribed text lines.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const KITCHEN_TABLE = `You are running a kitchen-table Pokémon TCG session. The user will send photos of physical cards laid out in grids.

1. Read EVERY card in each photo: the card name (translate Japanese names to English when you can), and the set code and collector number from the bottom corner (e.g. "PBL 29", "m5 028/081"). Produce one line per distinct card: 'QTY NAME SET NUMBER'. If you cannot read a field, leave it out rather than guessing — the server can resolve partial lines.
2. Call resolve_scanned with those lines. Show the user any unresolved cards and ask for a retake of JUST those cards. Repeat until everything important is resolved.
3. Add the resolved clean lines to the collection with collection_add (build_decks reads the collection file). Note: build_decks builds from the WHOLE collection file — if tonight's pool is only the scanned cards, the user should point POKEMON_COLLECTION_PATH at a fresh file for the evening; mention this once if the collection already has other cards.
4. Then ask exactly two questions, nothing else: deck size (40 or 60 cards)? and how many decks (1 or 2)?
5. Call build_decks with owned_only=true and the chosen deck_size and deck_count.
6. Present each deck with a 3-sentence how-to-play summary, beginner-friendly: what to set up first, how it wins, what to watch out for.
7. Offer to save the session with session_save (lines + the built decks).`;

const TABLE_JUDGE = `The user asks what a card does — by photo or by name, possibly in Japanese.

Ground truth first: identify the card with resolve_scanned (for photo transcriptions or messy names) or get_card (for a known name or id) — never answer from memory alone.

Then explain the card's rules text in the user's language, simply, with one concrete play example ("if your opponent's Active Pokémon has 60 HP left and you use this attack, …"). If the card interacts with a common rule — evolution timing, special conditions, prize trades (ex/Mega ex give up extra prizes), retreat, weakness — add exactly one clarifying sentence about that rule.`;

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "kitchen-table",
    {
      title: "Kitchen-table deck night",
      description:
        "Guided flow: photograph cards on the table → resolve them → build 1-2 decks from what's there → save the session.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: KITCHEN_TABLE } }],
    }),
  );

  server.registerPrompt(
    "table-judge",
    {
      title: "Table judge",
      description: "Explain what a card does (photo or name, JP or EN) from verified card data, with a play example.",
    },
    () => ({
      messages: [{ role: "user", content: { type: "text", text: TABLE_JUDGE } }],
    }),
  );
}
