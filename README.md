# rule-herder 🐕

**A sheepdog for your sprawl of AI agent context files.**

`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`,
`.windsurfrules`, `GEMINI.md`… every coding agent wants its own instructions file, and
they all drift apart the second you edit one and forget the rest. `rule-herder` sniffs out
where your rule files have **drifted**, shows you exactly which rules conflict or went
missing, and (eventually) herds them back into one coherent flock.

Think **`git diff` for your agent rules** — with a dog that nags.

> Status: 🚧 early. v0.1 is drift detection (`scan` + `diff`). Reconcile TUI comes in M6.

## Why

The multi-agent era means a single repo now carries 3–6 overlapping instruction files
maintained by hand. Nobody keeps them in sync. Existing tools mostly *generate* many files
from one source; `rule-herder` goes the other way — it takes your already-divergent files
as reality and tells you where the flock scattered.

## Install

```bash
# once published
npx rule-herder scan
```

Local dev:

```bash
npm install
npm run build
node dist/cli.js scan
```

## Usage

```bash
rule-herder scan           # list detected agent files in this repo (M1 ✅)
rule-herder scan --json    # machine-readable list
rule-herder diff           # report drift between them (M4 ✅)
rule-herder diff --json    # machine-readable drift report
rule-herder diff --threshold 0.3   # exit 1 when overall drift exceeds 0.3
rule-herder config         # print the effective config (M5 ✅)
rule-herder herd           # dry-run reconcile: who would overwrite whom (M6, in progress)
rule-herder herd --apply   # actually rewrite drifted blocks to the winner
rule-herder herd --pick longest --apply        # pick longest body as winner
rule-herder herd --pick source=AGENTS.md --apply  # pick a specific file as truth
rule-herder herd --target CLAUDE.md --apply    # only rewrite this target file
rule-herder herd --apply --backup              # write <file>.bak before overwriting
```

`scan` looks for the known agent files in the cwd:
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`,
`.github/copilot-instructions.md`.

`diff` exits non-zero when drift crosses your threshold, so it drops straight into CI or a
pre-commit hook.

`herd` reconciles drift non-interactively (the Ink TUI is the next slice on top of this):
it picks a winning version per drifted group and rewrites every other source's matching
block body to match. Defaults are safe — dry-run unless `--apply`, and `--backup` snapshots
`<file>.bak` next to each modified file. Pick strategies:

- `--pick newest` (default) — newest source-file mtime wins.
- `--pick longest` — longest block body wins.
- `--pick source=<path>` — that file is the source of truth.

Only `conflict` and `reworded` groups are touched. `missing` groups (rule present in only
one source) are reported in the skipped list and left alone — auto-inserting new blocks is
the interactive TUI's job.

## Configuration (M5 ✅)

Drop a `.ruleherder.json` at the project root to override the defaults. Every field is
optional.

```json
{
  "extends": ["docs/AGENTS.md"],
  "ignore": ["CLAUDE.md"],
  "aliases": {
    "rules": ["Guidelines", "Conventions > Rules"]
  },
  "thresholds": { "drift": 0.25, "reworded": 0.55 }
}
```

| Field | What it does |
| --- | --- |
| `files` | Replace the default candidate list outright. |
| `extends` | Add extra paths to the default candidate list. |
| `ignore` | Drop specific paths from detection. |
| `aliases` | `canonical → [variant heading paths]`. Paths are case-insensitive and use `Parent > Child`. Equivalents collapse into one drift group. |
| `thresholds.drift` | Overall drift threshold (`diff` exits 1 above this). Default `0.2`. |
| `thresholds.reworded` | Body similarity above which two blocks are "reworded" instead of "conflict". Default `0.6`. |

Flags override config: `--threshold` beats `thresholds.drift`, `--config <path>` points at
a non-default config file. Run `rule-herder config` to print the fully-resolved config
rule-herder is actually using.

## Roadmap

See [`PLAN.md`](./PLAN.md) for the full plan, milestones (M1–M6), and backlog.

## License

MIT
