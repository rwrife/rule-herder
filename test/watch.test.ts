import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import {
  compareReports,
  formatDelta,
  resolveDebounce,
  Watcher,
  WATCH_DEBOUNCE_DEFAULT_MS,
  WATCH_DEBOUNCE_MAX_MS,
  WATCH_DEBOUNCE_MIN_MS,
  type ReportDelta,
} from "../src/watch.js";
import type {
  DriftGroup,
  DriftReport,
  GroupStatus,
} from "../src/match.js";

/**
 * Build a minimal DriftReport with just the fields `compareReports` cares
 * about. Every group defaults to `aligned`/score 0 unless overridden.
 */
function report(
  sources: string[],
  groups: Array<Partial<DriftGroup> & { key: string; status?: GroupStatus }>,
  overall = 0,
): DriftReport {
  return {
    sources,
    groups: groups.map((g) => ({
      key: g.key,
      headingPath: g.headingPath ?? [g.key],
      status: g.status ?? "aligned",
      score: g.score ?? 0,
      members: g.members ?? [],
      missingFrom: g.missingFrom ?? [],
    })),
    pairs: [],
    overall,
  };
}

describe("compareReports", () => {
  it("treats a null prev as an all-new report", () => {
    const next = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "aligned" },
        { key: "rules > tests", status: "conflict" },
      ],
      0.5,
    );
    const d = compareReports(null, next);
    expect(d.addedSources).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(d.removedSources).toEqual([]);
    expect(d.addedGroups).toEqual(["rules > style", "rules > tests"]);
    expect(d.removedGroups).toEqual([]);
    expect(d.statusChanges).toEqual([]);
    expect(d.groupsMovedToAligned).toBe(0);
    expect(d.newConflicts).toBe(0);
    expect(d.resolvedConflicts).toBe(0);
    expect(d.overallDelta).toBe(0);
  });

  it("returns a no-op delta when nothing changed", () => {
    const a = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "aligned" },
        { key: "rules > tests", status: "conflict" },
      ],
      0.4,
    );
    const b = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "aligned" },
        { key: "rules > tests", status: "conflict" },
      ],
      0.4,
    );
    const d = compareReports(a, b);
    expect(d.addedGroups).toEqual([]);
    expect(d.removedGroups).toEqual([]);
    expect(d.statusChanges).toEqual([]);
    expect(d.groupsMovedToAligned).toBe(0);
    expect(d.newConflicts).toBe(0);
    expect(d.resolvedConflicts).toBe(0);
    expect(d.overallDelta).toBe(0);
    expect(formatDelta(d)).toBe("");
  });

  it("detects new conflicts", () => {
    const a = report(
      ["AGENTS.md", "CLAUDE.md"],
      [{ key: "rules > style", status: "aligned" }],
    );
    const b = report(
      ["AGENTS.md", "CLAUDE.md"],
      [{ key: "rules > style", status: "conflict" }],
      0.3,
    );
    const d = compareReports(a, b);
    expect(d.statusChanges).toEqual([
      { key: "rules > style", from: "aligned", to: "conflict" },
    ]);
    expect(d.newConflicts).toBe(1);
    expect(d.resolvedConflicts).toBe(0);
    expect(d.groupsMovedToAligned).toBe(0);
    expect(d.overallDelta).toBeCloseTo(0.3);
    expect(formatDelta(d)).toBe("1 new conflict");
  });

  it("detects resolved conflicts and groups moving to aligned", () => {
    const a = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "conflict" },
        { key: "rules > safety", status: "reworded" },
      ],
      0.5,
    );
    const b = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "aligned" },
        { key: "rules > safety", status: "aligned" },
      ],
      0.0,
    );
    const d = compareReports(a, b);
    expect(d.groupsMovedToAligned).toBe(2);
    expect(d.resolvedConflicts).toBe(1);
    expect(d.newConflicts).toBe(0);
    expect(d.overallDelta).toBeCloseTo(-0.5);
    expect(formatDelta(d)).toBe(
      "2 groups moved to aligned, 1 conflict resolved",
    );
  });

  it("detects added and removed files", () => {
    const a = report(
      ["AGENTS.md"],
      [{ key: "rules > style", status: "missing" }],
    );
    const b = report(
      ["AGENTS.md", "CLAUDE.md"],
      [{ key: "rules > style", status: "aligned" }],
    );
    const d = compareReports(a, b);
    expect(d.addedSources).toEqual(["CLAUDE.md"]);
    expect(d.removedSources).toEqual([]);
    expect(d.groupsMovedToAligned).toBe(1);
    expect(formatDelta(d)).toContain("1 new file");
  });

  it("detects added and removed groups", () => {
    const a = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "aligned" },
        { key: "rules > old", status: "conflict" },
      ],
    );
    const b = report(
      ["AGENTS.md", "CLAUDE.md"],
      [
        { key: "rules > style", status: "aligned" },
        { key: "rules > new", status: "reworded" },
      ],
    );
    const d = compareReports(a, b);
    expect(d.addedGroups).toEqual(["rules > new"]);
    expect(d.removedGroups).toEqual(["rules > old"]);
    expect(formatDelta(d)).toBe("1 new block, 1 block removed");
  });

  it("removes files and reports the drop", () => {
    const a = report(
      ["AGENTS.md", "CLAUDE.md"],
      [{ key: "rules > style", status: "conflict" }],
      0.5,
    );
    const b = report(
      ["AGENTS.md"],
      [{ key: "rules > style", status: "missing" }],
      0.25,
    );
    const d = compareReports(a, b);
    expect(d.removedSources).toEqual(["CLAUDE.md"]);
    expect(d.statusChanges).toEqual([
      { key: "rules > style", from: "conflict", to: "missing" },
    ]);
    expect(d.resolvedConflicts).toBe(1);
  });
});

describe("resolveDebounce", () => {
  it("returns the default when undefined", () => {
    expect(resolveDebounce(undefined)).toBe(WATCH_DEBOUNCE_DEFAULT_MS);
  });

  it("accepts values within [MIN..MAX]", () => {
    expect(resolveDebounce(WATCH_DEBOUNCE_MIN_MS)).toBe(WATCH_DEBOUNCE_MIN_MS);
    expect(resolveDebounce(WATCH_DEBOUNCE_MAX_MS)).toBe(WATCH_DEBOUNCE_MAX_MS);
    expect(resolveDebounce(200)).toBe(200);
  });

  it("rejects out-of-range values with a RangeError", () => {
    expect(() => resolveDebounce(-1)).toThrow(RangeError);
    expect(() => resolveDebounce(WATCH_DEBOUNCE_MAX_MS + 1)).toThrow(
      RangeError,
    );
    expect(() => resolveDebounce(Number.NaN)).toThrow(RangeError);
  });
});

/**
 * A stub fs.watch handle that the tests can invoke by hand to simulate a save
 * burst without touching the real filesystem in a timing-sensitive way.
 */
class FakeWatcher extends EventEmitter {
  target: string;
  closed = false;
  listener: () => void;
  constructor(target: string, listener: () => void) {
    super();
    this.target = target;
    this.listener = listener;
  }
  fire(): void {
    this.listener();
  }
  close(): void {
    this.closed = true;
  }
}

describe("Watcher integration", () => {
  let dir: string;
  const watchers: FakeWatcher[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-watch-"));
    watchers.length = 0;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const makeFactory = () => (target: string, listener: () => void) => {
    const w = new FakeWatcher(target, listener);
    watchers.push(w);
    return w as unknown as FSWatcher;
  };

  it("runs an initial tick on start and watches detected files", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    let calls = 0;
    const w = new Watcher({
      cwd: dir,
      debounceMs: 5,
      listWatched: async () => ["AGENTS.md"],
      runTick: async () => {
        calls++;
        return report(["AGENTS.md"], []);
      },
      onTick: () => {},
      watchFactory: makeFactory(),
    });
    await w.start();
    expect(calls).toBe(1);
    // AGENTS.md + .ruleherder.json (only if it exists). Config doesn't exist,
    // so we expect exactly one watcher for AGENTS.md.
    expect(watchers).toHaveLength(1);
    expect(watchers[0].target).toBe(path.resolve(dir, "AGENTS.md"));
    w.close();
    expect(watchers[0].closed).toBe(true);
  });

  it("also watches .ruleherder.json when it exists", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    await fs.writeFile(path.join(dir, ".ruleherder.json"), "{}\n");
    const w = new Watcher({
      cwd: dir,
      debounceMs: 5,
      listWatched: async () => ["AGENTS.md"],
      runTick: async () => report(["AGENTS.md"], []),
      onTick: () => {},
      watchFactory: makeFactory(),
    });
    await w.start();
    const targets = watchers.map((x) => path.basename(x.target)).sort();
    expect(targets).toEqual([".ruleherder.json", "AGENTS.md"]);
    w.close();
  });

  it("debounces a burst of change events into a single re-run", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    let calls = 0;
    const deltas: ReportDelta[] = [];
    const w = new Watcher({
      cwd: dir,
      debounceMs: 15,
      listWatched: async () => ["AGENTS.md"],
      runTick: async () => {
        calls++;
        return report(["AGENTS.md"], []);
      },
      onTick: (_r, d) => deltas.push(d),
      watchFactory: makeFactory(),
    });
    await w.start();
    expect(calls).toBe(1);
    // Simulate an editor save burst — four rapid writes should coalesce.
    for (let i = 0; i < 4; i++) watchers[0].fire();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(2);
    expect(deltas).toHaveLength(2);
    w.close();
  });

  it("keeps running when a tick throws and surfaces the error", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    let calls = 0;
    let capturedErr: Error | null = null;
    const w = new Watcher({
      cwd: dir,
      debounceMs: 5,
      listWatched: async () => ["AGENTS.md"],
      runTick: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return report(["AGENTS.md"], []);
      },
      onTick: () => {},
      onError: (err) => {
        capturedErr = err;
      },
      watchFactory: makeFactory(),
    });
    await w.start();
    expect(capturedErr).toBeTruthy();
    expect((capturedErr as unknown as Error).message).toBe("boom");
    watchers[0].fire();
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(2);
    w.close();
  });

  it("drops watchers for files that vanish and picks up new ones", async () => {
    await fs.writeFile(path.join(dir, "AGENTS.md"), "# x\n");
    let detected: string[] = ["AGENTS.md"];
    const w = new Watcher({
      cwd: dir,
      debounceMs: 5,
      listWatched: async () => detected,
      runTick: async () => report(detected, []),
      onTick: () => {},
      watchFactory: makeFactory(),
    });
    await w.start();
    expect(watchers.map((x) => path.basename(x.target))).toEqual(["AGENTS.md"]);

    // Second tick: AGENTS.md removed, CLAUDE.md appeared.
    await fs.rm(path.join(dir, "AGENTS.md"));
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "# y\n");
    detected = ["CLAUDE.md"];
    watchers[0].fire();
    await new Promise((r) => setTimeout(r, 40));

    // Old handle should be closed, new one should be added.
    const open = watchers.filter((x) => !x.closed);
    expect(open.map((x) => path.basename(x.target))).toEqual(["CLAUDE.md"]);
    w.close();
  });
});
