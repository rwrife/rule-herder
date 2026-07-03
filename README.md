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
rule-herder diff --woof    # add escalating sheepdog commentary (cosmetic; ignored with --json)
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

## CI / pre-commit integration (M-backlog ✅)

Keep drift from sneaking into `main` by wiring `rule-herder diff` into your existing
checks.

### GitHub Action

A reusable composite action lives at the repo root (`action.yml`). Drop this into
`.github/workflows/rule-herder.yml`:

```yaml
name: rule-herder
on:
  pull_request:
  push:
    branches: [main]

jobs:
  drift:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write   # only needed when comment-on-pr: 'true'
    steps:
      - uses: actions/checkout@v4
      - uses: rwrife/rule-herder@main
        with:
          version: latest        # or pin to a release tag
          threshold: "0.2"       # forwarded to --threshold
          comment-on-pr: "true"  # leave a sticky 🐕 drift comment on PRs
          fail-on-drift: "true"  # set to 'false' to comment without failing
```

See [`examples/github-actions/rule-herder.yml`](./examples/github-actions/rule-herder.yml)
for a copy-pasteable workflow. Action inputs:

| Input | Default | Notes |
| --- | --- | --- |
| `version` | `latest` | npm version (or git ref) of rule-herder to run via `npx`. Use `local` to build and run the repo's own checkout. |
| `working-directory` | `.` | Where to run the check. |
| `threshold` | _(none)_ | Forwarded as `--threshold`. |
| `config` | _(none)_ | Path to `.ruleherder.json`. |
| `json` | `false` | Emit `--json` (still fails on drift). |
| `comment-on-pr` | `false` | Post / update a sticky drift comment on the PR. |
| `fail-on-drift` | `true` | Set to `false` to report without failing the job. |
| `node-version` | `20` | `actions/setup-node` version. Use `skip` to reuse an existing Node. |

Outputs: `exit-code` (the `rule-herder diff` exit status) and `report` (captured stdout).

### pre-commit hook

The repo ships a [pre-commit](https://pre-commit.com) hook manifest. Add to your
`.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/rwrife/rule-herder
    rev: main          # or pin to a release tag
    hooks:
      - id: rule-herder
```

The hook only triggers when an agent rule file (or `.ruleherder.json`) changes, then runs
`rule-herder diff` and blocks the commit if drift exceeds your threshold. There's also a
system-language `rule-herder-diff` variant that always pulls the latest release via `npx`
without building from source.

## Canonical export (`weave`)

When you want *one* source of truth instead of N drifted files, `weave` merges the
flock into a single `RULES.md`:

```bash
npx rule-herder weave              # writes ./RULES.md (newest block wins)
npx rule-herder weave --pick longest
npx rule-herder weave --pick source=AGENTS.md
npx rule-herder weave --only-shared    # drop blocks only one file carried
npx rule-herder weave --stdout         # print instead of writing
npx rule-herder weave --title "Project Rules"
```

Winner selection reuses the `herd` strategies (`newest` / `longest` /
`source=<path>`). Preambles land above headed sections, heading depth is
preserved, and a `<!-- generated by rule-herder weave -->` marker sits at the
top so humans know not to hand-edit.

## LLM matcher (opt-in, offline by default)

The pure-heuristic matcher keys blocks by heading path, so two files can carry
**the same rule under different headings** (`## Style` vs `## Formatting`) and
both show up as single-source `missing` groups. The opt-in LLM matcher makes
a post-pass over those `missing` groups, asks an OpenAI-compatible model whether
any of them are semantically the same rule, and merges the confirmed pairs
into real drift groups.

**No network calls happen unless you explicitly opt in.** The core `diff` /
`herd` / `weave` commands never touch the LLM path.

### Local backend (recommended: Ollama, LM Studio, llama.cpp, vLLM)

```bash
npx rule-herder diff \
  --llm-match \
  --llm-url http://localhost:11434/v1/chat/completions \
  --llm-model llama3.1
```

### OpenAI or any hosted OpenAI-compatible endpoint

```bash
export RULE_HERDER_LLM_URL=https://api.openai.com/v1/chat/completions
export RULE_HERDER_LLM_MODEL=gpt-4o-mini
export RULE_HERDER_LLM_KEY=sk-...
npx rule-herder diff --llm-match
```

### Config file

You can also enable it in `.ruleherder.json`. When `llm.enabled: true` is set
in config, `diff` runs the pass without `--llm-match` on every invocation:

```json
{
  "llm": {
    "enabled": true,
    "url": "http://localhost:11434/v1/chat/completions",
    "model": "llama3.1",
    "minConfidence": 0.75,
    "maxCandidates": 40
  }
}
```

### Flags

| Flag | Env | Default | Purpose |
| ---- | --- | ------- | ------- |
| `--llm-match` | — | off | Enable the pass for this invocation. |
| `--llm-url <url>` | `RULE_HERDER_LLM_URL` | — | OpenAI-compatible `chat/completions` URL. |
| `--llm-model <name>` | `RULE_HERDER_LLM_MODEL` | — | Model identifier sent in the request body. |
| `--llm-key <key>` | `RULE_HERDER_LLM_KEY` | — | API key (local backends usually don't need one). |
| `--llm-min-confidence <n>` | — | `0.7` | Drop matches below this confidence. |
| `--llm-max-candidates <n>` | — | `50` | Hard cap on pairs sent to the model per run. |

Merged groups replace their component `missing` groups in the report — the
drift score, pairwise scores, and `--json` output all reflect the enriched
result. If the LLM call fails, `rule-herder` prints a warning and falls back
to the heuristic-only report (never fails the whole `diff`).

## Roadmap

See [`PLAN.md`](./PLAN.md) for the full plan, milestones (M1–M6), and backlog.

## License

MIT
