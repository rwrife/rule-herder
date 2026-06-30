// Thin wrapper used by the pre-commit framework. Forwards any extra args to
// `rule-herder diff` and exits with its status code.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "cli.js");

const result = spawnSync(process.execPath, [cli, "diff", ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`[rule-herder] failed to launch CLI: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
