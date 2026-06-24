import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScan } from "../src/cli.js";

describe("runScan", () => {
  let dir: string;
  let stdout: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-cli-"));
    stdout = "";
    originalWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: any) => {
      stdout += String(chunk);
      return true;
    };
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports an empty pasture when nothing matches", async () => {
    const code = await runScan({ cwd: dir });
    expect(code).toBe(0);
    expect(stdout).toMatch(/no agent files detected/);
  });

  it("lists detected files in human output", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    const code = await runScan({ cwd: dir });
    expect(code).toBe(0);
    expect(stdout).toMatch(/AGENTS\.md/);
    expect(stdout).toMatch(/herded 1 agent file/);
  });

  it("emits JSON when --json is passed", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# x\n");
    const code = await runScan({ cwd: dir, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(1);
    expect(parsed.files[0].path).toBe("CLAUDE.md");
  });
});
