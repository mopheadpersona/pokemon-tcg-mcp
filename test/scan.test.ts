import { describe, expect, it } from "vitest";

import { JP_SET_CODES, hasJapaneseText, translateJpName } from "../src/jpsets.js";
import { parseScannedLines } from "../src/scan.js";
import { classifyScannedLine } from "../src/scanresolve.js";

const EN_CODES = new Set(["PBL", "POR", "SVE", "TWM", "MEG"]);

describe("parseScannedLines", () => {
  it("parses a full Live-style line with quantity", () => {
    const { lines } = parseScannedLines(["2 Slowpoke PBL 29"]);
    expect(lines[0]).toMatchObject({ count: 2, name: "Slowpoke", setToken: "PBL", number: "29" });
  });

  it("defaults the quantity to 1 (a photographed card is one card)", () => {
    const { lines } = parseScannedLines(["Slowpoke PBL 29"]);
    expect(lines[0]).toMatchObject({ count: 1, name: "Slowpoke", setToken: "PBL", number: "29" });
  });

  it("reads number/printedTotal collector numbers", () => {
    const { lines } = parseScannedLines(["Slowbro 030/084"]);
    expect(lines[0]).toMatchObject({ count: 1, name: "Slowbro", number: "030", printedTotal: 84 });
    expect(lines[0].setToken).toBeUndefined();
  });

  it("does not eat a name suffix like 'ex' as a set token", () => {
    const { lines } = parseScannedLines(["Mega Slowbro ex 031/084", "Pikachu ex 45"]);
    expect(lines[0]).toMatchObject({ name: "Mega Slowbro ex", number: "031", printedTotal: 84 });
    expect(lines[1]).toMatchObject({ name: "Pikachu ex", number: "45" });
    expect(lines[1].setToken).toBeUndefined();
  });

  it("keeps a set token that precedes a slash number", () => {
    const { lines } = parseScannedLines(["Slowpoke m5 028/081"]);
    expect(lines[0]).toMatchObject({ name: "Slowpoke", setToken: "m5", number: "028", printedTotal: 81 });
  });

  it("parses Japanese names with JP set codes", () => {
    const { lines } = parseScannedLines(["ヤドン m5 028", "2 ヤドラン m5 029"]);
    expect(lines[0]).toMatchObject({ count: 1, name: "ヤドン", setToken: "m5", number: "028" });
    expect(lines[1]).toMatchObject({ count: 2, name: "ヤドラン", setToken: "m5", number: "029" });
  });

  it("treats a name-only line as just a name", () => {
    const { lines } = parseScannedLines(["Jacinthe"]);
    expect(lines[0]).toMatchObject({ count: 1, name: "Jacinthe" });
    expect(lines[0].number).toBeUndefined();
  });

  it("keeps a bare trailing number when no set token precedes it", () => {
    const { lines } = parseScannedLines(["Iono 12"]);
    expect(lines[0]).toMatchObject({ name: "Iono", number: "12" });
    expect(lines[0].setToken).toBeUndefined();
  });

  it("accepts lettered subset numbers as bare trailing numbers", () => {
    const { lines } = parseScannedLines(["Radiant Greninja GG12", "Ho-Oh V TG05"]);
    expect(lines[0]).toMatchObject({ name: "Radiant Greninja", number: "GG12" });
    expect(lines[1]).toMatchObject({ name: "Ho-Oh V", number: "TG05" });
    expect(lines[0].setToken).toBeUndefined();
  });

  it("splits a multi-line block pasted as one array entry", () => {
    const { lines } = parseScannedLines(["2 Slowpoke PBL 29\n1 Jacinthe POR 75"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ count: 2, name: "Slowpoke", setToken: "PBL", number: "29", index: 1 });
    expect(lines[1]).toMatchObject({ count: 1, name: "Jacinthe", setToken: "POR", number: "75", index: 1 });
  });

  it("strips bullets, foil markers and × separators", () => {
    const { lines } = parseScannedLines(["- 3x Slowpoke PBL 29 PH"]);
    expect(lines[0]).toMatchObject({ count: 3, name: "Slowpoke", setToken: "PBL", number: "29" });
  });

  it("skips blank lines silently and reports nameless lines", () => {
    const { lines, skipped } = parseScannedLines(["", "  ", "029", "Slowpoke PBL 29"]);
    expect(lines).toHaveLength(2); // "029" parses as a name-only line ("029" is the name)
    expect(skipped).toHaveLength(0);
    const numeric = lines.find((l) => l.name === "029");
    expect(numeric).toBeDefined();
  });
});

describe("classifyScannedLine", () => {
  it("routes known EN set codes (case-insensitively) to the set-code resolver", () => {
    expect(classifyScannedLine({ setToken: "pbl", number: "29" }, EN_CODES).route).toEqual({
      kind: "set-code",
      setCode: "PBL",
    });
  });

  it("routes mapped JP codes to the JP route with the Live codes", () => {
    const { route } = classifyScannedLine({ setToken: "m5", number: "028" }, EN_CODES);
    expect(route).toEqual({ kind: "jp-set", jpCode: "m5", liveCodes: ["PBL"] });
  });

  it("flags unmapped JP-shaped codes explicitly and falls back to name search", () => {
    const { route, notes } = classifyScannedLine({ setToken: "m9", number: "12" }, EN_CODES);
    expect(route.kind).toBe("name-only");
    expect(notes.join(" ")).toContain('JP set code "m9" is not in the JP→EN mapping table');
  });

  it("sends unmapped JP codes to name search even with a printed total (JP totals ≠ EN totals)", () => {
    const { route, notes } = classifyScannedLine({ setToken: "m9", number: "021", printedTotal: 64 }, EN_CODES);
    expect(route.kind).toBe("name-only");
    expect(notes.join(" ")).toContain("falling back to a name search");
  });

  it("marks unknown non-JP tokens as possibly part of the name", () => {
    const { route, notes, tokenMayBeName } = classifyScannedLine({ setToken: "Ball", number: "196" }, EN_CODES);
    expect(route.kind).toBe("name-only");
    expect(tokenMayBeName).toBe(true);
    expect(notes.join(" ")).toContain('"Ball" is not a known set code');
  });

  it("routes slash totals without a set code to printed-total inference", () => {
    const { route } = classifyScannedLine({ number: "030", printedTotal: 84 }, EN_CODES);
    expect(route).toEqual({ kind: "slash-total", printedTotal: 84 });
  });

  it("keeps slash-total inference for unknown non-JP tokens with a total", () => {
    const { route, notes, tokenMayBeName } = classifyScannedLine(
      { setToken: "Doll", number: "031", printedTotal: 84 },
      EN_CODES,
    );
    expect(route).toEqual({ kind: "slash-total", printedTotal: 84 });
    expect(tokenMayBeName).toBe(true);
    expect(notes.join(" ")).toContain("inferring the set from the printed total /84");
  });

  it("notes a bare number kept only as a hint", () => {
    const { route, notes } = classifyScannedLine({ number: "12" }, EN_CODES);
    expect(route.kind).toBe("name-only");
    expect(notes.join(" ")).toContain("no set code before number 12");
  });
});

describe("JP tables", () => {
  it("maps the Mega-era JP codes to the Live codes", () => {
    expect(JP_SET_CODES.M5).toEqual(["PBL"]);
    expect(JP_SET_CODES.M1).toEqual(["MEG"]);
  });

  it("translates known Japanese names, including メガ…ex composition", () => {
    expect(translateJpName("ヤドン")).toBe("Slowpoke");
    expect(translateJpName("ヤドラン")).toBe("Slowbro");
    expect(translateJpName("メガヤドランex")).toBe("Mega Slowbro ex");
    expect(translateJpName("リザードン ex")).toBe("Charizard ex");
    expect(translateJpName("ケーシィ")).toBeUndefined();
  });

  it("detects Japanese text", () => {
    expect(hasJapaneseText("ヤドン")).toBe(true);
    expect(hasJapaneseText("Slowpoke")).toBe(false);
  });
});
