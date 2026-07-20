import { describe, expect, it } from "vitest";

import { classifyNameOnlyAdd, collectionSummary } from "../src/tools-collection.js";
import type { Resolution } from "../src/resolve.js";
import type { Card } from "../src/types.js";
import { psychicEnergy, slowbro, slowpoke } from "./fixtures.js";

const MARKS = ["H", "I", "J"];

function printing(base: Card, setId: string, ptcgoCode: string | undefined, number: string): Card {
  return { ...base, id: `${setId}-${number}`, number, set: { id: setId, name: setId, ptcgoCode } };
}

describe("classifyNameOnlyAdd", () => {
  const noCode = () => undefined;

  it("rejects an ambiguous name with the candidate printings, accepting nothing", () => {
    const printings = [printing(slowbro, "me5", "PBL", "30"), printing(slowbro, "me5", "PBL", "90")];
    const result = classifyNameOnlyAdd({ count: 1, name: "Slowbro" }, printings, noCode);
    expect(result.outcome).toBe("ambiguous");
    expect(result.spec).toBeUndefined();
    expect(result.candidates?.map((c) => c.number)).toEqual(["30", "90"]);
  });

  it("accepts a unique printing with its set code and number", () => {
    const result = classifyNameOnlyAdd({ count: 2, name: "Slowpoke" }, [printing(slowpoke, "me5", "PBL", "29")], noCode);
    expect(result.outcome).toBe("accepted");
    expect(result.spec).toMatchObject({ count: 2, name: "Slowpoke", setCode: "PBL", number: "29" });
  });

  it("recovers the set code from the resolver when the embedded ptcgoCode is missing", () => {
    const result = classifyNameOnlyAdd(
      { count: 1, name: "Slowpoke" },
      [printing(slowpoke, "me5", undefined, "29")],
      (setId) => (setId === "me5" ? "PBL" : undefined),
    );
    expect(result.outcome).toBe("accepted");
    expect(result.spec).toMatchObject({ setCode: "PBL", number: "29" });
  });

  it("falls back to a name-only spec when no set code can be found anywhere", () => {
    const result = classifyNameOnlyAdd({ count: 1, name: "Slowpoke" }, [printing(slowpoke, "me5", undefined, "29")], noCode);
    expect(result.outcome).toBe("accepted");
    expect(result.spec).toMatchObject({ count: 1, name: "Slowpoke" });
    expect(result.spec?.setCode).toBeUndefined();
  });

  it("reports not-found when nothing matches the exact name", () => {
    const result = classifyNameOnlyAdd({ count: 1, name: "Slowpoke" }, [printing(slowbro, "me5", "PBL", "30")], noCode);
    expect(result.outcome).toBe("not-found");
  });

  it("ignores near-miss names — only exact (normalized) matches count", () => {
    const galarian = { ...slowpoke, name: "Galarian Slowpoke" };
    const result = classifyNameOnlyAdd({ count: 1, name: "Slowpoke" }, [printing(galarian, "swsh1", "SSH", "1")], noCode);
    expect(result.outcome).toBe("not-found");
  });
});

describe("collectionSummary", () => {
  it("counts total cards, unique names and standard-legal copies (unresolved excluded from legal)", () => {
    const res = (count: number, name: string, card?: Card): Resolution => ({
      entry: { count, name, line: 1, raw: `${count} ${name}` },
      card,
      notes: [],
    });
    const rotated = { ...slowbro, regulationMark: "F" };
    const summary = collectionSummary(
      [
        res(4, "Slowpoke", slowpoke), // legal (reg J)
        res(2, "Slowbro", rotated), // rotated — not standard legal
        res(3, "Mystery Card"), // unresolved
        res(1, "Slowpoke", slowpoke), // second printing line, same name
        res(10, "Basic Psychic Energy", psychicEnergy), // basic energy always legal
      ],
      MARKS,
    );
    expect(summary.totalCards).toBe(20);
    expect(summary.uniqueNames).toBe(4);
    expect(summary.legalCopies).toBe(15);
  });
});
