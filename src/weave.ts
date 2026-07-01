import { promises as fs } from "node:fs";
import path from "node:path";
import type { DriftReport, DriftGroup, GroupMember } from "./match.js";
import type { PickStrategy } from "./herd.js";

/**
 * Canonical export: merge the flock into a single `RULES.md` source of truth.
 *
 * This is the read-only, one-way sibling of `herd`. Where `herd` reconciles
 * the existing files in place, `weave` emits one new file that carries a
 * "winning" version of every rule block detected across the flock. Consumers
 * can commit `RULES.md` next to their agent files, or delete the originals
 * and generate them from `RULES.md` later.
 *
 * Scope (v1):
 *  - One block per drift group, in the same first-seen order the diff engine
 *    uses. Winner selection reuses the `PickStrategy` shape from `herd`.
 *  - Heading depth is taken from `block.headingPath.length` (clamped 1..6);
 *    intermediate parent headings are NOT synthesized. If a parent heading
 *    also carries body somewhere in the flock it will surface as its own
 *    group and land in the output naturally.
 *  - Preamble / plain-file blocks (no heading path) are emitted at the top,
 *    in encountered order, before any headed sections.
 *  - `missing` groups (rule present in only one source) are included by
 *    default so weaving is lossless; pass `onlyShared` to drop them.
 *
 * Out of scope for v1: synthesizing parent-heading scaffolding, dropping
 * tool-specific dialect sections, or rewriting the underlying agent files.
 */

export interface WeaveOptions {
  /** Pick strategy; defaults to `newest`. */
  pick?: PickStrategy;
  /** Filesystem root used to resolve source paths for `newest`. Defaults to cwd. */
  cwd?: string;
  /** When true, drop groups that only one source contributed to. */
  onlyShared?: boolean;
  /** Optional top-of-file H1 title. When omitted no title is written. */
  title?: string;
  /** When true, suppress the generated-by header comment. */
  omitHeader?: boolean;
}

export interface WeaveSection {
  key: string;
  headingPath: string[];
  /** Chosen winner source for this section. */
  winnerSource: string;
  /** All sources that carried this block. */
  contributors: string[];
  /** Sources missing this block entirely. */
  missingFrom: string[];
  /** Rendered markdown for this section (heading + body, trailing newline). */
  markdown: string;
}

export interface WeaveResult {
  /** Full RULES.md content. */
  markdown: string;
  sections: WeaveSection[];
  /** Groups that were skipped and why (mirrors the herd plan shape). */
  skipped: { key: string; headingPath: string[]; reason: string }[];
}

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
    return (
      group.members.find((m) => m.source === strategy.source) ??
      group.members[0]
    );
  }
  if (strategy.kind === "longest") {
    return [...group.members].sort(
      (a, b) => b.block.rawBody.length - a.block.rawBody.length,
    )[0];
  }
  const withTimes = await Promise.all(
    group.members.map(async (m) => ({
      m,
      t: await fileMtimeMs(path.resolve(cwd, m.source)),
    })),
  );
  withTimes.sort((a, b) => b.t - a.t);
  return withTimes[0]?.m;
}

function headingLine(headingPath: string[]): string | null {
  if (headingPath.length === 0) return null;
  const depth = Math.min(headingPath.length, 6);
  const title = headingPath[headingPath.length - 1];
  return `${"#".repeat(depth)} ${title}`;
}

function renderSection(group: DriftGroup, winner: GroupMember): string {
  const head = headingLine(group.headingPath);
  const body = winner.block.rawBody.replace(/\s+$/g, "");
  if (head === null) {
    return body.length > 0 ? `${body}\n` : "";
  }
  return body.length > 0 ? `${head}\n\n${body}\n` : `${head}\n`;
}

/**
 * Compute the canonical `RULES.md` content for a drift report.
 */
export async function weaveReport(
  report: DriftReport,
  options: WeaveOptions = {},
): Promise<WeaveResult> {
  const pick = options.pick ?? { kind: "newest" };
  const cwd = options.cwd ?? process.cwd();

  const sections: WeaveSection[] = [];
  const skipped: WeaveResult["skipped"] = [];

  // Preamble groups first (encountered order), then headed groups (encountered order).
  const preamble: DriftGroup[] = [];
  const headed: DriftGroup[] = [];
  for (const g of report.groups) {
    if (g.headingPath.length === 0) preamble.push(g);
    else headed.push(g);
  }

  const ordered = [...preamble, ...headed];

  for (const group of ordered) {
    if (options.onlyShared && group.members.length < 2) {
      skipped.push({
        key: group.key,
        headingPath: group.headingPath,
        reason: "only-shared",
      });
      continue;
    }
    const winner = await pickWinner(group, pick, cwd);
    if (!winner) {
      skipped.push({
        key: group.key,
        headingPath: group.headingPath,
        reason: "no-members",
      });
      continue;
    }
    sections.push({
      key: group.key,
      headingPath: group.headingPath,
      winnerSource: winner.source,
      contributors: group.members.map((m) => m.source),
      missingFrom: group.missingFrom,
      markdown: renderSection(group, winner),
    });
  }

  const parts: string[] = [];
  if (!options.omitHeader) {
    parts.push(
      "<!-- generated by rule-herder weave; do not edit by hand. -->",
      `<!-- sources: ${report.sources.join(", ") || "(none)"} -->`,
      "",
    );
  }
  if (options.title && options.title.trim().length > 0) {
    parts.push(`# ${options.title.trim()}`, "");
  }
  for (const s of sections) {
    if (s.markdown.length === 0) continue;
    parts.push(s.markdown.trimEnd(), "");
  }

  // Guarantee a single trailing newline; collapse runs of blank lines.
  let markdown = parts.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!markdown.endsWith("\n")) markdown += "\n";

  return { markdown, sections, skipped };
}

/**
 * Convenience: weave and write to `outPath` atomically. Returns the result
 * plus the resolved absolute path that was written (or `null` when `outPath`
 * is falsy — caller wanted the content but no side effect).
 */
export async function writeWeave(
  report: DriftReport,
  outPath: string | undefined,
  options: WeaveOptions = {},
): Promise<{ result: WeaveResult; writtenTo: string | null }> {
  const result = await weaveReport(report, options);
  if (!outPath) return { result, writtenTo: null };
  const cwd = options.cwd ?? process.cwd();
  const abs = path.isAbsolute(outPath) ? outPath : path.resolve(cwd, outPath);
  const tmp = abs + ".rh-tmp";
  await fs.writeFile(tmp, result.markdown, "utf8");
  await fs.rename(tmp, abs);
  return { result, writtenTo: abs };
}
