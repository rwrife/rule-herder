# rule-herder 🐕

> A sheepdog for your sprawl of AI agent context files.

## 1. Pitch

Every coding agent wants its own instructions file — `AGENTS.md`, `CLAUDE.md`,
`.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, `GEMINI.md` —
and they all drift apart the moment you edit one and forget the rest. **rule-herder**
treats those scattered files as a flock: it sniffs out where they've *drifted*,
shows you a side-by-side diff of the conflicting rules, and herds them back into one
coherent source of truth. Think `git diff` for your agent rules, with a dog that nags.

## 2. Trend inspiration

What I saw on the web (week of 2026-06-18) that pointed here:

- **Agent infrastructure is standardizing fast.** Product Hunt's weekly roundup
  ([shareuhack 2026-06-18](https://www.shareuhack.com/en/posts/product-hunt-weekly-2026-06-18))
  led with "AI agents shift from assistive to autonomous execution" and featured
  *Novu Connect* ("let agents communicate where users already are") and *Terminal Mode
  by Even Realities* ("keep coding agents always in sight"). The plumbing around agents
  is the hot layer right now.
- **Context portability is a named pain.** *Goldfish* (#2 that week) sells purely on
  "it knows your work context and replies like you" — proof that *managing context*
  is a product category, not a footnote.
- **Terminal renaissance.** Multiple 2026 roundups
  ([Terminal Trove new](https://terminaltrove.com/new/),
  ["Terminal Renaissance" 1337skills](https://1337skills.com/blog/2026-03-09-terminal-renaissance-modern-tui-tools-reshaping-developer-workflows/))
  confirm TUIs are having their best year — a good surface for a reconcile UI.
- **The lived pain:** the multi-agent era means a single repo now carries 3–6 overlapping
  instruction files maintained by hand. Nobody keeps them in sync. That's the gap.

## 3. Why it's different

There *is* prior art for "generate many agent files from one source" — most notably
`rulesync` (npm) and a handful of `.cursorrules` generators. **rule-herder deliberately
goes the other direction:**

- **Drift-first, not generate-first.** It assumes the files already exist and have already
  diverged (the real-world state). Its core verb is `diff`, not `init`. You don't have to
  adopt a new canonical format or rewrite your repo to get value on day one.
- **Semantic-ish drift, not byte diff.** It splits each file into rule *blocks* (headings /
  bullet groups) and matches blocks across files, so "same rule, reworded" reads as a soft
  drift, not a hard conflict.
- **Reconcile, don't overwrite.** A TUI lets you pick the winning version of each drifted
  block and write it back to all targets — merge-tool ergonomics, not a one-way generator.
- **It has a dog.** Personality-forward output (herding/sheepdog metaphor, a `--woof`
  nag mode, drift "scent" scores). The existing tools are humorless.

Contrast with the neighbors already in this lab: this is *not* a SKILL.md linter
(`skill-sniffer`), *not* a prompt-injection tripwire (`canary-cage`), and *not* a decision
ledger (`ship-log`). It's purely about **keeping N agent-instruction files mutually consistent.**

## 4. MVP scope (v0.1)

The smallest useful thing:

- `rule-herder scan` — auto-detect known agent files in the cwd (configurable glob set).
- `rule-herder diff` — parse each into rule blocks, match blocks across files, and print a
  drift report: which rules are missing from some files, which conflict, a per-pair "drift
  score."
- Plain, colorized terminal output (no TUI yet) — exit non-zero when drift exceeds a
  threshold so it works in CI / pre-commit.
- A tiny, documented block-matching heuristic (heading text + normalized first line).
- `--json` output so agents/scripts can consume it.

That's it. No writing-back, no TUI, no config file required in v0.1.

## 5. Tech stack

Boring, fast, batteries-included:

- **Node.js + TypeScript**, distributed as a single `npx rule-herder` CLI. Rationale: the
  audience already has Node, zero-install via `npx`, and these files are small so perf is a
  non-issue.
- **commander** for arg parsing, **picocolors** for color, **diff** (jsdiff) for block-level
  comparison. All tiny, zero-drama deps.
- **vitest** for tests. **tsup** to bundle to a single file.
- TUI (later milestone) via **Ink** (React-for-terminals) — popular, well-trodden.

No database, no network calls, no LLM in the core path. Pure local file parsing → it's fast,
private, and trivially CI-friendly. (An *optional* LLM block-matcher is a backlog item, not core.)

## 6. Architecture

```
src/
  cli.ts          # commander entrypoint: scan | diff | (later) herd
  detect.ts       # find candidate agent files via known globs + overrides
  parse.ts        # file -> Block[] (heading path, normalized text, raw range)
  match.ts        # cross-file block matching + drift scoring
  report.ts       # human (colorized) + --json renderers
  config.ts       # optional .ruleherder.json (globs, thresholds, aliases)
```

Key data type: a `Block` (source file, heading path, normalized body, raw text, line span)
and a `DriftReport` (matched groups, per-group status: `aligned | reworded | missing | conflict`,
scores). Everything downstream (TUI, write-back) consumes `DriftReport`.

## 7. Milestones

1. **M1 — Scaffold + hello-world.** TS project, `tsup` build, `rule-herder --version`/`--help`,
   `rule-herder scan` prints detected files in cwd. CI runs build + lint.
2. **M2 — Block parser.** `parse.ts` turns a markdown agent file into `Block[]` with heading
   paths and normalized bodies. Unit tests over fixtures.
3. **M3 — Drift engine.** `match.ts` matches blocks across files and classifies each group
   (`aligned/reworded/missing/conflict`) with a documented scoring heuristic.
4. **M4 — `diff` command + reporters.** Wire parser+engine into `rule-herder diff` with a
   colorized human report and `--json`; non-zero exit on threshold breach.
5. **M5 — Config + presets.** `.ruleherder.json` for custom globs, ignore rules, block
   aliases, and drift thresholds; ship sensible defaults for the common agent files.
6. **M6 — `herd` reconcile (Ink TUI).** Interactive pass over conflicting/missing blocks:
   pick the winning version, write it back to selected targets, summary of changes.

## 8. Backlog / future features (v0.2+)

1. **`--woof` nag mode** — escalating sheepdog commentary the worse the drift gets.
2. **pre-commit hook + GitHub Action** — fail the build (or auto-comment) on new drift.
3. **LLM block-matcher (opt-in)** — use a local/remote model to match semantically-equivalent
   rules that the heuristic misses; fully offline by default.
4. **Canonical export** — `rule-herder weave` to emit a single merged `RULES.md` from the flock.
5. **Per-agent dialect awareness** — know that Cursor uses globs/scopes, Copilot has its own
   front-matter, etc., and treat tool-specific sections as intentionally divergent.
6. **Drift history** — stash prior `DriftReport`s and show "drift over time" / who diverged.
7. **`watch` mode** — re-run on save and surface drift live in the terminal.
8. **Ignore directives** — inline `<!-- herder:ignore -->` to mark intentionally-different blocks.
9. **Monorepo mode** — herd across many packages, roll up a repo-wide drift score.
10. **Shareable presets** — community glob/alias packs for new agent tools as they appear.
11. **HTML/markdown report** — a static drift report artifact for PRs.
12. **Block provenance** — annotate where each canonical rule "won" from after a herd.

## 9. Out of scope

- We are **not** building a new canonical agent-instruction format or standard.
- We are **not** generating agent files from scratch / scaffolding new projects (that's
  `rulesync`'s lane).
- **No** cloud service, account, or telemetry — local CLI only.
- **No** runtime enforcement of the rules on the agents themselves; we only keep the *files*
  consistent.
- **No** general-purpose markdown diffing — scope is agent-context files specifically.
