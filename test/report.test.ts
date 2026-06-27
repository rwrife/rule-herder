import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/parse.js";
import { buildDriftReport } from "../src/match.js";
import { renderHuman, renderJson } from "../src/report.js";

function sampleReport() {
  const a = parseBlocks(
    "AGENTS.md",
    "# Rules\n## Style\nuse two spaces\n## Safety\nno destructive ops\n",
  );
  const b = parseBlocks(
    "CLAUDE.md",
    "# Rules\n## Style\nuse 2 spaces always\n## Tests\nrun vitest\n",
  );
  return buildDriftReport([
    { source: "AGENTS.md", blocks: a },
    { source: "CLAUDE.md", blocks: b },
  ]);
}

describe("renderHuman", () => {
  it("snapshots a typical report with color disabled", () => {
    const out = renderHuman(sampleReport(), { noColor: true, threshold: 0.2 });
    expect(out).toMatchInlineSnapshot(`
      "🐕 rule-herder diff — 2 files, 4 blocks
        • AGENTS.md
        • CLAUDE.md

      Blocks:
        ✓ Rules — aligned · score 0.00 · 2/2 sources
        ✗ Rules › Style — conflict · score 0.30 · 2/2 sources
        ? Rules › Safety — missing · score 0.25 · 1/2 sources · missing: CLAUDE.md
        ? Rules › Tests — missing · score 0.25 · 1/2 sources · missing: AGENTS.md

      Pairwise drift:
        AGENTS.md ↔ CLAUDE.md — 0.65

      Overall drift: 0.20 (threshold 0.20)
      "
    `);
  });

  it("handles an empty pasture", () => {
    const out = renderHuman(
      { sources: [], groups: [], pairs: [], overall: 0 },
      { noColor: true },
    );
    expect(out).toMatch(/pasture is empty/);
  });
});

describe("renderJson", () => {
  it("emits a stable, threshold-aware shape", () => {
    const json = JSON.parse(renderJson(sampleReport(), { threshold: 0.2 }));
    expect(json.sources).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(typeof json.overall).toBe("number");
    expect(json.threshold).toBe(0.2);
    expect(json.exceedsThreshold).toBe(json.overall > 0.2);
    expect(Array.isArray(json.groups)).toBe(true);
    const style = json.groups.find((g: { key: string }) =>
      g.key.includes("style"),
    );
    expect(["reworded", "conflict"]).toContain(style.status);
    expect(style.members).toHaveLength(2);
    expect(typeof style.members[0].startLine).toBe("number");
    expect(json.pairs).toEqual([
      expect.objectContaining({ a: "AGENTS.md", b: "CLAUDE.md" }),
    ]);
  });

  it("reports null threshold when none provided", () => {
    const json = JSON.parse(renderJson(sampleReport()));
    expect(json.threshold).toBeNull();
    expect(json.exceedsThreshold).toBe(false);
  });
});
