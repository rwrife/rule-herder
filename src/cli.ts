import { Command } from "commander";
import pc from "picocolors";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { detectAgentFiles } from "./detect.js";
import { parseBlocks } from "./parse.js";
import { buildDriftReport } from "./match.js";
import { renderHuman, renderJson } from "./report.js";
import { renderHtml, renderMarkdown } from "./render.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import {
  planHerd,
  applyHerd,
  summarizePlan,
  type PickStrategy,
} from "./herd.js";
import { writeWeave } from "./weave.js";
import {
  enrichReportWithLLM,
  OpenAIProvider,
  type EnrichResult,
  type LLMProvider,
} from "./llm.js";
import {
  Watcher,
  formatDelta,
  resolveDebounce,
  WATCH_DEBOUNCE_DEFAULT_MS,
  type ReportDelta,
} from "./watch.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

interface ScanOptions {
  cwd: string;
  json?: boolean;
  config?: string;
}

async function loadEffectiveConfig(
  cwd: string,
  configPath?: string,
): Promise<LoadedConfig> {
  return loadConfig({ cwd, configPath });
}

export async function runScan(opts: ScanOptions): Promise<number> {
  const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
  const ignore = new Set(cfg.ignore);
  const files = (
    await detectAgentFiles({ cwd: opts.cwd, candidates: cfg.files })
  ).filter((f) => !ignore.has(f.relPath));

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          cwd: opts.cwd,
          count: files.length,
          files: files.map((f) => ({ path: f.relPath, size: f.size })),
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (files.length === 0) {
    process.stdout.write(
      pc.yellow("🐕 no agent files detected — the pasture is empty.\n"),
    );
    return 0;
  }

  process.stdout.write(
    pc.bold(`🐕 herded ${files.length} agent file${files.length === 1 ? "" : "s"}:\n`),
  );
  for (const f of files) {
    process.stdout.write(`  ${pc.green("•")} ${f.relPath} ${pc.dim(`(${f.size}b)`)}\n`);
  }
  return 0;
}

export interface DiffOptions {
  cwd: string;
  json?: boolean;
  color?: boolean;
  threshold?: number;
  config?: string;
  woof?: boolean;
  llmMatch?: boolean;
  llmUrl?: string;
  llmModel?: string;
  llmKey?: string;
  llmMinConfidence?: number;
  llmMaxCandidates?: number;
  /** Injected in tests; when set, replaces the real provider entirely. */
  llmProviderOverride?: LLMProvider;
  /** Watch mode: re-run on file changes. Incompatible with `json`. */
  watch?: boolean;
  /** Debounce window for watch mode (ms). */
  watchDebounce?: number;
  /** Test hook: exit the watch loop after N successful ticks. */
  watchMaxTicks?: number;
}

function isPlainRulesFile(relPath: string): boolean {
  // Non-markdown agent files (e.g. .cursorrules / .windsurfrules) — treat as one blob.
  return !/\.md$/i.test(relPath);
}

/**
 * Detect + read + parse + match, returning the final drift report and any LLM
 * enrichment metadata. Shared by `runDiff` and watch mode so both agree on the
 * pipeline. Never renders — callers own stdout.
 */
async function computeDrift(
  opts: DiffOptions,
  cfg: LoadedConfig,
): Promise<{
  report: import("./match.js").DriftReport;
  files: Array<{ relPath: string; absPath: string }>;
  llmResult: (EnrichResult & { provider: string }) | null;
}> {
  const ignore = new Set(cfg.ignore);
  const files = (
    await detectAgentFiles({ cwd: opts.cwd, candidates: cfg.files })
  ).filter((f) => !ignore.has(f.relPath));

  if (files.length === 0) {
    return {
      report: { sources: [], groups: [], pairs: [], overall: 0 },
      files,
      llmResult: null,
    };
  }

  const inputs = await Promise.all(
    files.map(async (f) => {
      const text = await fs.readFile(f.absPath, "utf8");
      const blocks = parseBlocks(f.relPath, text, {
        plain: isPlainRulesFile(f.relPath),
      });
      return { source: f.relPath, blocks };
    }),
  );

  const report = buildDriftReport(inputs, {
    rewordedThreshold: cfg.thresholds.reworded,
    aliases: cfg.aliases,
  });

  const llmResult = await maybeEnrichWithLLM(report, opts, cfg);
  return {
    report: llmResult?.report ?? report,
    files,
    llmResult,
  };
}

export async function runDiff(opts: DiffOptions): Promise<number> {
  const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
  const threshold = Number.isFinite(opts.threshold)
    ? (opts.threshold as number)
    : cfg.thresholds.drift;

  if (opts.watch) {
    if (opts.json) {
      process.stderr.write(
        pc.yellow(
          "rule-herder: --watch is incompatible with --json (JSON consumers should call diff per-invocation, not stream); ignoring --watch.\n",
        ),
      );
    } else {
      return runWatch(opts, cfg, threshold);
    }
  }

  const { report: finalReport, llmResult } = await computeDrift(opts, cfg);

  if (opts.json) {
    process.stdout.write(renderJson(finalReport, { threshold }));
  } else {
    process.stdout.write(
      renderHuman(finalReport, {
        noColor: opts.color === false,
        threshold,
        woof: opts.woof === true,
      }),
    );
    if (llmResult && opts.color !== false) {
      process.stdout.write(
        pc.dim(
          `\n  🤖 llm-match (${llmResult.provider}): ${llmResult.matches.length} match(es) of ${llmResult.candidatesConsidered} candidate(s)\n`,
        ),
      );
    } else if (llmResult) {
      process.stdout.write(
        `\n  llm-match (${llmResult.provider}): ${llmResult.matches.length} match(es) of ${llmResult.candidatesConsidered} candidate(s)\n`,
      );
    }
  }

  return finalReport.overall > threshold ? 1 : 0;
}

/**
 * Watch-mode driver. Repaints the drift report on every debounced change to
 * a detected agent file (or `.ruleherder.json`). Never enriches with the LLM
 * unless the caller explicitly opted in via `--llm-match` — polling an LLM on
 * every save would be rude and expensive.
 *
 * Returns after the watcher exits (Ctrl+C or `watchMaxTicks` reached in
 * tests). The exit code always reflects the *most recent* drift score against
 * the threshold, matching non-watch `diff` behavior.
 */
async function runWatch(
  opts: DiffOptions,
  cfg: LoadedConfig,
  threshold: number,
): Promise<number> {
  // In watch mode we deliberately suppress the LLM matcher on every tick
  // *unless* the user was explicit on the CLI. Config-only `llm.enabled: true`
  // gets a quiet downgrade so a background watcher can't rack up API calls
  // without the user typing --llm-match.
  const perTickOpts: DiffOptions = { ...opts };
  if (opts.llmMatch !== true) {
    // Copy cfg so we can flip llm.enabled off just for the per-tick path.
    cfg = { ...cfg, llm: { ...cfg.llm, enabled: false } };
  }

  const debounceMs = resolveDebounce(opts.watchDebounce);
  const noColor = opts.color === false;
  const canClear = process.stdout.isTTY === true && !noColor && !process.env.NO_COLOR;
  const c = canClear ? pc : { dim: (s: string) => s, bold: (s: string) => s };

  let ticks = 0;
  const maxTicks =
    typeof opts.watchMaxTicks === "number" && opts.watchMaxTicks > 0
      ? opts.watchMaxTicks
      : null;
  // Wrap in an object so TS doesn't narrow the type down to `null` based on
  // the initializer alone — the widening happens inside a Watcher callback.
  const state: { lastReport: import("./match.js").DriftReport | null } = {
    lastReport: null,
  };

  const watcher = new Watcher({
    cwd: opts.cwd,
    debounceMs,
    listWatched: async () => {
      const ignore = new Set(cfg.ignore);
      const files = await detectAgentFiles({
        cwd: opts.cwd,
        candidates: cfg.files,
      });
      return files
        .filter((f) => !ignore.has(f.relPath))
        .map((f) => f.relPath);
    },
    runTick: async () => {
      const { report } = await computeDrift(perTickOpts, cfg);
      return report;
    },
    onTick: (report, delta) => {
      if (canClear) {
        // Full clear + home cursor. Matches `console.clear()` but doesn't
        // rely on TTY.write returning success (some pipes lie).
        process.stdout.write("\x1b[2J\x1b[H");
      } else {
        process.stdout.write("---\n");
      }
      process.stdout.write(
        renderHuman(report, {
          noColor,
          threshold,
          woof: opts.woof === true,
        }),
      );
      renderWatchFooter(c, delta, state.lastReport === null, debounceMs);
      state.lastReport = report;
      ticks++;
      if (maxTicks !== null && ticks >= maxTicks) {
        watcher.close();
      }
    },
    onError: (err) => {
      process.stderr.write(
        pc.red(`rule-herder: watch tick failed: ${err.message}\n`),
      );
    },
  });

  const cleanup = () => {
    watcher.close();
  };
  // Best-effort clean exit on Ctrl+C. Node emits SIGINT to the whole process
  // group so we don't need to re-throw — just stop watching.
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  try {
    await watcher.start();
    // Wait until the watcher closes (SIGINT, watchMaxTicks in tests, etc.)
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const check = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((watcher as any).closed) done();
        else setTimeout(check, 25);
      };
      check();
    });
  } finally {
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    watcher.close();
  }

  const finalOverall: number = state.lastReport ? state.lastReport.overall : 0;
  return finalOverall > threshold ? 1 : 0;
}

function renderWatchFooter(
  c: { dim: (s: string) => string; bold: (s: string) => string },
  delta: ReportDelta,
  isFirst: boolean,
  debounceMs: number,
): void {
  const summary = isFirst ? "initial run" : formatDelta(delta) || "no change since last run";
  process.stdout.write(
    c.dim(
      `\n  🐕 watch — ${summary} · debounce ${debounceMs}ms · Ctrl+C to exit\n`,
    ),
  );
}

/**
 * Build the LLM provider and run enrichment when the caller has opted in.
 *
 * **Opt-in rules (belt-and-braces):** the LLM matcher runs only when the user
 * explicitly passed `--llm-match` on the CLI **or** the loaded config has
 * `llm.enabled: true`. Otherwise this returns `null` and no network call
 * happens under any circumstance.
 */
async function maybeEnrichWithLLM(
  report: import("./match.js").DriftReport,
  opts: DiffOptions,
  cfg: LoadedConfig,
): Promise<(EnrichResult & { provider: string }) | null> {
  const optedIn = opts.llmMatch === true || cfg.llm.enabled === true;
  if (!optedIn) return null;

  const provider =
    opts.llmProviderOverride ?? buildLLMProviderFromEnv(opts, cfg);
  if (!provider) {
    process.stderr.write(
      pc.yellow(
        "rule-herder: --llm-match set but no LLM url/model configured; skipping (set --llm-url/--llm-model, RULE_HERDER_LLM_URL/RULE_HERDER_LLM_MODEL, or llm.{url,model} in .ruleherder.json).\n",
      ),
    );
    return null;
  }

  const minConfidence =
    opts.llmMinConfidence ?? cfg.llm.minConfidence;
  const maxCandidates =
    opts.llmMaxCandidates ?? cfg.llm.maxCandidates;

  try {
    const result = await enrichReportWithLLM(report, {
      provider,
      minConfidence,
      maxCandidates,
    });
    return { ...result, provider: provider.name };
  } catch (err) {
    process.stderr.write(
      pc.yellow(
        `rule-herder: LLM matcher failed (${(err as Error).message}); falling back to heuristic-only report.\n`,
      ),
    );
    return null;
  }
}

function buildLLMProviderFromEnv(
  opts: DiffOptions,
  cfg: LoadedConfig,
): LLMProvider | null {
  const url = opts.llmUrl ?? process.env.RULE_HERDER_LLM_URL ?? cfg.llm.url;
  const model =
    opts.llmModel ?? process.env.RULE_HERDER_LLM_MODEL ?? cfg.llm.model;
  const apiKey =
    opts.llmKey ?? process.env.RULE_HERDER_LLM_KEY ?? cfg.llm.apiKey ?? undefined;
  if (!url || !model) return null;
  return new OpenAIProvider({ url, model, apiKey: apiKey ?? undefined });
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("rule-herder")
    .description("A sheepdog for your sprawl of AI agent context files.")
    .version(pkg.version, "-v, --version", "print the rule-herder version");

  const diffCmd = program
    .command("diff")
    .description("diff detected agent files and report drift")
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--json", "emit machine-readable JSON", false)
    .option("--no-color", "disable ANSI color in human output")
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .option(
      "--threshold <n>",
      "overall drift threshold; exit 1 when exceeded (0..1). Overrides config.",
      (v) => Number(v),
    )
    .option(
      "--woof",
      "escalating sheepdog commentary. Cosmetic; ignored with --json.",
      false,
    )
    .option(
      "--watch",
      `re-run diff on file changes; incompatible with --json. Default debounce ${WATCH_DEBOUNCE_DEFAULT_MS}ms.`,
      false,
    )
    .option(
      "--watch-debounce <ms>",
      `debounce window for --watch in ms (0..5000). Default ${WATCH_DEBOUNCE_DEFAULT_MS}.`,
      (v) => Number(v),
    )
    .option(
      "--llm-match",
      "opt in to an LLM pass that catches semantically-equivalent rules the heuristic misses (needs --llm-url + --llm-model, RULE_HERDER_LLM_URL/MODEL env, or llm.{url,model} in .ruleherder.json).",
      false,
    )
    .option(
      "--llm-url <url>",
      "OpenAI-compatible chat/completions URL. Also RULE_HERDER_LLM_URL.",
    )
    .option(
      "--llm-model <name>",
      "Model name to send in the request body. Also RULE_HERDER_LLM_MODEL.",
    )
    .option(
      "--llm-key <key>",
      "API key. Also RULE_HERDER_LLM_KEY. Local backends may not need one.",
    )
    .option(
      "--llm-min-confidence <n>",
      "drop LLM matches below this confidence (0..1). Default 0.7.",
      (v) => Number(v),
    )
    .option(
      "--llm-max-candidates <n>",
      "cap the number of candidate pairs sent to the LLM per run. Default 50.",
      (v) => Number(v),
    )
    .action(async (opts: DiffOptions) => {
      const code = await runDiff(opts);
      process.exitCode = code;
    });
  void diffCmd;

  // `watch` sugar alias: same code path as `diff --watch`, but easier to type.
  program
    .command("watch")
    .description(
      "re-run diff on file changes; sugar for `rule-herder diff --watch`",
    )
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--no-color", "disable ANSI color in human output")
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .option(
      "--threshold <n>",
      "overall drift threshold; exit 1 when exceeded (0..1). Overrides config.",
      (v) => Number(v),
    )
    .option(
      "--woof",
      "escalating sheepdog commentary each re-render.",
      false,
    )
    .option(
      "--watch-debounce <ms>",
      `debounce window in ms (0..5000). Default ${WATCH_DEBOUNCE_DEFAULT_MS}.`,
      (v) => Number(v),
    )
    .option(
      "--llm-match",
      "opt in to LLM matching per re-render (see `diff --llm-match`).",
      false,
    )
    .option("--llm-url <url>", "OpenAI-compatible URL. Also RULE_HERDER_LLM_URL.")
    .option("--llm-model <name>", "Model name. Also RULE_HERDER_LLM_MODEL.")
    .option("--llm-key <key>", "API key. Also RULE_HERDER_LLM_KEY.")
    .option(
      "--llm-min-confidence <n>",
      "drop LLM matches below this confidence.",
      (v) => Number(v),
    )
    .option(
      "--llm-max-candidates <n>",
      "cap LLM candidate pairs per run.",
      (v) => Number(v),
    )
    .action(async (opts: DiffOptions) => {
      const code = await runDiff({ ...opts, watch: true });
      process.exitCode = code;
    });

  program
    .command("scan")
    .description("list detected agent files in the current directory")
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--json", "emit machine-readable JSON", false)
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .action(async (opts: ScanOptions) => {
      const code = await runScan(opts);
      process.exitCode = code;
    });

  program
    .command("herd")
    .description(
      "reconcile drifted blocks: pick a winning version and rewrite the others",
    )
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .option(
      "--pick <strategy>",
      "how to pick the winning block: newest|longest|source=<path>",
      "newest",
    )
    .option(
      "--target <path>",
      "only rewrite this target file (repeatable)",
      (val: string, prev: string[] = []) => prev.concat(val),
      [] as string[],
    )
    .option("--apply", "actually write changes (default is dry-run)", false)
    .option("--backup", "write <file>.bak before overwriting", false)
    .option("--json", "emit machine-readable JSON plan", false)
    .option("--no-color", "disable ANSI color in human output")
    .action(async (opts: HerdCliOptions) => {
      const code = await runHerd(opts);
      process.exitCode = code;
    });

  program
    .command("weave")
    .description(
      "weave the flock into a single canonical RULES.md source of truth",
    )
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .option(
      "--pick <strategy>",
      "how to pick the winning block: newest|longest|source=<path>",
      "newest",
    )
    .option("--out <path>", "output file (defaults to RULES.md)", "RULES.md")
    .option("--stdout", "print to stdout instead of writing a file", false)
    .option("--title <text>", "optional H1 title for the woven file")
    .option(
      "--only-shared",
      "skip blocks that only one source file contributed",
      false,
    )
    .option("--no-header", "omit the generated-by header comment")
    .option("--json", "emit machine-readable JSON summary", false)
    .action(async (opts: WeaveCliOptions) => {
      const code = await runWeave(opts);
      process.exitCode = code;
    });

  program
    .command("report")
    .description(
      "render a static drift-report artifact (HTML or markdown) for PR reviewers",
    )
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .option(
      "--format <fmt>",
      "output format: html|md (default html)",
      (v: string) => {
        if (v !== "html" && v !== "md")
          throw new Error(`invalid --format '${v}'. Expected html|md.`);
        return v as "html" | "md";
      },
      "html",
    )
    .option(
      "--out <path>",
      "output file (defaults to rule-herder-report.html or .md)",
    )
    .option("--stdout", "print to stdout instead of writing a file", false)
    .option(
      "--include-aligned",
      "include aligned (non-drifted) groups in the artifact",
      false,
    )
    .option(
      "--threshold <n>",
      "drift threshold shown in the summary; cosmetic (report never gates CI). Overrides config.",
      (v) => Number(v),
    )
    .option(
      "--llm-match",
      "opt in to LLM-assisted matching (see `diff --llm-match` for details).",
      false,
    )
    .option(
      "--llm-url <url>",
      "OpenAI-compatible chat/completions URL. Also RULE_HERDER_LLM_URL.",
    )
    .option(
      "--llm-model <name>",
      "Model name to send in the request body. Also RULE_HERDER_LLM_MODEL.",
    )
    .option(
      "--llm-key <key>",
      "API key. Also RULE_HERDER_LLM_KEY.",
    )
    .option(
      "--llm-min-confidence <n>",
      "drop LLM matches below this confidence (0..1). Default 0.7.",
      (v) => Number(v),
    )
    .option(
      "--llm-max-candidates <n>",
      "cap LLM candidate pairs per run. Default 50.",
      (v) => Number(v),
    )
    .action(async (opts: ReportOptions) => {
      const code = await runReport(opts);
      process.exitCode = code;
    });

  program
    .command("config")
    .description("print the effective rule-herder config")
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--config <path>", "path to a .ruleherder.json (defaults to cwd)")
    .action(async (opts: { cwd: string; config?: string }) => {
      const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
      process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    });

  return program;
}

export interface ReportOptions {
  cwd: string;
  config?: string;
  format?: "html" | "md";
  out?: string;
  stdout?: boolean;
  includeAligned?: boolean;
  threshold?: number;
  llmMatch?: boolean;
  llmUrl?: string;
  llmModel?: string;
  llmKey?: string;
  llmMinConfidence?: number;
  llmMaxCandidates?: number;
  llmProviderOverride?: LLMProvider;
  /** Injected in tests to freeze the timestamp in the artifact. */
  now?: string;
}

/**
 * Render a static drift report artifact (HTML or markdown) to disk or stdout.
 *
 * Unlike `diff`, this command never gates CI — it always exits 0 on success,
 * and only returns non-zero when the file can't be written. The intent is to
 * produce a reviewer-friendly artifact that a PR reviewer can browse without
 * scrolling CI logs (paired with `actions/upload-artifact` in the GitHub
 * Action).
 */
export async function runReport(opts: ReportOptions): Promise<number> {
  const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
  const ignore = new Set(cfg.ignore);
  const files = (
    await detectAgentFiles({ cwd: opts.cwd, candidates: cfg.files })
  ).filter((f) => !ignore.has(f.relPath));

  const threshold = Number.isFinite(opts.threshold)
    ? (opts.threshold as number)
    : cfg.thresholds.drift;

  let report: import("./match.js").DriftReport = {
    sources: [],
    groups: [],
    pairs: [],
    overall: 0,
  };
  if (files.length > 0) {
    const inputs = await Promise.all(
      files.map(async (f) => {
        const text = await fs.readFile(f.absPath, "utf8");
        const blocks = parseBlocks(f.relPath, text, {
          plain: isPlainRulesFile(f.relPath),
        });
        return { source: f.relPath, blocks };
      }),
    );
    report = buildDriftReport(inputs, {
      rewordedThreshold: cfg.thresholds.reworded,
      aliases: cfg.aliases,
    });
    // Reuse the same opt-in LLM enrichment as `diff` so both commands agree
    // on which groups exist / what status they carry.
    const llmResult = await maybeEnrichWithLLM(
      report,
      {
        cwd: opts.cwd,
        llmMatch: opts.llmMatch,
        llmUrl: opts.llmUrl,
        llmModel: opts.llmModel,
        llmKey: opts.llmKey,
        llmMinConfidence: opts.llmMinConfidence,
        llmMaxCandidates: opts.llmMaxCandidates,
        llmProviderOverride: opts.llmProviderOverride,
      },
      cfg,
    );
    if (llmResult) report = llmResult.report;
  }

  const format = opts.format ?? "html";
  const rendered =
    format === "md"
      ? renderMarkdown(report, {
          includeAligned: opts.includeAligned === true,
          threshold,
          generatedAt: opts.now,
        })
      : renderHtml(report, {
          includeAligned: opts.includeAligned === true,
          threshold,
          generatedAt: opts.now,
        });

  if (opts.stdout) {
    process.stdout.write(rendered);
    return 0;
  }

  const outPath =
    opts.out ?? (format === "md" ? "rule-herder-report.md" : "rule-herder-report.html");
  try {
    await fs.writeFile(outPath, rendered, "utf8");
  } catch (err) {
    process.stderr.write(
      pc.red(
        `rule-herder: failed to write ${outPath}: ${(err as Error).message}\n`,
      ),
    );
    return 1;
  }
  process.stdout.write(
    pc.bold(`🐕 wrote ${format} report to ${outPath}\n`) +
      pc.dim(
        `   ${report.sources.length} file${report.sources.length === 1 ? "" : "s"}, ${report.groups.length} block${report.groups.length === 1 ? "" : "s"}, overall drift ${report.overall.toFixed(2)}\n`,
      ),
  );
  return 0;
}

export interface HerdCliOptions {
  cwd: string;
  config?: string;
  pick: string;
  target: string[];
  apply?: boolean;
  backup?: boolean;
  json?: boolean;
  color?: boolean;
}

function parsePickStrategy(raw: string): PickStrategy {
  if (raw === "newest" || raw === "longest") return { kind: raw };
  const m = /^source=(.+)$/.exec(raw);
  if (m) return { kind: "source", source: m[1] };
  throw new Error(
    `invalid --pick value '${raw}'. Expected newest|longest|source=<path>.`,
  );
}

export async function runHerd(opts: HerdCliOptions): Promise<number> {
  const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
  const ignore = new Set(cfg.ignore);
  const files = (
    await detectAgentFiles({ cwd: opts.cwd, candidates: cfg.files })
  ).filter((f) => !ignore.has(f.relPath));

  if (files.length < 2) {
    const msg = pc.yellow(
      "🐕 need at least two agent files to reconcile — nothing to herd.\n",
    );
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ replacements: [], skipped: [], writes: [] }, null, 2) +
          "\n",
      );
    } else {
      process.stdout.write(msg);
    }
    return 0;
  }

  const inputs = await Promise.all(
    files.map(async (f) => {
      const text = await fs.readFile(f.absPath, "utf8");
      const blocks = parseBlocks(f.relPath, text, {
        plain: isPlainRulesFile(f.relPath),
      });
      return { source: f.relPath, blocks };
    }),
  );

  const report = buildDriftReport(inputs, {
    rewordedThreshold: cfg.thresholds.reworded,
    aliases: cfg.aliases,
  });

  const pick = parsePickStrategy(opts.pick ?? "newest");
  const targets = opts.target && opts.target.length > 0 ? opts.target : undefined;
  const plan = await planHerd(report, {
    pick,
    targets,
    cwd: opts.cwd,
  });

  let writes: { target: string; backup?: string }[] = [];
  if (opts.apply) {
    const result = await applyHerd(plan, {
      pick,
      targets,
      cwd: opts.cwd,
      backup: opts.backup,
    });
    writes = result.writes;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          mode: opts.apply ? "apply" : "dry-run",
          summary: summarizePlan(plan),
          replacements: plan.replacements,
          skipped: plan.skipped,
          writes,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const noColor = opts.color === false;
  const c = (fn: (s: string) => string, s: string) => (noColor ? s : fn(s));
  const sum = summarizePlan(plan);
  const verb = opts.apply ? "applied" : "would apply";
  process.stdout.write(
    c(pc.bold, `🐕 herd ${opts.apply ? "reconcile" : "dry-run"}\n`),
  );
  process.stdout.write(
    `   ${verb} ${sum.changes} change${sum.changes === 1 ? "" : "s"} across ${sum.files} file${sum.files === 1 ? "" : "s"} (${sum.skipped} group${sum.skipped === 1 ? "" : "s"} skipped)\n`,
  );
  for (const r of plan.replacements) {
    const heading = r.headingPath.length > 0 ? r.headingPath.join(" > ") : "(preamble)";
    process.stdout.write(
      `  ${c(pc.cyan, "→")} ${r.target} ${c(pc.dim, `[${heading}]`)} ${c(pc.dim, `← ${r.winnerSource}`)}\n`,
    );
  }
  if (opts.apply) {
    for (const w of writes) {
      const tail = w.backup ? c(pc.dim, ` (backup: ${w.backup})`) : "";
      process.stdout.write(`  ${c(pc.green, "✓")} wrote ${w.target}${tail}\n`);
    }
  } else if (plan.replacements.length > 0) {
    process.stdout.write(
      c(pc.dim, "   (dry-run — pass --apply to write changes)\n"),
    );
  }
  return 0;
}

export interface WeaveCliOptions {
  cwd: string;
  config?: string;
  pick: string;
  out?: string;
  stdout?: boolean;
  title?: string;
  onlyShared?: boolean;
  header?: boolean;
  json?: boolean;
}

export async function runWeave(opts: WeaveCliOptions): Promise<number> {
  const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
  const ignore = new Set(cfg.ignore);
  const files = (
    await detectAgentFiles({ cwd: opts.cwd, candidates: cfg.files })
  ).filter((f) => !ignore.has(f.relPath));

  if (files.length === 0) {
    const msg = pc.yellow(
      "🐕 no agent files detected — nothing to weave.\n",
    );
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ sections: [], skipped: [], writtenTo: null }, null, 2) +
          "\n",
      );
    } else {
      process.stdout.write(msg);
    }
    return 0;
  }

  const inputs = await Promise.all(
    files.map(async (f) => {
      const text = await fs.readFile(f.absPath, "utf8");
      const blocks = parseBlocks(f.relPath, text, {
        plain: isPlainRulesFile(f.relPath),
      });
      return { source: f.relPath, blocks };
    }),
  );

  const report = buildDriftReport(inputs, {
    rewordedThreshold: cfg.thresholds.reworded,
    aliases: cfg.aliases,
  });

  const pick = parsePickStrategy(opts.pick ?? "newest");
  const outPath = opts.stdout ? undefined : opts.out ?? "RULES.md";
  const { result, writtenTo } = await writeWeave(report, outPath, {
    pick,
    cwd: opts.cwd,
    onlyShared: opts.onlyShared === true,
    title: opts.title,
    omitHeader: opts.header === false,
  });

  if (opts.stdout) {
    process.stdout.write(result.markdown);
    return 0;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          writtenTo,
          sections: result.sections.map((s) => ({
            key: s.key,
            headingPath: s.headingPath,
            winnerSource: s.winnerSource,
            contributors: s.contributors,
            missingFrom: s.missingFrom,
          })),
          skipped: result.skipped,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(
    pc.bold(
      `🐕 wove ${result.sections.length} section${result.sections.length === 1 ? "" : "s"} into ${writtenTo}\n`,
    ),
  );
  for (const s of result.sections) {
    const head =
      s.headingPath.length > 0 ? s.headingPath.join(" > ") : "(preamble)";
    process.stdout.write(
      `  ${pc.cyan("→")} ${head} ${pc.dim(`← ${s.winnerSource}`)}\n`,
    );
  }
  if (result.skipped.length > 0) {
    process.stdout.write(
      pc.dim(`   (${result.skipped.length} group(s) skipped)\n`),
    );
  }
  return 0;
}

// CLI entrypoint (only when executed, not when imported by tests).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/cli.js") ||
  process.argv[1]?.endsWith("\\cli.js");

if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch((err) => {
    process.stderr.write(pc.red(`rule-herder: ${(err as Error).message}\n`));
    process.exit(1);
  });
}
