import { promises as fs } from "node:fs";
import path from "node:path";
import type { DriftGroup, DriftReport, GroupMember } from "./match.js";

/**
 * Non-interactive reconcile.
 *
 * Given a `DriftReport`, picks a "winning" block per drifted group via a
 * documented strategy and rewrites every other member's source file so its
 * matching block carries the winner's body.
 *
 * This is the foundation slice for M6 — it ships the reconcile engine, the
 * dry-run preview, and the safe-write path. An interactive Ink TUI will sit
 * on top of {@link planHerd}/{@link applyHerd} in a follow-up.
 *
 * Scope (v1):
 *  - Operates on groups whose status is `conflict` or `reworded`.
 *  - Replaces the body of the matching block in-place (lines after the
 *    heading, or the whole file for plain/preamble blocks). Heading lines
 *    are preserved so per-file wording differences in headings survive.
 *  - `missing` groups (rule present in only one source) are reported but not
 *    auto-inserted — that's a bigger UX call best made interactively.
 *  - `aligned` groups are skipped.
 *
 * Out of scope for v1: heading rewrites, inserting new blocks into files
 * that lack them, three-way merging across more than two divergent bodies
 * beyond "pick one winner".
 */

/** Strategy for choosing the winning block within a drifted group. */
export type PickStrategy =
  | { kind: "newest" }
  | { kind: "longest" }
  | { kind: "source"; source: string };

export interface HerdOptions {
  /** Pick strategy; defaults to `newest`. */
  pick?: PickStrategy;
  /**
   * Only touch these target files (relative paths matching `DriftReport.sources`).
   * When omitted, all sources except the winner are eligible targets.
   */
  targets?: readonly string[];
  /**
   * Filesystem root used to resolve relative source paths. Defaults to cwd.
   * Also used to look up mtimes for the `newest` strategy.
   */
  cwd?: string;
  /** Write `<file>.bak` next to each modified file before overwriting. */
  backup?: boolean;
}

export interface PlannedReplacement {
  /** Target file (relative) whose block will be overwritten. */
  target: string;
  /** Source file (relative) the winning body came from. */
  winnerSource: string;
  /** Group key being reconciled. */
  key: string;
  /** Heading path (presentation). */
  headingPath: string[];
  /** Current body that will be replaced. */
  beforeBody: string;
  /** Body that will be written in its place. */
  afterBody: string;
  /** 1-indexed inclusive line span of the block being replaced (in the target file). */
  startLine: number;
  endLine: number;
  /** `true` when the target block is a heading-bearing block (body sits below heading). */
  hasHeading: boolean;
}

export interface SkippedGroup {
  key: string;
  headingPath: string[];
  reason:
    | "aligned"
    | "missing-single-source"
    | "winner-only"
    | "target-filtered"
    | "winner-not-in-group";
}

export interface HerdPlan {
  /** All concrete file-level rewrites that would be performed. */
  replacements: PlannedReplacement[];
  /** Groups that were considered but produced no rewrite, with a reason. */
  skipped: SkippedGroup[];
}

export interface ApplyResult {
  writes: { target: string; backup?: string }[];
}

/* ------------------------------------------------------------------------- */
/* Plan                                                                       */
/* ------------------------------------------------------------------------- */

async function fileMtimeMs(absPath: string): Promise<number> {
  try {
    const st = await fs.stat(absPath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function pickWinner(
  group: DriftGroup,
  strategy: PickStrategy,
  cwd: string,
): Promise<GroupMember | undefined> {
  if (group.members.length === 0) return undefined;
  if (strategy.kind === "source") {
    return group.members.find((m) => m.source === strategy.source);
  }
  if (strategy.kind === "longest") {
    return [...group.members].sort(
      (a, b) => b.block.rawBody.length - a.block.rawBody.length,
    )[0];
  }
  // newest: by mtime of source file
  const withTimes = await Promise.all(
    group.members.map(async (m) => ({
      m,
      t: await fileMtimeMs(path.resolve(cwd, m.source)),
    })),
  );
  withTimes.sort((a, b) => b.t - a.t);
  return withTimes[0]?.m;
}

/**
 * Compute (but do not write) the set of file replacements that would
 * reconcile the report under the given options.
 */
export async function planHerd(
  report: DriftReport,
  options: HerdOptions = {},
): Promise<HerdPlan> {
  const pick = options.pick ?? { kind: "newest" };
  const cwd = options.cwd ?? process.cwd();
  const targetFilter = options.targets ? new Set(options.targets) : undefined;

  const replacements: PlannedReplacement[] = [];
  const skipped: SkippedGroup[] = [];

  for (const group of report.groups) {
    if (group.status === "aligned") {
      skipped.push({ key: group.key, headingPath: group.headingPath, reason: "aligned" });
      continue;
    }
    if (group.members.length < 2) {
      skipped.push({
        key: group.key,
        headingPath: group.headingPath,
        reason: "missing-single-source",
      });
      continue;
    }

    const winner = await pickWinner(group, pick, cwd);
    if (!winner) {
      skipped.push({
        key: group.key,
        headingPath: group.headingPath,
        reason: "winner-not-in-group",
      });
      continue;
    }

    const losers = group.members.filter((m) => m.source !== winner.source);
    const eligible = targetFilter
      ? losers.filter((m) => targetFilter.has(m.source))
      : losers;

    if (eligible.length === 0) {
      skipped.push({
        key: group.key,
        headingPath: group.headingPath,
        reason: targetFilter ? "target-filtered" : "winner-only",
      });
      continue;
    }

    for (const loser of eligible) {
      // Skip no-op rewrites (already identical body — possible with aliases collapsing).
      if (loser.block.rawBody === winner.block.rawBody) continue;
      replacements.push({
        target: loser.source,
        winnerSource: winner.source,
        key: group.key,
        headingPath: group.headingPath,
        beforeBody: loser.block.rawBody,
        afterBody: winner.block.rawBody,
        startLine: loser.block.startLine,
        endLine: loser.block.endLine,
        hasHeading: loser.block.level > 0,
      });
    }
  }

  return { replacements, skipped };
}

/* ------------------------------------------------------------------------- */
/* Apply                                                                      */
/* ------------------------------------------------------------------------- */

interface FileRewrite {
  target: string;
  edits: PlannedReplacement[];
}

function groupByTarget(replacements: PlannedReplacement[]): FileRewrite[] {
  const map = new Map<string, FileRewrite>();
  for (const r of replacements) {
    let entry = map.get(r.target);
    if (!entry) {
      entry = { target: r.target, edits: [] };
      map.set(r.target, entry);
    }
    entry.edits.push(r);
  }
  return [...map.values()];
}

/**
 * Apply a previously-computed plan to disk.
 *
 * Safety:
 *  - Each modified file is read once, all edits are applied against its
 *    in-memory line array (highest line range first to keep offsets valid),
 *    then written back atomically via a temp-file rename.
 *  - When `backup` is true, a `.bak` snapshot of the original is written
 *    before the new content lands.
 *  - Overlapping edits within a single file are rejected — that would mean
 *    the matcher emitted two replacements covering the same line range,
 *    which is always a bug.
 */
export async function applyHerd(
  plan: HerdPlan,
  options: HerdOptions = {},
): Promise<ApplyResult> {
  const cwd = options.cwd ?? process.cwd();
  const writes: ApplyResult["writes"] = [];

  for (const file of groupByTarget(plan.replacements)) {
    const abs = path.resolve(cwd, file.target);
    const original = await fs.readFile(abs, "utf8");
    const eol = detectEol(original);
    const lines = original.split(/\r?\n/);
    // Track if the original ended with a trailing newline so we can preserve it.
    const trailingNewline = /\r?\n$/.test(original);

    // Reject overlaps.
    const sorted = [...file.edits].sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startLine <= sorted[i - 1].endLine) {
        throw new Error(
          `rule-herder: overlapping replacements in ${file.target} ` +
            `(${sorted[i - 1].key} vs ${sorted[i].key})`,
        );
      }
    }

    // Apply highest-line-first so offsets stay valid.
    const descending = [...sorted].reverse();
    for (const edit of descending) {
      applyEdit(lines, edit);
    }

    let next = lines.join(eol);
    if (trailingNewline && !next.endsWith(eol)) next += eol;
    if (next === original) continue;

    let backupPath: string | undefined;
    if (options.backup) {
      backupPath = abs + ".bak";
      await fs.writeFile(backupPath, original, "utf8");
    }
    const tmp = abs + ".rh-tmp";
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, abs);
    writes.push({ target: file.target, backup: backupPath });
  }

  return { writes };
}

function detectEol(content: string): string {
  return /\r\n/.test(content) ? "\r\n" : "\n";
}

function applyEdit(lines: string[], edit: PlannedReplacement): void {
  // startLine/endLine are 1-indexed inclusive. For heading-bearing blocks the
  // heading sits on startLine and the body occupies startLine+1..endLine; for
  // preamble/plain blocks the body occupies startLine..endLine.
  const headerOffset = edit.hasHeading ? 1 : 0;
  const bodyStart = edit.startLine - 1 + headerOffset; // 0-indexed
  const bodyEndExclusive = edit.endLine; // splice end is exclusive
  const replacement = edit.afterBody === "" ? [] : edit.afterBody.split(/\r?\n/);
  lines.splice(bodyStart, bodyEndExclusive - bodyStart, ...replacement);
}

/* ------------------------------------------------------------------------- */
/* Reporting helpers                                                          */
/* ------------------------------------------------------------------------- */

/** One-line summary for human/JSON reporters. */
export function summarizePlan(plan: HerdPlan): {
  changes: number;
  files: number;
  skipped: number;
} {
  const files = new Set(plan.replacements.map((r) => r.target)).size;
  return {
    changes: plan.replacements.length,
    files,
    skipped: plan.skipped.length,
  };
}
