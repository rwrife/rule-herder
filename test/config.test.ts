import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, validateConfig, CONFIG_FILENAME } from "../src/config.js";

describe("config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-cfg-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config exists", async () => {
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.configPath).toBeNull();
    expect(cfg.thresholds).toEqual({ drift: 0.2, reworded: 0.6 });
    expect(cfg.ignore).toEqual([]);
    expect(cfg.aliases).toEqual({});
    expect(cfg.files).toContain("AGENTS.md");
    expect(cfg.files).toContain(".github/copilot-instructions.md");
  });

  it("extends the default file list", async () => {
    await fs.writeFile(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ extends: ["docs/AGENTS.md"] }),
    );
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.files).toContain("AGENTS.md");
    expect(cfg.files).toContain("docs/AGENTS.md");
  });

  it("replaces the file list when `files` is set", async () => {
    await fs.writeFile(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ files: ["ONLY.md"], extends: ["IGNORED.md"] }),
    );
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.files).toEqual(["ONLY.md"]);
  });

  it("normalizes aliases (lowercase + ` > ` join + dedupe)", async () => {
    await fs.writeFile(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({
        aliases: {
          Rules: ["Rules", "  rules  ", "Section > Rules", "section>rules"],
        },
      }),
    );
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.aliases).toEqual({
      rules: ["rules", "section > rules"],
    });
  });

  it("honors explicit thresholds", async () => {
    await fs.writeFile(
      path.join(dir, CONFIG_FILENAME),
      JSON.stringify({ thresholds: { drift: 0.4, reworded: 0.5 } }),
    );
    const cfg = await loadConfig({ cwd: dir });
    expect(cfg.thresholds).toEqual({ drift: 0.4, reworded: 0.5 });
  });

  it("throws when an explicit --config path is missing", async () => {
    await expect(
      loadConfig({ cwd: dir, configPath: "missing.json" }),
    ).rejects.toBeTruthy();
  });

  it("rejects bad shapes", () => {
    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig({ files: "AGENTS.md" })).toThrow();
    expect(() => validateConfig({ thresholds: { drift: "0.2" } })).toThrow();
    expect(() => validateConfig({ aliases: { rules: "Rules" } })).toThrow();
  });
});
