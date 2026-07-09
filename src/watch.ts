import { promises as fs } from "node:fs";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { DriftReport, DriftGroup, GroupStatus } from "./match.js";
import { CONFIG_FILENAME } from "./config.js";

/**
 * Compact human-facing summary of what changed between two consecutive drift
 * reports. Used by watch mode to print a "delta since last run" line after each
 * re-render so the user can spot what actually moved without eyeballing the
 * whole table.
 *
 * The shape is intentionally flat and stable so tests can assert on it
 * directly, and so a future `--json` streaming mode (out of scope for M-b7)
 * could serialize it verbatim.
 */
export interface ReportDelta {
  /** Sources present in `next` but not in `prev` (new agent files appeared). */
  addedSources: string[];
  /** Sources present in `prev` but not in `next` (agent files went away). */
  removedSources: string[];
  /** Group keys that appear only in `next`. */
  addedGroups: string[];
  /** Group keys that appear only in `prev`. */
  removedGroups: string[];
  /**
   * Group keys where the status changed between runs, with the from/to
   * transition. Order matches first-seen order in `next` (then `prev` for any
   * key only present there).
   */
  statusChanges: Array<{ key: string; from: GroupStatus; to: GroupStatus }>;
  /**
   * Convenience buckets counting *net* status transitions (i.e. only groups
   * whose status changed). `groupsMovedToAligned` is groups that were not
   * aligned and are now aligned; `newConflicts` is groups whose status is now
   * `conflict` and previously wasn't. These match the wording called out in
   * the issue's acceptance criteria.
   */
  groupsMovedToAligned: number;
  newConflicts: number;
  resolvedConflicts: number;
  /** Overall drift score change (`next - prev`, or 0 when prev is null). */
  overallDelta: number;
}

/**
 * Compare two `DriftReport`s and produce a compact `ReportDelta`.
 *
 * Pure function — no I/O, no mutation. Used by watch mode to print a "delta
 * since last run" line after each re-render, and unit-tested in isolation
 * (see `test/watch.test.ts`).
 *
 * When `prev` is `null` (very first run), the delta is defined as an all-new
 * report: every source and group counts as added, no status changes are
 * reported (there's nothing to compare against), and `overallDelta` is `0`.
 */
export function compareReports(
  prev: DriftReport | null,
  next: DriftReport,
): ReportDelta {
  if (!prev) {
    return {
      addedSources: [...next.sources],
      removedSources: [],
      addedGroups: next.groups.map((g) => g.key),
      removedGroups: [],
      statusChanges: [],
      groupsMovedToAligned: 0,
      newConflicts: 0,
      resolvedConflicts: 0,
      overallDelta: 0,
    };
  }

  const prevSources = new Set(prev.sources);
  const nextSources = new Set(next.sources);
  const addedSources = next.sources.filter((s) => !prevSources.has(s));
  const removedSources = prev.sources.filter((s) => !nextSources.has(s));

  const prevByKey = new Map<string, DriftGroup>();
  for (const g of prev.groups) prevByKey.set(g.key, g);
  const nextByKey = new Map<string, DriftGroup>();
  for (const g of next.groups) nextByKey.set(g.key, g);

  const addedGroups: string[] = [];
  const removedGroups: string[] = [];
  const statusChanges: ReportDelta["statusChanges"] = [];

  // Walk `next` first for stable ordering of statusChanges + addedGroups.
  for (const g of next.groups) {
    const prior = prevByKey.get(g.key);
    if (!prior) {
      addedGroups.push(g.key);
      continue;
    }
    if (prior.status !== g.status) {
      statusChanges.push({ key: g.key, from: prior.status, to: g.status });
    }
  }
  for (const g of prev.groups) {
    if (!nextByKey.has(g.key)) removedGroups.push(g.key);
  }

  let groupsMovedToAligned = 0;
  let newConflicts = 0;
  let resolvedConflicts = 0;
  for (const c of statusChanges) {
    if (c.to === "aligned" && c.from !== "aligned") groupsMovedToAligned++;
    if (c.to === "conflict" && c.from !== "conflict") newConflicts++;
    if (c.from === "conflict" && c.to !== "conflict") resolvedConflicts++;
  }

  return {
    addedSources,
    removedSources,
    addedGroups,
    removedGroups,
    statusChanges,
    groupsMovedToAligned,
    newConflicts,
    resolvedConflicts,
    overallDelta: next.overall - prev.overall,
  };
}

/**
 * Render a one-line human-readable summary of a `ReportDelta`. Returns an
 * empty string when nothing changed (so the caller can skip printing entirely
 * without a special case).
 *
 * Kept in this module (not `report.ts`) because it's watch-mode-specific — the
 * static reports never show a "since last run" line.
 */
export function formatDelta(delta: ReportDelta): string {
  const parts: string[] = [];
  if (delta.groupsMovedToAligned > 0) {
    parts.push(
      `${delta.groupsMovedToAligned} group${delta.groupsMovedToAligned === 1 ? "" : "s"} moved to aligned`,
    );
  }
  if (delta.newConflicts > 0) {
    parts.push(
      `${delta.newConflicts} new conflict${delta.newConflicts === 1 ? "" : "s"}`,
    );
  }
  if (delta.resolvedConflicts > 0) {
    parts.push(
      `${delta.resolvedConflicts} conflict${delta.resolvedConflicts === 1 ? "" : "s"} resolved`,
    );
  }
  if (delta.addedGroups.length > 0) {
    parts.push(
      `${delta.addedGroups.length} new block${delta.addedGroups.length === 1 ? "" : "s"}`,
    );
  }
  if (delta.removedGroups.length > 0) {
    parts.push(
      `${delta.removedGroups.length} block${delta.removedGroups.length === 1 ? "" : "s"} removed`,
    );
  }
  if (delta.addedSources.length > 0) {
    parts.push(
      `${delta.addedSources.length} new file${delta.addedSources.length === 1 ? "" : "s"}`,
    );
  }
  if (delta.removedSources.length > 0) {
    parts.push(
      `${delta.removedSources.length} file${delta.removedSources.length === 1 ? "" : "s"} removed`,
    );
  }
  if (parts.length === 0) return "";
  return parts.join(", ");
}

/**
 * Bounds for `--watch-debounce`. Documented in the CLI help and enforced by
 * `resolveDebounce()` so both the CLI parser and the watcher itself agree on
 * what a valid value is.
 */
export const WATCH_DEBOUNCE_MIN_MS = 0;
export const WATCH_DEBOUNCE_MAX_MS = 5000;
export const WATCH_DEBOUNCE_DEFAULT_MS = 150;

/**
 * Clamp/validate a raw `--watch-debounce` value. Returns the default when
 * `raw` is `undefined`; throws a `RangeError` on out-of-bounds or non-finite
 * input so the CLI can surface a clean error to the user.
 */
export function resolveDebounce(raw: number | undefined): number {
  if (raw === undefined) return WATCH_DEBOUNCE_DEFAULT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new RangeError(
      `--watch-debounce must be a finite number of ms (got ${raw})`,
    );
  }
  if (raw < WATCH_DEBOUNCE_MIN_MS || raw > WATCH_DEBOUNCE_MAX_MS) {
    throw new RangeError(
      `--watch-debounce out of range: ${raw} (must be ${WATCH_DEBOUNCE_MIN_MS}..${WATCH_DEBOUNCE_MAX_MS} ms)`,
    );
  }
  return raw;
}

/**
 * A single tick of the watch loop: run detect + parse + match + render and
 * return the new drift report. Provided by the caller so `Watcher` stays
 * decoupled from the CLI wiring in `cli.ts`.
 *
 * Implementations should NOT clear the screen or write to stdout themselves;
 * the watcher takes care of framing (screen clear vs. separator) and then
 * delegates to a separate render callback.
 */
export type RunTick = () => Promise<DriftReport>;

/**
 * Called by the watcher after each successful tick with the newly-computed
 * report and its delta since the previous tick. Kept separate from `RunTick`
 * so the caller can (a) render the human report and (b) print the delta line,
 * without the watcher itself knowing anything about `report.ts`.
 */
export type RenderTick = (report: DriftReport, delta: ReportDelta) => void;

/** Called on errors during a tick. Watcher never crashes on a bad tick. */
export type TickErrorHandler = (err: Error) => void;

export interface WatcherOptions {
  /** Directory to (re-)scan on each tick. Watched paths are resolved from here. */
  cwd: string;
  /** Debounce window in ms; see `resolveDebounce`. */
  debounceMs?: number;
  /**
   * Explicit list of extra files to watch (relative to `cwd`). The current set
   * of detected agent files is refreshed on every tick, so `.ruleherder.json`
   * is the main thing that belongs here.
   */
  extraFiles?: readonly string[];
  /**
   * Called with the currently-detected agent file relative paths *before*
   * each tick runs. Injected so `Watcher` doesn't depend on `detect.ts`
   * directly — makes unit testing without a real filesystem tractable.
   */
  listWatched: () => Promise<readonly string[]>;
  /** Perform one detect+parse+match+render pass and return the report. */
  runTick: RunTick;
  /** Called after every successful tick with the delta since the previous. */
  onTick: RenderTick;
  /** Called on tick errors; the watcher keeps running. */
  onError?: TickErrorHandler;
  /**
   * `fs.watch` factory override for tests. Defaults to node's `fs.watch`.
   * The watcher passes `{ persistent: false }` so tests can exit cleanly.
   */
  watchFactory?: (target: string, listener: () => void) => FSWatcher;
}

/**
 * File-system watcher that debounces change bursts and calls `runTick` when
 * the dust settles. Emits `tick` after each successful run and `error` on
 * failures.
 *
 * Behavior:
 *  - On `start()`, runs an initial tick immediately (so the terminal isn't
 *    blank until the first save).
 *  - After each tick, refreshes the watch set: any file present in
 *    `listWatched()` is watched; any file that vanished has its handle
 *    dropped. `extraFiles` are always watched (missing extra files are
 *    silently ignored — the config file may or may not exist).
 *  - Change events are coalesced with a `debounceMs` timer.
 *  - `close()` clears all watchers and cancels any pending timer.
 */
export class Watcher extends EventEmitter {
  private readonly cwd: string;
  private readonly debounceMs: number;
  private readonly extraFiles: readonly string[];
  private readonly listWatched: () => Promise<readonly string[]>;
  private readonly runTick: RunTick;
  private readonly onTick: RenderTick;
  private readonly onError: TickErrorHandler;
  private readonly watchFactory: (
    target: string,
    listener: () => void,
  ) => FSWatcher;

  private watchers = new Map<string, FSWatcher>();
  private lastReport: DriftReport | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private running = false;
  private rerunAfter = false;
  private closed = false;

  constructor(opts: WatcherOptions) {
    super();
    this.cwd = opts.cwd;
    this.debounceMs = resolveDebounce(opts.debounceMs);
    this.extraFiles = opts.extraFiles ?? [CONFIG_FILENAME];
    this.listWatched = opts.listWatched;
    this.runTick = opts.runTick;
    this.onTick = opts.onTick;
    this.onError = opts.onError ?? (() => {});
    this.watchFactory =
      opts.watchFactory ??
      ((target, listener) =>
        fsWatch(target, { persistent: true }, listener));
  }

  /** Kick off the watcher. Runs an initial tick before waiting for changes. */
  async start(): Promise<void> {
    await this.tickNow();
  }

  /** Stop the watcher and release all fs handles. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // best-effort — watcher may already be gone
      }
    }
    this.watchers.clear();
  }

  /** Trigger an immediate debounced re-run (used by fs change listeners). */
  private scheduleTick(): void {
    if (this.closed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.tickNow();
    }, this.debounceMs);
  }

  private async tickNow(): Promise<void> {
    if (this.closed) return;
    // If a tick is already in flight, mark that we need to run again once
    // it finishes — otherwise a slow parse could swallow a save-burst.
    if (this.running) {
      this.rerunAfter = true;
      return;
    }
    this.running = true;
    try {
      const report = await this.runTick();
      const delta = compareReports(this.lastReport, report);
      this.lastReport = report;
      try {
        this.onTick(report, delta);
      } catch (err) {
        this.onError(err as Error);
      }
      this.emit("tick", report, delta);
    } catch (err) {
      this.onError(err as Error);
      // Only emit `error` when someone is actually listening — otherwise
      // Node's EventEmitter throws, which would kill the watch loop on the
      // first bad tick (exactly what we don't want).
      if (this.listenerCount("error") > 0) this.emit("error", err);
    } finally {
      this.running = false;
      await this.refreshWatchSet();
      if (this.rerunAfter && !this.closed) {
        this.rerunAfter = false;
        this.scheduleTick();
      }
    }
  }

  /**
   * Reconcile the currently-open `fs.watch` handles with the desired set
   * (detected files + extra files that exist on disk). Missing files are
   * silently skipped — they'll be picked up on a future tick if they appear.
   */
  private async refreshWatchSet(): Promise<void> {
    if (this.closed) return;
    let detected: readonly string[] = [];
    try {
      detected = await this.listWatched();
    } catch (err) {
      this.onError(err as Error);
    }
    const desired = new Set<string>();
    for (const rel of detected) desired.add(path.resolve(this.cwd, rel));
    for (const rel of this.extraFiles) {
      const abs = path.resolve(this.cwd, rel);
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile()) desired.add(abs);
      } catch {
        // absent — fine, skip
      }
    }

    // Drop watchers for files that vanished.
    for (const [abs, w] of this.watchers) {
      if (!desired.has(abs)) {
        try {
          w.close();
        } catch {
          // best-effort
        }
        this.watchers.delete(abs);
      }
    }
    // Add watchers for new entries.
    for (const abs of desired) {
      if (this.watchers.has(abs)) continue;
      try {
        const w = this.watchFactory(abs, () => this.scheduleTick());
        w.on("error", (err) => this.onError(err));
        this.watchers.set(abs, w);
      } catch (err) {
        // A missing file between stat + watch is possible; skip and retry
        // next tick.
        this.onError(err as Error);
      }
    }
  }
}
