import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PRECOMMIT = path.resolve(__dirname, "../dist/precommit.js");

describe("precommit shim", () => {
  it("invokes `rule-herder diff` and returns 0 when no agent files exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-precommit-"));
    const result = spawnSync(process.execPath, [PRECOMMIT], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/no agent files|pasture|aligned|drift/i);
  });

  it("forwards extra args (e.g. --json) to the diff command", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rh-precommit-json-"));
    mkdirSync(path.join(dir, ".github"), { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\n\n- be kind\n");
    writeFileSync(path.join(dir, "CLAUDE.md"), "# Rules\n\n- be kind\n");

    const result = spawnSync(process.execPath, [PRECOMMIT, "--json"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    // --json forces JSON output
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});
