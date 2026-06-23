import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAgentFiles } from "../src/detect.js";

describe("detectAgentFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-detect-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns an empty list when no agent files exist", async () => {
    expect(await detectAgentFiles({ cwd: dir })).toEqual([]);
  });

  it("detects top-level agent files", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# hi\n");
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# hi\n");
    const found = await detectAgentFiles({ cwd: dir });
    const rels = found.map((f) => f.relPath);
    expect(rels).toContain("AGENTS.md");
    expect(rels).toContain("CLAUDE.md");
  });

  it("detects nested copilot-instructions", async () => {
    await fs.mkdir(path.join(dir, ".github"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".github/copilot-instructions.md"),
      "# copilot\n",
    );
    const found = await detectAgentFiles({ cwd: dir });
    expect(found.map((f) => f.relPath)).toContain(
      ".github/copilot-instructions.md",
    );
  });

  it("respects a custom candidate list", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "x");
    await fs.writeFile(path.join(dir, "CUSTOM.md"), "x");
    const found = await detectAgentFiles({
      cwd: dir,
      candidates: ["CUSTOM.md"],
    });
    expect(found.map((f) => f.relPath)).toEqual(["CUSTOM.md"]);
  });
});
