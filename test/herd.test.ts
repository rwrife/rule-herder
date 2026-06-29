import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBlocks } from "../src/parse.js";
import { buildDriftReport } from "../src/match.js";
import { planHerd, applyHerd, summarizePlan } from "../src/herd.js";

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "rule-herder-herd-"));
}

async function writeFile(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function read(dir: string, rel: string): Promise<string> {
  return fs.readFile(path.join(dir, rel), "utf8");
}

async function reportFor(dir: string, files: string[]) {
  const inputs = await Promise.all(
    files.map(async (rel) => ({
      source: rel,
      blocks: parseBlocks(rel, await read(dir, rel)),
    })),
  );
  return buildDriftReport(inputs);
}

describe("planHerd", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmp();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("plans nothing when sources are aligned", async () => {
    await writeFile(dir, "A.md", "## Rules\nbe nice\n");
    await writeFile(dir, "B.md", "## Rules\nbe nice\n");
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, { cwd: dir });
    expect(plan.replacements).toHaveLength(0);
    expect(plan.skipped.some((s) => s.reason === "aligned")).toBe(true);
  });

  it("picks the longest block as winner and rewrites losers", async () => {
    await writeFile(dir, "A.md", "## Rules\nshort\n");
    await writeFile(
      dir,
      "B.md",
      "## Rules\nlonger and more thorough rule body here\n",
    );
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, { cwd: dir, pick: { kind: "longest" } });
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0].target).toBe("A.md");
    expect(plan.replacements[0].winnerSource).toBe("B.md");
    expect(plan.replacements[0].afterBody).toContain("longer and more thorough");
  });

  it("respects an explicit --pick source winner", async () => {
    await writeFile(dir, "A.md", "## Rules\nalpha body\n");
    await writeFile(dir, "B.md", "## Rules\nbeta body\n");
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, {
      cwd: dir,
      pick: { kind: "source", source: "A.md" },
    });
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0].target).toBe("B.md");
    expect(plan.replacements[0].winnerSource).toBe("A.md");
  });

  it("limits rewrites with a targets filter", async () => {
    await writeFile(dir, "A.md", "## Rules\nalpha\n");
    await writeFile(dir, "B.md", "## Rules\nbeta\n");
    await writeFile(dir, "C.md", "## Rules\ngamma\n");
    const report = await reportFor(dir, ["A.md", "B.md", "C.md"]);
    const plan = await planHerd(report, {
      cwd: dir,
      pick: { kind: "source", source: "A.md" },
      targets: ["B.md"],
    });
    expect(plan.replacements.map((r) => r.target)).toEqual(["B.md"]);
  });

  it("skips single-source groups as missing", async () => {
    await writeFile(dir, "A.md", "## Only Here\nsolo\n## Shared\nx\n");
    await writeFile(dir, "B.md", "## Shared\nx\n");
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, { cwd: dir });
    expect(plan.replacements).toHaveLength(0);
    expect(
      plan.skipped.find((s) => s.reason === "missing-single-source"),
    ).toBeDefined();
  });
});

describe("applyHerd", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmp();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rewrites only the block body, preserving surrounding content and heading", async () => {
    await writeFile(
      dir,
      "A.md",
      "intro paragraph\n\n## Rules\nold body line 1\nold body line 2\n\n## Notes\nkeep me\n",
    );
    await writeFile(
      dir,
      "B.md",
      "intro paragraph\n\n## Rules\nfresh winning body\n\n## Notes\nkeep me\n",
    );
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
    });
    const res = await applyHerd(plan, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
    });
    expect(res.writes.map((w) => w.target)).toEqual(["A.md"]);
    const updated = await read(dir, "A.md");
    expect(updated).toContain("intro paragraph");
    expect(updated).toContain("## Rules");
    expect(updated).toContain("fresh winning body");
    expect(updated).not.toContain("old body line 1");
    expect(updated).toContain("## Notes");
    expect(updated).toContain("keep me");
  });

  it("writes a .bak when backup is enabled", async () => {
    await writeFile(dir, "A.md", "## Rules\nold\n");
    await writeFile(dir, "B.md", "## Rules\nnew winning\n");
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
    });
    await applyHerd(plan, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
      backup: true,
    });
    const bak = await read(dir, "A.md.bak");
    expect(bak).toContain("old");
  });

  it("handles multiple non-overlapping edits in one file", async () => {
    await writeFile(
      dir,
      "A.md",
      "## One\nold one\n\n## Two\nold two\n",
    );
    await writeFile(dir, "B.md", "## One\nnew one\n\n## Two\nnew two\n");
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
    });
    expect(plan.replacements).toHaveLength(2);
    await applyHerd(plan, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
    });
    const updated = await read(dir, "A.md");
    expect(updated).toContain("new one");
    expect(updated).toContain("new two");
    expect(updated).not.toContain("old one");
    expect(updated).not.toContain("old two");
  });

  it("summarizePlan reports change/file/skip counts", async () => {
    await writeFile(dir, "A.md", "## R\nold\n");
    await writeFile(dir, "B.md", "## R\nnew\n");
    const report = await reportFor(dir, ["A.md", "B.md"]);
    const plan = await planHerd(report, {
      cwd: dir,
      pick: { kind: "source", source: "B.md" },
    });
    const sum = summarizePlan(plan);
    expect(sum.changes).toBe(1);
    expect(sum.files).toBe(1);
    expect(sum.skipped).toBeGreaterThanOrEqual(0);
  });
});
