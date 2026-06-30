import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/parse.js";
import { buildDriftReport } from "../src/match.js";
import type { DriftGroup } from "../src/match.js";
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
import { renderWoof } from "../src/report.js";

describe("renderWoof", () => {
  it("contented woof on an empty pasture", () => {
    const line = renderWoof({ sources: [], groups: [], pairs: [], overall: 0 });
    expect(line).toMatch(/tail wags faintly/);
  });

  it("contented woof when everything is aligned", () => {
    const a = parseBlocks("AGENTS.md", "# Rules\n## Style\nuse two spaces\n");
    const b = parseBlocks("CLAUDE.md", "# Rules\n## Style\nuse two spaces\n");
    const report = buildDriftReport([
      { source: "AGENTS.md", blocks: a },
      { source: "CLAUDE.md", blocks: b },
    ]);
    expect(renderWoof(report)).toMatch(/contented woof/);
  });

  it("escalates as drift climbs", () => {
    const mk = (overall: number) =>
      renderWoof({
        sources: ["a", "b"],
        groups: [
          {
            key: "k",
            headingPath: ["x"],
            status: "conflict",
            score: overall,
            members: [],
            missingFrom: [],
          } as unknown as DriftGroup,
        ],
        pairs: [],
        overall,
      });
    expect(mk(0.1)).toMatch(/light boof/);
    expect(mk(0.25)).toMatch(/bark!/);
    expect(mk(0.5)).toMatch(/BARK BARK/);
    expect(mk(0.7)).toMatch(/GROWL/);
    expect(mk(0.95)).toMatch(/AWOOOOO/);
  });

  it("is appended to renderHuman when --woof is set", () => {
    const out = renderHuman(sampleReport(), {
      noColor: true,
      threshold: 0.2,
      woof: true,
    });
    expect(out).toMatch(/Overall drift:/);
    // last non-empty line should be the woof commentary
    const lines = out.trim().split("\n");
    expect(lines[lines.length - 1]).toMatch(/(woof|bark|growl|awooooo|boof)/i);
  });

  it("is omitted from renderHuman by default", () => {
    const out = renderHuman(sampleReport(), { noColor: true, threshold: 0.2 });
    expect(out).not.toMatch(/woof|bark|growl|awooooo|boof/i);
  });
});
