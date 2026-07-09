import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/parse.js";
import { buildDriftReport, type DriftReport } from "../src/match.js";
import { renderHtml, renderMarkdown } from "../src/render.js";

function fixtureReport(): DriftReport {
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

/**
 * Cheap HTML→summary parser used to spot-check the rendered artifact without
 * pulling in a heavyweight jsdom dependency. Extracts the counts printed in
 * the summary cards so we can prove `renderHtml` reflects `DriftReport`.
 */
function parseSummary(html: string): Record<string, number> {
  const re =
    /<div class="label">([^<]+)<\/div><div class="value"(?:[^>]*)>(?:<[^>]+>)*([\d.]+)/g;
  const out: Record<string, number> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out[m[1].trim()] = Number(m[2]);
  }
  return out;
}

describe("renderMarkdown", () => {
  it("emits a stable markdown snapshot for a typical report", () => {
    const md = renderMarkdown(fixtureReport(), {
      threshold: 0.2,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    // Snapshot the whole thing — this is the canary that catches accidental
    // format churn (see acceptance criteria).
    expect(md).toMatchInlineSnapshot(`
      "# 🐕 rule-herder drift report

      _Generated at 2026-07-08T00:00:00.000Z._

      ## Summary

      - **Overall drift:** 0.20 (threshold 0.20)
      - **Files:** 2
      - **Blocks:** 4
      - **By status:** 1 conflict · 0 reworded · 2 missing · 1 aligned

      ## Files

      | # | File |
      | --- | --- |
      | 1 | \`AGENTS.md\` |
      | 2 | \`CLAUDE.md\` |

      ## Pairwise drift

      | A | B | Score |
      | --- | --- | --- |
      | \`AGENTS.md\` | \`CLAUDE.md\` | 0.65 |

      ## Drift groups

      ### ✗ Conflict (1)

      #### Rules › Style

      - **score:** 0.30 · **sources:** 2/2

      - \`AGENTS.md\` — lines 2-3

      \`\`\`
      use two spaces
      \`\`\`
      - \`CLAUDE.md\` — lines 2-3

      \`\`\`
      use 2 spaces always
      \`\`\`

      ### ? Missing (2)

      #### Rules › Safety

      - **score:** 0.25 · **sources:** 1/2
      - **missing from:** \`CLAUDE.md\`

      - \`AGENTS.md\` — lines 4-6

      \`\`\`
      no destructive ops
      \`\`\`

      #### Rules › Tests

      - **score:** 0.25 · **sources:** 1/2
      - **missing from:** \`AGENTS.md\`

      - \`CLAUDE.md\` — lines 4-6

      \`\`\`
      run vitest
      \`\`\`

      "
    `);
  });

  it("hides aligned groups unless --include-aligned is passed", () => {
    const md = renderMarkdown(fixtureReport(), {
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(md).not.toMatch(/### ✓ Aligned/);
    const mdAll = renderMarkdown(fixtureReport(), {
      generatedAt: "2026-07-08T00:00:00.000Z",
      includeAligned: true,
    });
    expect(mdAll).toMatch(/### ✓ Aligned/);
    expect(mdAll).toMatch(/#### Rules$/m);
  });

  it("uses longer fences when the body contains backticks", () => {
    const blocks = parseBlocks(
      "AGENTS.md",
      "# Rules\n## Style\nuse ```triple``` fences\n",
    );
    const other = parseBlocks(
      "CLAUDE.md",
      "# Rules\n## Style\ndo something different\n",
    );
    const report = buildDriftReport([
      { source: "AGENTS.md", blocks },
      { source: "CLAUDE.md", blocks: other },
    ]);
    const md = renderMarkdown(report, {
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    // We wrote a fence with 4+ backticks to escape the 3 backticks inside.
    expect(md).toMatch(/````\nuse ```triple``` fences\n````/);
  });

  it("prints an empty-state message when there is no drift and aligned is off", () => {
    const identical = parseBlocks(
      "AGENTS.md",
      "# Rules\n## Style\nuse two spaces\n",
    );
    const identical2 = parseBlocks(
      "CLAUDE.md",
      "# Rules\n## Style\nuse two spaces\n",
    );
    const report = buildDriftReport([
      { source: "AGENTS.md", blocks: identical },
      { source: "CLAUDE.md", blocks: identical2 },
    ]);
    const md = renderMarkdown(report, {
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(md).toMatch(/No drift — flock is aligned/);
  });
});

describe("renderHtml", () => {
  it("emits a single self-contained HTML document (no external assets)", () => {
    const html = renderHtml(fixtureReport(), {
      threshold: 0.2,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // Never emit external CSS or JS.
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+rel=/i);
    // Always inline the style block.
    expect(html).toMatch(/<style>/);
    // Basic structural markers.
    expect(html).toMatch(/rule-herder drift report/);
    expect(html).toMatch(/Generated at 2026-07-08T00:00:00\.000Z/);
  });

  it("summary cards reflect the report counts", () => {
    const html = renderHtml(fixtureReport(), {
      threshold: 0.2,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    // Smoke test that parses the artifact back and finds the summary counts.
    const summary = parseSummary(html);
    expect(summary.Files).toBe(2);
    expect(summary.Blocks).toBe(4);
    expect(summary.Conflicts).toBe(1);
    expect(summary.Missing).toBe(2);
    expect(summary.Aligned).toBe(1);
    // Overall drift is present.
    expect(summary["Overall drift"]).toBeCloseTo(0.2, 2);
  });

  it("escapes user-controlled content", () => {
    const evilBlocks = parseBlocks(
      "AGENTS.md",
      "# <script>alert(1)</script>\n## Style\n<img src=x onerror=alert(1)>\n",
    );
    const otherBlocks = parseBlocks(
      "CLAUDE.md",
      "# <script>alert(1)</script>\n## Style\ndifferent body\n",
    );
    const report = buildDriftReport([
      { source: "AGENTS.md", blocks: evilBlocks },
      { source: "CLAUDE.md", blocks: otherBlocks },
    ]);
    const html = renderHtml(report, {
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    // No unescaped script tag from user content should slip through.
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    expect(html).not.toMatch(/<img src=x onerror=/);
    expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it("hides aligned groups unless --include-aligned is passed", () => {
    const html = renderHtml(fixtureReport(), {
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(html).not.toMatch(/badge-aligned">✓ Aligned/);
    const htmlAll = renderHtml(fixtureReport(), {
      generatedAt: "2026-07-08T00:00:00.000Z",
      includeAligned: true,
    });
    expect(htmlAll).toMatch(/badge-aligned">✓ Aligned/);
  });

  it("handles an empty pasture without crashing", () => {
    const html = renderHtml(
      { sources: [], groups: [], pairs: [], overall: 0 },
      { generatedAt: "2026-07-08T00:00:00.000Z" },
    );
    expect(html).toMatch(/rule-herder drift report/);
    expect(html).toMatch(/No drift — flock is aligned/);
    expect(html).toMatch(/<pre>|<footer>/);
  });
});
