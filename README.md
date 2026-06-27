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
rule-herder herd           # interactive reconcile TUI (M6 — planned)
```

`scan` looks for the known agent files in the cwd:
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`,
`.github/copilot-instructions.md`.

`diff` exits non-zero when drift crosses your threshold, so it drops straight into CI or a
pre-commit hook.

## Roadmap

See [`PLAN.md`](./PLAN.md) for the full plan, milestones (M1–M6), and backlog.

## License

MIT
