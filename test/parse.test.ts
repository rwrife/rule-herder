import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBlocks, parseFile, normalizeBody } from "../src/parse.js";

describe("normalizeBody", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeBody("  Hello   World  \n")).toBe("hello world");
  });

  it("strips list markers and blockquotes", () => {
    expect(normalizeBody("- one\n* two\n1. three\n> quoted")).toBe(
      "one two three quoted",
    );
  });

  it("drops blank lines", () => {
    expect(normalizeBody("a\n\n\nb\n")).toBe("a b");
  });
});

describe("parseBlocks", () => {
  it("returns a single preamble block when there are no headings", () => {
    const blocks = parseBlocks("X.md", "hello there\n\nbe nice\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      source: "X.md",
      headingPath: [],
      level: 0,
      startLine: 1,
    });
    expect(blocks[0].normalizedBody).toBe("hello there be nice");
  });

  it("splits at ATX headings and tracks heading path", () => {
    const md = [
      "preface",
      "# Top",
      "intro body",
      "## Sub",
      "sub body",
      "# Other",
      "other body",
    ].join("\n");
    const blocks = parseBlocks("X.md", md);
    expect(blocks.map((b) => b.headingPath)).toEqual([
      [],
      ["Top"],
      ["Top", "Sub"],
      ["Other"],
    ]);
    expect(blocks[1].rawBody.trim()).toBe("intro body");
    expect(blocks[2].rawBody.trim()).toBe("sub body");
    expect(blocks[3].rawBody.trim()).toBe("other body");
  });

  it("unwinds heading stack correctly on level jumps", () => {
    const md = ["# A", "## B", "### C", "## D", "# E"].join("\n");
    const blocks = parseBlocks("X.md", md);
    expect(blocks.map((b) => b.headingPath)).toEqual([
      ["A"],
      ["A", "B"],
      ["A", "B", "C"],
      ["A", "D"],
      ["E"],
    ]);
  });

  it("never splits inside a fenced code block", () => {
    const md = [
      "# Outer",
      "```",
      "# not a heading",
      "## also not",
      "```",
      "## Real Sub",
      "body",
    ].join("\n");
    const blocks = parseBlocks("X.md", md);
    expect(blocks.map((b) => b.headingPath)).toEqual([
      ["Outer"],
      ["Outer", "Real Sub"],
    ]);
    expect(blocks[0].rawBody).toContain("# not a heading");
  });

  it("records 1-indexed line spans", () => {
    const md = ["# A", "body a", "# B", "body b"].join("\n");
    const blocks = parseBlocks("X.md", md);
    expect(blocks[0]).toMatchObject({ startLine: 1, endLine: 2 });
    expect(blocks[1]).toMatchObject({ startLine: 3, endLine: 4 });
  });

  it("returns a single block for plain mode", () => {
    const blocks = parseBlocks("rules", "# not a heading\nbe good\n", {
      plain: true,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headingPath).toEqual([]);
    expect(blocks[0].level).toBe(0);
  });

  it("skips an empty preamble (no content before first heading)", () => {
    const blocks = parseBlocks("X.md", "# A\nbody\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headingPath).toEqual(["A"]);
  });
});

describe("parseFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-parse-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("parses markdown agent files from disk", async () => {
    const p = path.join(dir, "AGENTS.md");
    await fs.writeFile(p, "# Rules\n- one\n- two\n");
    const blocks = await parseFile(p);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headingPath).toEqual(["Rules"]);
    expect(blocks[0].normalizedBody).toBe("one two");
  });

  it("treats .cursorrules as plain", async () => {
    const p = path.join(dir, ".cursorrules");
    await fs.writeFile(p, "# this is just a literal line\nrule body\n");
    const blocks = await parseFile(p);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headingPath).toEqual([]);
  });
});
