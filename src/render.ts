import type { DriftReport, DriftGroup, GroupStatus } from "./match.js";

/**
 * Report artifact renderers.
 *
 * `renderHtml` and `renderMarkdown` are pure functions of a `DriftReport` that
 * emit a static, self-contained artifact suitable for uploading as a PR
 * artifact (typically via `actions/upload-artifact`). They intentionally reuse
 * the exact `DriftReport` shape that `buildDriftReport` produces so `diff
 * --json`, `renderJson`, and these renderers all share a single source of
 * truth.
 *
 * These are NOT meant to gate CI (`diff` does that). They only *render*, so
 * the CLI wrapping them always exits 0 on success.
 *
 * ## Design notes
 *
 * - **Zero external assets.** The HTML renderer inlines its own CSS in a
 *   `<style>` block and never emits `<script src>` or `<link rel>`. That lets
 *   the artifact be double-clicked from a downloaded PR artifact bundle
 *   without a network round-trip.
 * - **Aligned groups are skipped by default** in both formats — reviewers
 *   want to see what drifted, not what didn't. Opt back in with
 *   `includeAligned: true`.
 * - **Deterministic ordering.** Groups are rendered by status priority
 *   (conflict → reworded → missing → aligned) then by original report order
 *   so snapshot tests stay stable across runs.
 * - **HTML escaping is applied at every string interpolation site.** No user
 *   input (heading text, source paths, block bodies) is passed through
 *   without escaping.
 */

export interface RenderOptions {
  /** Include `aligned` groups in the output. Defaults to `false`. */
  includeAligned?: boolean;
  /** Threshold surfaced in the summary header; purely cosmetic. */
  threshold?: number;
  /** ISO timestamp; useful for tests to freeze the "generated at" line. */
  generatedAt?: string;
}

const STATUS_ORDER: readonly GroupStatus[] = [
  "conflict",
  "reworded",
  "missing",
  "aligned",
];

const STATUS_LABEL: Record<GroupStatus, string> = {
  aligned: "Aligned",
  reworded: "Reworded",
  missing: "Missing",
  conflict: "Conflict",
};

const STATUS_GLYPH: Record<GroupStatus, string> = {
  aligned: "✓",
  reworded: "~",
  missing: "?",
  conflict: "✗",
};

interface Counts {
  aligned: number;
  reworded: number;
  missing: number;
  conflict: number;
}

function countByStatus(groups: DriftGroup[]): Counts {
  const counts: Counts = { aligned: 0, reworded: 0, missing: 0, conflict: 0 };
  for (const g of groups) counts[g.status] += 1;
  return counts;
}

function headingLabel(g: DriftGroup): string {
  if (g.headingPath.length > 0) return g.headingPath.join(" › ");
  if (g.key.startsWith("~plain:"))
    return `(preamble) ${g.key.slice("~plain:".length)}`;
  return g.key;
}

function orderGroups(
  groups: DriftGroup[],
  includeAligned: boolean,
): DriftGroup[] {
  const visible = includeAligned
    ? groups.slice()
    : groups.filter((g) => g.status !== "aligned");
  const rank = new Map<GroupStatus, number>(
    STATUS_ORDER.map((s, i) => [s, i]),
  );
  // Preserve original order within a status bucket (stable) so the same
  // report round-trips deterministically.
  const withIndex = visible.map((g, i) => ({ g, i }));
  withIndex.sort((a, b) => {
    const dr = (rank.get(a.g.status) ?? 99) - (rank.get(b.g.status) ?? 99);
    if (dr !== 0) return dr;
    return a.i - b.i;
  });
  return withIndex.map((x) => x.g);
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function safeGeneratedAt(opts: RenderOptions): string {
  if (opts.generatedAt) return opts.generatedAt;
  return new Date().toISOString();
}

/* -------------------------- Markdown renderer --------------------------- */

/**
 * Render a `DriftReport` as a plain markdown document.
 *
 * Suitable for pasting into a PR body, dropping into a `docs/` folder, or
 * uploading as an artifact. GitHub renders every construct here without
 * warnings (no HTML, no exotic extensions — just headings, lists, tables,
 * and code fences).
 */
export function renderMarkdown(
  report: DriftReport,
  options: RenderOptions = {},
): string {
  const counts = countByStatus(report.groups);
  const generatedAt = safeGeneratedAt(options);
  const visible = orderGroups(report.groups, options.includeAligned === true);
  const lines: string[] = [];

  lines.push("# 🐕 rule-herder drift report");
  lines.push("");
  lines.push(`_Generated at ${generatedAt}._`);
  lines.push("");

  // Summary block.
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `- **Overall drift:** ${fmt(report.overall)}${
      typeof options.threshold === "number"
        ? ` (threshold ${fmt(options.threshold)})`
        : ""
    }`,
  );
  lines.push(`- **Files:** ${report.sources.length}`);
  lines.push(`- **Blocks:** ${report.groups.length}`);
  lines.push(
    `- **By status:** ${counts.conflict} conflict · ${counts.reworded} reworded · ${counts.missing} missing · ${counts.aligned} aligned`,
  );
  lines.push("");

  // Files table.
  if (report.sources.length > 0) {
    lines.push("## Files");
    lines.push("");
    lines.push("| # | File |");
    lines.push("| --- | --- |");
    report.sources.forEach((s, i) => {
      lines.push(`| ${i + 1} | \`${s}\` |`);
    });
    lines.push("");
  }

  // Pairwise drift table.
  if (report.pairs.length > 0) {
    lines.push("## Pairwise drift");
    lines.push("");
    lines.push("| A | B | Score |");
    lines.push("| --- | --- | --- |");
    for (const p of report.pairs) {
      lines.push(`| \`${p.a}\` | \`${p.b}\` | ${fmt(p.score)} |`);
    }
    lines.push("");
  }

  // Drift groups.
  lines.push("## Drift groups");
  lines.push("");
  if (visible.length === 0) {
    lines.push(
      options.includeAligned === true
        ? "_No blocks parsed._"
        : "_No drift — flock is aligned. Pass `--include-aligned` to see every block._",
    );
    lines.push("");
    return lines.join("\n") + "\n";
  }

  for (const status of STATUS_ORDER) {
    if (status === "aligned" && options.includeAligned !== true) continue;
    const bucket = visible.filter((g) => g.status === status);
    if (bucket.length === 0) continue;
    lines.push(
      `### ${STATUS_GLYPH[status]} ${STATUS_LABEL[status]} (${bucket.length})`,
    );
    lines.push("");
    for (const g of bucket) {
      lines.push(`#### ${headingLabel(g)}`);
      lines.push("");
      lines.push(
        `- **score:** ${fmt(g.score)}${g.members.length > 0 ? ` · **sources:** ${g.members.length}/${report.sources.length}` : ""}`,
      );
      if (g.missingFrom.length > 0) {
        lines.push(
          `- **missing from:** ${g.missingFrom.map((m) => `\`${m}\``).join(", ")}`,
        );
      }
      if (g.members.length > 0) {
        lines.push("");
        for (const m of g.members) {
          lines.push(
            `- \`${m.source}\` — lines ${m.block.startLine}-${m.block.endLine}`,
          );
          const body = m.block.rawBody.trim();
          if (body.length > 0) {
            const fenced = fenceMarkdown(body);
            lines.push("");
            lines.push(fenced);
          }
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Wrap a block body in a fenced code block. Uses enough backticks to escape
 * any run of backticks the body itself might contain, so markdown parsers
 * always see a well-formed fence.
 */
function fenceMarkdown(body: string): string {
  const maxRun = longestBacktickRun(body);
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}\n${body}\n${fence}`;
}

function longestBacktickRun(s: string): number {
  let max = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === "`") {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}

/* ----------------------------- HTML renderer ---------------------------- */

const HTML_STYLE = `
:root {
  color-scheme: light dark;
  --fg: #1f2328;
  --muted: #656d76;
  --bg: #ffffff;
  --panel: #f6f8fa;
  --border: #d0d7de;
  --conflict: #cf222e;
  --reworded: #9a6700;
  --missing: #0969da;
  --aligned: #1a7f37;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3;
    --muted: #8b949e;
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --conflict: #ff7b72;
    --reworded: #d29922;
    --missing: #58a6ff;
    --aligned: #3fb950;
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  color: var(--fg);
  background: var(--bg);
  margin: 0;
  padding: 2rem;
  line-height: 1.5;
}
header { margin-bottom: 1.5rem; }
h1 { margin: 0 0 0.25rem; font-size: 1.75rem; }
h2 { margin: 2rem 0 0.75rem; font-size: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
h3 { margin: 1.25rem 0 0.5rem; font-size: 1.05rem; }
.muted { color: var(--muted); font-size: 0.875rem; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin: 1rem 0 0; }
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem 1rem;
}
.card .label { color: var(--muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
.card .value { font-size: 1.25rem; font-weight: 600; margin-top: 0.15rem; }
.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid transparent;
}
.badge-conflict { color: var(--conflict); border-color: var(--conflict); }
.badge-reworded { color: var(--reworded); border-color: var(--reworded); }
.badge-missing  { color: var(--missing);  border-color: var(--missing); }
.badge-aligned  { color: var(--aligned);  border-color: var(--aligned); }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
th { background: var(--panel); font-weight: 600; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
pre {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.85rem;
  margin: 0.5rem 0;
}
details.group {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin: 0.5rem 0;
  background: var(--panel);
}
details.group summary {
  cursor: pointer;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
details.group summary .score {
  color: var(--muted);
  font-weight: 400;
  font-size: 0.85rem;
}
details.group .body { padding: 0.5rem 0.25rem 0.25rem; }
.member { margin: 0.75rem 0; }
.member .path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; }
.missing-list { color: var(--missing); font-size: 0.85rem; }
footer { margin-top: 3rem; color: var(--muted); font-size: 0.75rem; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badge(status: GroupStatus): string {
  return `<span class="badge badge-${status}">${STATUS_GLYPH[status]} ${STATUS_LABEL[status]}</span>`;
}

/**
 * Render a `DriftReport` as a single self-contained HTML page.
 *
 * The returned string is a full document (`<!doctype html>...`) with inlined
 * CSS. Callers can either write it straight to disk (`rule-herder report
 * --format html --out drift.html`) or pipe it into another tool.
 */
export function renderHtml(
  report: DriftReport,
  options: RenderOptions = {},
): string {
  const counts = countByStatus(report.groups);
  const visible = orderGroups(report.groups, options.includeAligned === true);
  const generatedAt = safeGeneratedAt(options);

  const parts: string[] = [];
  parts.push("<!doctype html>");
  parts.push('<html lang="en">');
  parts.push("<head>");
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push("<title>rule-herder drift report</title>");
  parts.push(`<style>${HTML_STYLE}</style>`);
  parts.push("</head>");
  parts.push("<body>");
  parts.push("<header>");
  parts.push('<h1>🐕 rule-herder drift report</h1>');
  parts.push(
    `<p class="muted">Generated at ${escapeHtml(generatedAt)} · ${report.sources.length} file${report.sources.length === 1 ? "" : "s"} · ${report.groups.length} block${report.groups.length === 1 ? "" : "s"}</p>`,
  );
  parts.push("</header>");

  // Summary cards.
  parts.push('<section class="summary" aria-label="summary">');
  parts.push(
    `<div class="card"><div class="label">Overall drift</div><div class="value">${fmt(report.overall)}${
      typeof options.threshold === "number"
        ? ` <span class="muted">/ ${fmt(options.threshold)}</span>`
        : ""
    }</div></div>`,
  );
  parts.push(
    `<div class="card"><div class="label">Files</div><div class="value">${report.sources.length}</div></div>`,
  );
  parts.push(
    `<div class="card"><div class="label">Blocks</div><div class="value">${report.groups.length}</div></div>`,
  );
  parts.push(
    `<div class="card"><div class="label">Conflicts</div><div class="value" style="color:var(--conflict)">${counts.conflict}</div></div>`,
  );
  parts.push(
    `<div class="card"><div class="label">Reworded</div><div class="value" style="color:var(--reworded)">${counts.reworded}</div></div>`,
  );
  parts.push(
    `<div class="card"><div class="label">Missing</div><div class="value" style="color:var(--missing)">${counts.missing}</div></div>`,
  );
  parts.push(
    `<div class="card"><div class="label">Aligned</div><div class="value" style="color:var(--aligned)">${counts.aligned}</div></div>`,
  );
  parts.push("</section>");

  // Files.
  if (report.sources.length > 0) {
    parts.push("<h2>Files</h2>");
    parts.push("<table><thead><tr><th>#</th><th>Path</th></tr></thead><tbody>");
    report.sources.forEach((s, i) => {
      parts.push(
        `<tr><td>${i + 1}</td><td><code>${escapeHtml(s)}</code></td></tr>`,
      );
    });
    parts.push("</tbody></table>");
  }

  // Pairwise drift.
  if (report.pairs.length > 0) {
    parts.push("<h2>Pairwise drift</h2>");
    parts.push(
      "<table><thead><tr><th>A</th><th>B</th><th>Score</th></tr></thead><tbody>",
    );
    for (const p of report.pairs) {
      parts.push(
        `<tr><td><code>${escapeHtml(p.a)}</code></td><td><code>${escapeHtml(p.b)}</code></td><td>${fmt(p.score)}</td></tr>`,
      );
    }
    parts.push("</tbody></table>");
  }

  // Drift groups by status.
  parts.push("<h2>Drift groups</h2>");
  if (visible.length === 0) {
    parts.push(
      `<p class="muted">${
        options.includeAligned === true
          ? "No blocks parsed."
          : "No drift — flock is aligned. Pass --include-aligned to see every block."
      }</p>`,
    );
  } else {
    for (const status of STATUS_ORDER) {
      if (status === "aligned" && options.includeAligned !== true) continue;
      const bucket = visible.filter((g) => g.status === status);
      if (bucket.length === 0) continue;
      parts.push(
        `<h3>${badge(status)} <span class="muted">(${bucket.length})</span></h3>`,
      );
      for (const g of bucket) {
        const label = escapeHtml(headingLabel(g));
        parts.push('<details class="group" open>');
        parts.push(
          `<summary>${label} <span class="score">— score ${fmt(g.score)} · ${g.members.length}/${report.sources.length} sources</span></summary>`,
        );
        parts.push('<div class="body">');
        if (g.missingFrom.length > 0) {
          parts.push(
            `<div class="missing-list">missing from: ${g.missingFrom
              .map((m) => `<code>${escapeHtml(m)}</code>`)
              .join(", ")}</div>`,
          );
        }
        for (const m of g.members) {
          parts.push('<div class="member">');
          parts.push(
            `<div class="path"><code>${escapeHtml(m.source)}</code> <span class="muted">— lines ${m.block.startLine}-${m.block.endLine}</span></div>`,
          );
          const body = m.block.rawBody.trim();
          if (body.length > 0) {
            parts.push(`<pre>${escapeHtml(body)}</pre>`);
          }
          parts.push("</div>");
        }
        parts.push("</div>");
        parts.push("</details>");
      }
    }
  }

  parts.push(
    '<footer>Generated by <a href="https://github.com/rwrife/rule-herder">rule-herder</a>. This report is a static snapshot — run <code>rule-herder diff</code> for live output or <code>rule-herder herd</code> to reconcile.</footer>',
  );
  parts.push("</body></html>");

  return parts.join("\n") + "\n";
}
