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
npx rule-herder diff
```

## Usage (planned)

```bash
rule-herder scan          # list detected agent files in this repo
rule-herder diff          # report drift between them (human-readable)
rule-herder diff --json   # machine-readable drift report (for CI / agents)
rule-herder herd          # interactive reconcile TUI  (M6)
```

`diff` exits non-zero when drift crosses your threshold, so it drops straight into CI or a
pre-commit hook.

## Roadmap

See [`PLAN.md`](./PLAN.md) for the full plan, milestones (M1–M6), and backlog.

## License

MIT
