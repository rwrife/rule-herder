import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/parse.js";
import {
  buildDriftReport,
  jaccard,
  blockKey,
} from "../src/match.js";

describe("jaccard", () => {
  it("returns 1 for identical strings", () => {
    expect(jaccard("a b c", "a b c")).toBe(1);
  });
  it("returns 0 for fully disjoint sets", () => {
    expect(jaccard("a b", "c d")).toBe(0);
  });
  it("returns 1 for two empty bodies", () => {
    expect(jaccard("", "")).toBe(1);
  });
  it("returns 0 when only one side is empty", () => {
    expect(jaccard("", "a")).toBe(0);
  });
  it("computes partial overlap", () => {
    // {a,b,c} vs {b,c,d}: inter=2, union=4 -> 0.5
    expect(jaccard("a b c", "b c d")).toBeCloseTo(0.5, 5);
  });
});

describe("blockKey", () => {
  it("keys heading blocks by lowercased joined path", () => {
    const [block] = parseBlocks("X.md", "## Top\n### Sub\nbody\n");
    // The second block has path [Top, Sub]
    const [, sub] = parseBlocks("X.md", "## Top\n### Sub\nbody\n");
    expect(blockKey(sub)).toBe("top > sub");
  });
  it("keys plain/preamble blocks by ~plain:<first words>", () => {
    const [b] = parseBlocks("X.md", "first line here\nmore\n");
    expect(blockKey(b).startsWith("~plain:")).toBe(true);
  });
});

describe("buildDriftReport", () => {
  function parse(source: string, content: string) {
    return { source, blocks: parseBlocks(source, content) };
  }

  it("classifies an aligned group when all bodies are identical", () => {
    const a = parse("a.md", "# Rules\n- one\n- two\n");
    const b = parse("b.md", "# Rules\n- one\n- two\n");
    const report = buildDriftReport([a, b]);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].status).toBe("aligned");
    expect(report.groups[0].score).toBe(0);
    expect(report.overall).toBe(0);
  });

  it("classifies a reworded group when bodies differ but are similar", () => {
    const a = parse("a.md", "# Rules\nbe kind to humans always and forever\n");
    const b = parse("b.md", "# Rules\nbe kind to humans always and consistently\n");
    const report = buildDriftReport([a, b]);
    expect(report.groups[0].status).toBe("reworded");
    expect(report.groups[0].score).toBeGreaterThan(0);
    expect(report.groups[0].score).toBeLessThan(0.5);
  });

  it("classifies a conflict when bodies are substantially different", () => {
    const a = parse("a.md", "# Rules\nalways use tabs for indent\n");
    const b = parse("b.md", "# Rules\nprefer spaces and run prettier\n");
    const report = buildDriftReport([a, b]);
    expect(report.groups[0].status).toBe("conflict");
    expect(report.groups[0].score).toBeGreaterThan(0.4);
  });

  it("marks a group as missing when only one source carries it", () => {
    const a = parse("a.md", "# Only Here\nbody\n");
    const b = parse("b.md", "# Other\nbody\n");
    const report = buildDriftReport([a, b]);
    const onlyHere = report.groups.find((g) => g.key === "only here")!;
    expect(onlyHere.status).toBe("missing");
    expect(onlyHere.missingFrom).toEqual(["b.md"]);
    // coveragePenalty = 0.5, bodyPenalty = 0 -> score = 0.25
    expect(onlyHere.score).toBeCloseTo(0.25, 5);
  });

  it("tracks missingFrom even when present-members are aligned", () => {
    const a = parse("a.md", "# Shared\nbody\n");
    const b = parse("b.md", "# Shared\nbody\n");
    const c = parse("c.md", "# Other\nelse\n");
    const report = buildDriftReport([a, b, c]);
    const shared = report.groups.find((g) => g.key === "shared")!;
    expect(shared.status).toBe("aligned");
    expect(shared.missingFrom).toEqual(["c.md"]);
    // coveragePenalty = 1 - 2/3 = 1/3, bodyPenalty = 0 -> ~0.1667
    expect(shared.score).toBeCloseTo(1 / 6, 4);
  });

  it("emits a pairwise score for every distinct pair of sources", () => {
    const a = parse("a.md", "# Rules\nfoo\n");
    const b = parse("b.md", "# Rules\nfoo\n");
    const c = parse("c.md", "# Rules\nbar\n");
    const report = buildDriftReport([a, b, c]);
    expect(report.pairs).toHaveLength(3);
    const ab = report.pairs.find((p) => p.a === "a.md" && p.b === "b.md")!;
    const ac = report.pairs.find((p) => p.a === "a.md" && p.b === "c.md")!;
    expect(ab.score).toBe(0);
    expect(ac.score).toBe(1);
  });

  it("returns an empty report for empty input", () => {
    const report = buildDriftReport([]);
    expect(report.sources).toEqual([]);
    expect(report.groups).toEqual([]);
    expect(report.pairs).toEqual([]);
    expect(report.overall).toBe(0);
  });

  it("ignores duplicate keys within a single source", () => {
    // Two `## Rules` headings in the same file should only contribute once.
    const a = parse(
      "a.md",
      "## Rules\nfirst body\n## Rules\nsecond body\n",
    );
    const b = parse("b.md", "## Rules\nfirst body\n");
    const report = buildDriftReport([a, b]);
    const rules = report.groups.find((g) => g.key === "rules")!;
    expect(rules.members).toHaveLength(2);
    expect(rules.status).toBe("aligned");
  });

  it("respects a custom rewordedThreshold", () => {
    const a = parse("a.md", "# Rules\nalpha beta gamma delta\n");
    const b = parse("b.md", "# Rules\nalpha beta gamma epsilon\n");
    // Default threshold (0.6) would call this reworded; raise it past actual sim.
    const strict = buildDriftReport([a, b], { rewordedThreshold: 0.99 });
    expect(strict.groups[0].status).toBe("conflict");
    const loose = buildDriftReport([a, b], { rewordedThreshold: 0.1 });
    expect(loose.groups[0].status).toBe("reworded");
  });

  it("collapses heading aliases into a single group", () => {
    const a = parse("a.md", "## Rules\nbe nice\n");
    const b = parse("b.md", "## Guidelines\nbe nice\n");
    const noAlias = buildDriftReport([a, b]);
    expect(noAlias.groups).toHaveLength(2);

    const aliased = buildDriftReport([a, b], {
      aliases: { rules: ["guidelines"] },
    });
    expect(aliased.groups).toHaveLength(1);
    expect(aliased.groups[0].key).toBe("rules");
    expect(aliased.groups[0].status).toBe("aligned");
  });
});
