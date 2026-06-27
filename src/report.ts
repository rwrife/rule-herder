import pc from "picocolors";
import type { DriftReport, DriftGroup, GroupStatus } from "./match.js";

/**
 * Renderers for a `DriftReport`.
 *
 * Two surfaces:
 *  - `renderHuman` — colorized, terminal-friendly summary; the default `diff` output.
 *  - `renderJson`  — stable machine-readable shape for scripts / CI consumers.
 *
 * Both are pure functions of the report (plus options) so they're trivial to snapshot-test.
 */

export interface HumanRenderOptions {
  /** Disable ANSI color codes (used for tests / non-TTY output). */
  noColor?: boolean;
  /** Drift threshold; rendered alongside the overall score for context. */
  threshold?: number;
}

const STATUS_GLYPH: Record<GroupStatus, string> = {
  aligned: "✓",
  reworded: "~",
  conflict: "✗",
  missing: "?",
};

function color(noColor: boolean | undefined) {
  if (!noColor) return pc;
  // pico-compatible no-op shim — every helper just returns the input string.
  const id = (s: string) => s;
  return {
    bold: id,
    dim: id,
    red: id,
    yellow: id,
    green: id,
    cyan: id,
    magenta: id,
    gray: id,
  } as unknown as typeof pc;
}

function statusColor(c: ReturnType<typeof color>, status: GroupStatus) {
  switch (status) {
    case "aligned":
      return c.green;
    case "reworded":
      return c.yellow;
    case "conflict":
      return c.red;
    case "missing":
      return c.cyan;
  }
}

function fmtScore(n: number): string {
  return n.toFixed(2);
}

function headingLabel(g: DriftGroup): string {
  if (g.headingPath.length > 0) return g.headingPath.join(" › ");
  if (g.key.startsWith("~plain:")) return `(preamble) ${g.key.slice("~plain:".length)}`;
  return g.key;
}

export function renderHuman(
  report: DriftReport,
  options: HumanRenderOptions = {},
): string {
  const c = color(options.noColor);
  const lines: string[] = [];

  if (report.sources.length === 0) {
    lines.push(c.yellow("🐕 no agent files to diff — the pasture is empty."));
    return lines.join("\n") + "\n";
  }

  lines.push(
    c.bold(
      `🐕 rule-herder diff — ${report.sources.length} file${report.sources.length === 1 ? "" : "s"}, ${report.groups.length} block${report.groups.length === 1 ? "" : "s"}`,
    ),
  );
  for (const s of report.sources) lines.push(`  ${c.dim("•")} ${s}`);
  lines.push("");

  // Per-block status table (lightweight, no real tables).
  lines.push(c.bold("Blocks:"));
  if (report.groups.length === 0) {
    lines.push(`  ${c.dim("(no blocks parsed)")}`);
  } else {
    for (const g of report.groups) {
      const sc = statusColor(c, g.status);
      const glyph = sc(STATUS_GLYPH[g.status]);
      const label = headingLabel(g);
      const meta: string[] = [
        sc(g.status),
        `score ${fmtScore(g.score)}`,
        `${g.members.length}/${report.sources.length} sources`,
      ];
      if (g.missingFrom.length > 0) {
        meta.push(c.dim(`missing: ${g.missingFrom.join(", ")}`));
      }
      lines.push(`  ${glyph} ${label} ${c.dim("—")} ${meta.join(c.dim(" · "))}`);
    }
  }
  lines.push("");

  if (report.pairs.length > 0) {
    lines.push(c.bold("Pairwise drift:"));
    for (const p of report.pairs) {
      lines.push(`  ${p.a} ${c.dim("↔")} ${p.b} ${c.dim("—")} ${fmtScore(p.score)}`);
    }
    lines.push("");
  }

  const overallColor =
    report.overall === 0 ? c.green : report.overall < 0.34 ? c.yellow : c.red;
  const overallLine = `Overall drift: ${overallColor(fmtScore(report.overall))}`;
  if (typeof options.threshold === "number") {
    lines.push(
      `${overallLine} ${c.dim(`(threshold ${fmtScore(options.threshold)})`)}`,
    );
  } else {
    lines.push(overallLine);
  }

  return lines.join("\n") + "\n";
}

/**
 * Stable JSON shape for scripts. Intentionally drops raw file bodies — consumers
 * that need them can re-parse — and keeps a flat, predictable schema.
 */
export interface JsonReport {
  sources: string[];
  overall: number;
  threshold: number | null;
  exceedsThreshold: boolean;
  groups: Array<{
    key: string;
    headingPath: string[];
    status: GroupStatus;
    score: number;
    members: Array<{ source: string; startLine: number; endLine: number }>;
    missingFrom: string[];
  }>;
  pairs: Array<{ a: string; b: string; score: number }>;
}

export interface JsonRenderOptions {
  threshold?: number;
}

export function renderJson(
  report: DriftReport,
  options: JsonRenderOptions = {},
): string {
  const threshold = options.threshold ?? null;
  const out: JsonReport = {
    sources: report.sources,
    overall: report.overall,
    threshold,
    exceedsThreshold:
      typeof threshold === "number" ? report.overall > threshold : false,
    groups: report.groups.map((g) => ({
      key: g.key,
      headingPath: g.headingPath,
      status: g.status,
      score: g.score,
      members: g.members.map((m) => ({
        source: m.source,
        startLine: m.block.startLine,
        endLine: m.block.endLine,
      })),
      missingFrom: g.missingFrom,
    })),
    pairs: report.pairs.map((p) => ({ a: p.a, b: p.b, score: p.score })),
  };
  return JSON.stringify(out, null, 2) + "\n";
}
