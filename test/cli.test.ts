import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScan, runReport, runDiff } from "../src/cli.js";

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

describe("runReport", () => {
  let dir: string;
  let stdout: string;
  let stderr: string;
  let origOut: typeof process.stdout.write;
  let origErr: typeof process.stderr.write;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-report-"));
    stdout = "";
    stderr = "";
    origOut = process.stdout.write.bind(process.stdout);
    origErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: any) => {
      stdout += String(chunk);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: any) => {
      stderr += String(chunk);
      return true;
    };
  });

  afterEach(async () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes an HTML artifact by default and always exits 0", async () => {
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "# Rules\n## Style\nuse two spaces\n",
    );
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      "# Rules\n## Style\nfour spaces please\n",
    );
    const out = path.join(dir, "drift.html");
    const code = await runReport({
      cwd: dir,
      out,
      now: "2026-07-08T00:00:00.000Z",
    });
    // report NEVER gates CI; success is exit 0 even with drift.
    expect(code).toBe(0);
    const html = await fs.readFile(out, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/rule-herder drift report/);
    expect(html).toMatch(/AGENTS\.md/);
    expect(stdout).toMatch(/wrote html report/);
  });

  it("writes markdown when --format md is passed", async () => {
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "# Rules\n## Style\nuse two spaces\n",
    );
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      "# Rules\n## Style\nfour spaces please\n",
    );
    const out = path.join(dir, "drift.md");
    const code = await runReport({
      cwd: dir,
      format: "md",
      out,
      now: "2026-07-08T00:00:00.000Z",
    });
    expect(code).toBe(0);
    const md = await fs.readFile(out, "utf8");
    expect(md).toMatch(/^# 🐕 rule-herder drift report/);
    expect(md).toMatch(/### ✗ Conflict/);
  });

  it("can print to stdout instead of a file", async () => {
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "# Rules\n## Style\nuse two spaces\n",
    );
    const code = await runReport({
      cwd: dir,
      stdout: true,
      format: "md",
      now: "2026-07-08T00:00:00.000Z",
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^# 🐕 rule-herder drift report/);
  });

  it("produces an empty-pasture artifact when there are no files", async () => {
    const out = path.join(dir, "empty.html");
    const code = await runReport({
      cwd: dir,
      out,
      now: "2026-07-08T00:00:00.000Z",
    });
    expect(code).toBe(0);
    const html = await fs.readFile(out, "utf8");
    expect(html).toMatch(/No drift — flock is aligned/);
  });

  it("returns 1 (and logs) when the output path cannot be written", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    const bogus = path.join(dir, "does", "not", "exist", "drift.html");
    const code = await runReport({
      cwd: dir,
      out: bogus,
      now: "2026-07-08T00:00:00.000Z",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/failed to write/);
  });
});

describe("runDiff --watch", () => {
  let dir: string;
  let stdout: string;
  let stderr: string;
  let origOut: typeof process.stdout.write;
  let origErr: typeof process.stderr.write;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-watch-cli-"));
    stdout = "";
    stderr = "";
    origOut = process.stdout.write.bind(process.stdout);
    origErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: any) => {
      stdout += String(chunk);
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: any) => {
      stderr += String(chunk);
      return true;
    };
  });

  afterEach(async () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("runs one tick and returns based on the drift score", async () => {
    await fs.writeFile(
      path.join(dir, "AGENTS.md"),
      "# Rules\n## Style\nuse two spaces\n",
    );
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      "# Rules\n## Style\nuse two spaces\n",
    );
    const code = await runDiff({
      cwd: dir,
      watch: true,
      color: false,
      watchMaxTicks: 1,
      threshold: 0.5,
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/rule-herder diff/);
    // Watch footer should appear and mention debounce + Ctrl+C exit hint.
    expect(stdout).toMatch(/watch — initial run/);
    expect(stdout).toMatch(/Ctrl\+C to exit/);
  });

  it("warns and falls back to non-watch when combined with --json", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    const code = await runDiff({
      cwd: dir,
      watch: true,
      json: true,
      color: false,
    });
    expect(code).toBe(0);
    expect(stderr).toMatch(/--watch is incompatible with --json/);
    // Should still emit the JSON report (single-shot fallback).
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.sources)).toBe(true);
  });

  it("rejects out-of-range --watch-debounce", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    await expect(
      runDiff({
        cwd: dir,
        watch: true,
        color: false,
        watchMaxTicks: 1,
        watchDebounce: 999_999,
      }),
    ).rejects.toThrow(/watch-debounce out of range/);
  });
});
