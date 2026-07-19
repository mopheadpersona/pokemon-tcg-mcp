import { describe, expect, it } from "vitest";

import {
  buildEffectQuery,
  buildQuery,
  extractKeywords,
  looksLikeLucene,
  quoteValue,
  standardClause,
  textContainsClause,
} from "../src/qbuilder.js";

const MARKS = ["H", "I", "J"];

describe("looksLikeLucene", () => {
  it("detects field:value syntax", () => {
    expect(looksLikeLucene("name:jacinthe")).toBe(true);
    expect(looksLikeLucene("supertype:trainer subtypes:supporter")).toBe(true);
    expect(looksLikeLucene("-subtypes:item hp:[100 TO *]")).toBe(true);
  });

  it("detects boolean operators", () => {
    expect(looksLikeLucene("charizard OR blastoise")).toBe(true);
  });

  it("treats plain names as free text", () => {
    expect(looksLikeLucene("jacinthe")).toBe(false);
    expect(looksLikeLucene("Boss's Orders")).toBe(false);
  });
});

describe("quoteValue", () => {
  it("leaves single safe tokens bare", () => {
    expect(quoteValue("jacinthe")).toBe("jacinthe");
    expect(quoteValue("char*")).toBe("char*");
  });

  it("quotes multi-word values", () => {
    expect(quoteValue("boss's orders")).toBe("\"boss's orders\"");
    expect(quoteValue("ACE SPEC")).toBe('"ACE SPEC"');
  });

  it("strips embedded double quotes", () => {
    expect(quoteValue('a "b" c')).toBe('"a b c"');
  });
});

describe("buildQuery", () => {
  it("builds a name clause from free text", () => {
    expect(buildQuery({ query: "jacinthe" })).toBe("name:jacinthe");
    expect(buildQuery({ query: "Boss's Orders" })).toBe("name:\"Boss's Orders\"");
  });

  it("passes raw Lucene through wrapped in parens", () => {
    expect(buildQuery({ query: "supertype:trainer subtypes:supporter" })).toBe(
      "(supertype:trainer subtypes:supporter)",
    );
  });

  it("ANDs filters onto the query", () => {
    const q = buildQuery({
      query: "psyduck",
      supertype: "pokemon",
      types: ["Water"],
      subtypes: ["Basic"],
    });
    expect(q).toBe("name:psyduck supertype:pokemon subtypes:Basic types:Water");
  });

  it("quotes multi-word subtypes like ACE SPEC", () => {
    expect(buildQuery({ subtypes: ["ACE SPEC"] })).toBe('subtypes:"ACE SPEC"');
  });

  it("adds a text_contains clause across all text fields", () => {
    expect(buildQuery({ textContains: "knock out itself" })).toBe(
      '(attacks.text:"knock out itself" OR abilities.text:"knock out itself" OR rules:"knock out itself")',
    );
  });

  it("appends the regulation-mark standard clause with a basic-energy escape hatch", () => {
    const q = buildQuery({ query: "jacinthe", standardLegalOnly: true, legalMarks: MARKS });
    expect(q).toBe(
      "name:jacinthe (regulationMark:H OR regulationMark:I OR regulationMark:J OR (supertype:energy subtypes:basic))",
    );
  });

  it("omits the standard clause when disabled or without marks", () => {
    expect(buildQuery({ query: "jacinthe", standardLegalOnly: false, legalMarks: MARKS })).toBe("name:jacinthe");
    expect(buildQuery({ query: "jacinthe", standardLegalOnly: true, legalMarks: [] })).toBe("name:jacinthe");
  });

  it("returns empty string for no input", () => {
    expect(buildQuery({})).toBe("");
  });
});

describe("standardClause / textContainsClause", () => {
  it("ORs each legal mark", () => {
    expect(standardClause(["I", "J"])).toBe(
      "(regulationMark:I OR regulationMark:J OR (supertype:energy subtypes:basic))",
    );
  });

  it("quotes phrases in text clauses", () => {
    expect(textContainsClause("heal 150")).toBe(
      '(attacks.text:"heal 150" OR abilities.text:"heal 150" OR rules:"heal 150")',
    );
  });
});

describe("extractKeywords", () => {
  it("drops stopwords and stems suffixes", () => {
    expect(extractKeywords("heal damage from benched pokemon")).toEqual(["heal", "damage", "bench"]);
  });

  it("keeps numbers", () => {
    expect(extractKeywords("draw 3 cards")).toEqual(["draw", "3"]);
  });

  it("dedupes stems", () => {
    expect(extractKeywords("healing heals heal")).toEqual(["heal"]);
  });

  it("returns empty for pure-stopword input", () => {
    expect(extractKeywords("from your the of")).toEqual([]);
  });
});

describe("buildEffectQuery", () => {
  it("ORs wildcarded keywords across attacks, abilities and rules", () => {
    expect(buildEffectQuery(["heal", "bench"])).toBe(
      "(attacks.text:heal* OR abilities.text:heal* OR rules:heal* OR " +
        "attacks.text:bench* OR abilities.text:bench* OR rules:bench*)",
    );
  });

  it("does not wildcard bare numbers", () => {
    expect(buildEffectQuery(["150"])).toBe("(attacks.text:150 OR abilities.text:150 OR rules:150)");
  });
});
