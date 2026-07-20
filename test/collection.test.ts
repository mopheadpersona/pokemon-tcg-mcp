import { describe, expect, it } from "vitest";

import {
  addToCollectionText,
  formatLine,
  parseCollection,
  removeFromCollectionText,
} from "../src/collection.js";

const SAMPLE = `# my binder, sorted 2026-07
Pokémon:
4 Slowpoke PBL 29
2 Slowbro PBL 30

# pulls from the POR box
4 Jacinthe POR 75
1 Jacinthe POR 110

Energy:
20 Basic Psychic Energy SVE 5
`;

describe("parseCollection", () => {
  it("parses card lines, skipping comments and section headers silently", () => {
    const parsed = parseCollection(SAMPLE);
    expect(parsed.entries.map((e) => e.name)).toEqual([
      "Slowpoke",
      "Slowbro",
      "Jacinthe",
      "Jacinthe",
      "Basic Psychic Energy",
    ]);
    expect(parsed.entries[0]).toMatchObject({ count: 4, setCode: "PBL", number: "29" });
    expect(parsed.warnings).toHaveLength(0);
  });

  it("warns about junk lines without dropping the rest", () => {
    const parsed = parseCollection("4 Slowpoke PBL 29\nnot a card at all\n2 Slowbro PBL 30");
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.warnings.some((w) => w.includes("not a card"))).toBe(true);
  });

  it("ignores inline comments after a card line", () => {
    const parsed = parseCollection("4 Slowpoke PBL 29 # damaged corners");
    expect(parsed.entries[0]).toMatchObject({ count: 4, name: "Slowpoke", setCode: "PBL", number: "29" });
  });
});

describe("formatLine", () => {
  it("renders the TCG Live line format", () => {
    expect(formatLine({ count: 4, name: "Slowpoke", setCode: "PBL", number: "29" })).toBe("4 Slowpoke PBL 29");
    expect(formatLine({ count: 20, name: "Basic Psychic Energy" })).toBe("20 Basic Psychic Energy");
  });
});

describe("addToCollectionText", () => {
  it("increments an existing matching line in place", () => {
    const { text } = addToCollectionText(SAMPLE, [{ count: 2, name: "Slowpoke", setCode: "PBL", number: "29" }]);
    expect(text).toContain("6 Slowpoke PBL 29");
    expect(text).not.toContain("4 Slowpoke PBL 29");
  });

  it("appends a new line for a card not yet in the collection", () => {
    const { text } = addToCollectionText(SAMPLE, [{ count: 3, name: "Iono", setCode: "PAL", number: "185" }]);
    expect(text).toContain("3 Iono PAL 185");
  });

  it("preserves comments, blank lines and section headers byte-for-byte", () => {
    const { text } = addToCollectionText(SAMPLE, [{ count: 1, name: "Slowbro", setCode: "PBL", number: "30" }]);
    expect(text).toContain("# my binder, sorted 2026-07");
    expect(text).toContain("# pulls from the POR box");
    expect(text).toContain("Pokémon:");
    expect(text).toContain("3 Slowbro PBL 30");
  });

  it("matches printings by set + number, not just name", () => {
    const { text } = addToCollectionText(SAMPLE, [{ count: 1, name: "Jacinthe", setCode: "POR", number: "110" }]);
    expect(text).toContain("4 Jacinthe POR 75");
    expect(text).toContain("2 Jacinthe POR 110");
  });
});

describe("removeFromCollectionText", () => {
  it("decrements a matching line", () => {
    const { text } = removeFromCollectionText(SAMPLE, [{ count: 1, name: "Slowpoke", setCode: "PBL", number: "29" }]);
    expect(text).toContain("3 Slowpoke PBL 29");
  });

  it("drops the line entirely at zero", () => {
    const { text } = removeFromCollectionText(SAMPLE, [{ count: 2, name: "Slowbro", setCode: "PBL", number: "30" }]);
    expect(text).not.toContain("Slowbro");
    expect(text).toContain("4 Slowpoke PBL 29");
  });

  it("clamps over-removal with a note", () => {
    const { text, notes } = removeFromCollectionText(SAMPLE, [
      { count: 99, name: "Slowbro", setCode: "PBL", number: "30" },
    ]);
    expect(text).not.toContain("Slowbro");
    expect(notes.some((n) => n.includes("only 2"))).toBe(true);
  });

  it("removes by bare name when exactly one printing matches", () => {
    const { text } = removeFromCollectionText(SAMPLE, [{ count: 1, name: "Slowpoke" }]);
    expect(text).toContain("3 Slowpoke PBL 29");
  });

  it("refuses an ambiguous bare-name removal and lists the candidates", () => {
    const { text, notes } = removeFromCollectionText(SAMPLE, [{ count: 1, name: "Jacinthe" }]);
    expect(text).toContain("4 Jacinthe POR 75");
    expect(text).toContain("1 Jacinthe POR 110");
    const note = notes.find((n) => n.toLowerCase().includes("ambiguous"));
    expect(note).toBeDefined();
    expect(note).toContain("POR 75");
    expect(note).toContain("POR 110");
  });

  it("notes a removal that matches nothing", () => {
    const { text, notes } = removeFromCollectionText(SAMPLE, [{ count: 1, name: "Pikachu" }]);
    expect(text).toBe(SAMPLE);
    expect(notes.some((n) => n.includes("Pikachu"))).toBe(true);
  });

  it("treats duplicate lines of the SAME printing as one stack, not an ambiguity", () => {
    const dupes = "2 Slowpoke PBL 29\n1 Slowpoke PBL 29\n";
    const { text, notes } = removeFromCollectionText(dupes, [{ count: 3, name: "Slowpoke", setCode: "PBL", number: "29" }]);
    expect(text).not.toContain("Slowpoke");
    expect(notes.some((n) => n.toLowerCase().includes("ambiguous"))).toBe(false);
  });

  it("can remove from a bare-number line that parses with a warning", () => {
    const { text } = removeFromCollectionText("4 Slowpoke 29\n", [{ count: 1, name: "Slowpoke" }]);
    expect(text).toContain("3 Slowpoke");
  });
});

describe("file fidelity", () => {
  it("preserves CRLF line endings on mutation", () => {
    const crlf = "4 Slowpoke PBL 29\r\n# note\r\n";
    const { text } = addToCollectionText(crlf, [{ count: 1, name: "Slowpoke", setCode: "PBL", number: "29" }]);
    expect(text).toContain("5 Slowpoke PBL 29\r\n");
    expect(text).toContain("# note\r\n");
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it("ignores zero-count additions instead of writing '0 X' lines", () => {
    const { text, notes } = addToCollectionText(SAMPLE, [{ count: 0, name: "Iono", setCode: "PAL", number: "185" }]);
    expect(text).toBe(SAMPLE);
    expect(notes.some((n) => n.toLowerCase().includes("ignored"))).toBe(true);
  });
});
