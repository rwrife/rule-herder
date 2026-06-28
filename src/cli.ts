import { Command } from "commander";
import pc from "picocolors";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { detectAgentFiles } from "./detect.js";
import { parseBlocks } from "./parse.js";
import { buildDriftReport } from "./match.js";
import { renderHuman, renderJson } from "./report.js";
import { loadConfig, type LoadedConfig } from "./config.js";

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
      renderHuman(report, { noColor: opts.color === false, threshold }),
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
