import { Command } from "commander";
import pc from "picocolors";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { detectAgentFiles } from "./detect.js";
import { parseBlocks } from "./parse.js";
import { buildDriftReport } from "./match.js";
import { renderHuman, renderJson } from "./report.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import {
  planHerd,
  applyHerd,
  summarizePlan,
  type PickStrategy,
} from "./herd.js";
import { writeWeave } from "./weave.js";

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
}

function isPlainRulesFile(relPath: string): boolean {
  // Non-markdown agent files (e.g. .cursorrules / .windsurfrules) — treat as one blob.
  return !/\.md$/i.test(relPath);
}

export async function runDiff(opts: DiffOptions): Promise<number> {
  const cfg = await loadEffectiveConfig(opts.cwd, opts.config);
  const ignore = new Set(cfg.ignore);
  const files = (
    await detectAgentFiles({ cwd: opts.cwd, candidates: cfg.files })
  ).filter((f) => !ignore.has(f.relPath));
  const threshold = Number.isFinite(opts.threshold)
    ? (opts.threshold as number)
    : cfg.thresholds.drift;

  if (files.length === 0) {
    if (opts.json) {
      process.stdout.write(
        renderJson(
          { sources: [], groups: [], pairs: [], overall: 0 },
          { threshold },
        ),
      );
    } else {
      process.stdout.write(
        renderHuman(
          { sources: [], groups: [], pairs: [], overall: 0 },
          { noColor: opts.color === false, threshold },
        ),
      );
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

  if (opts.json) {
    process.stdout.write(renderJson(report, { threshold }));
  } else {
    process.stdout.write(
      renderHuman(report, {
        noColor: opts.color === false,
        threshold,
        woof: opts.woof === true,
      }),
    );
  }

  return report.overall > threshold ? 1 : 0;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("rule-herder")
    .description("A sheepdog for your sprawl of AI agent context files.")
    .version(pkg.version, "-v, --version", "print the rule-herder version");

  program
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
    .action(async (opts: DiffOptions) => {
      const code = await runDiff(opts);
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
