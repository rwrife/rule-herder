import { Command } from "commander";
import pc from "picocolors";
import { createRequire } from "node:module";
import { detectAgentFiles } from "./detect.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

interface ScanOptions {
  cwd: string;
  json?: boolean;
}

export async function runScan(opts: ScanOptions): Promise<number> {
  const files = await detectAgentFiles({ cwd: opts.cwd });

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

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("rule-herder")
    .description("A sheepdog for your sprawl of AI agent context files.")
    .version(pkg.version, "-v, --version", "print the rule-herder version");

  program
    .command("scan")
    .description("list detected agent files in the current directory")
    .option("--cwd <path>", "directory to scan", process.cwd())
    .option("--json", "emit machine-readable JSON", false)
    .action(async (opts: ScanOptions) => {
      const code = await runScan(opts);
      process.exitCode = code;
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
