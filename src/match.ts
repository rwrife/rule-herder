import type { Block } from "./parse.js";

/**
 * Classification of how a single rule-group has drifted across files.
 *
 * - `aligned`   — every source that has this block shares an identical body.
 * - `reworded`  — bodies differ but are highly similar (likely the same rule, restated).
 * - `conflict`  — bodies differ substantially; the rule has genuinely diverged.
 * - `missing`   — only one source carries this block at all; nothing to compare against.
 *
 * A group may *also* be incomplete (i.e. present in some sources but not all). That is
 * tracked separately on `missingFrom` and does not by itself promote the status to
 * `conflict` — it is reflected in the numeric drift score.
 */
export type GroupStatus = "aligned" | "reworded" | "missing" | "conflict";

export interface GroupMember {
  source: string;
  block: Block;
}

export interface DriftGroup {
  /** Stable matching key (lowercased joined heading path, or normalized-first-line for plain). */
  key: string;
  /** Heading path of the first member (presentation only). */
  headingPath: string[];
  /** One entry per source file that carries this block. */
  members: GroupMember[];
  /** Sources known to the report that did NOT contribute a block to this group. */
  missingFrom: string[];
  status: GroupStatus;
  /** 0 = perfectly aligned across all known sources, 1 = fully divergent. */
  score: number;
}

export interface DriftPair {
  a: string;
  b: string;
  /** 0 = identical flock, 1 = fully divergent. */
  score: number;
}

export interface DriftReport {
  /** All source files considered, in the order supplied. */
  sources: string[];
  /** Matched/unmatched block groups. */
  groups: DriftGroup[];
  /** Pairwise drift scores between every distinct pair of sources. */
  pairs: DriftPair[];
  /** Overall flock drift score: mean of group scores (0 if no groups). */
  overall: number;
}

export interface MatchOptions {
  /**
   * Threshold above which two normalized bodies count as "reworded" rather than `conflict`.
   * Compared against a Jaccard token-set similarity. Default 0.6.
   */
  rewordedThreshold?: number;
  /**
   * Heading-path aliases: canonical key → equivalent normalized heading paths
   * (`parent > child`, lowercased). When a block's natural key matches a variant,
   * it is remapped onto the canonical key so differently-worded headings group together.
   */
  aliases?: Record<string, string[]>;
}

/** Split a normalized body into a token set for Jaccard comparison. */
function tokens(normalized: string): Set<string> {
  if (!normalized) return new Set();
  return new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
}

/** Jaccard similarity over token sets. Two empty bodies are defined as identical (1). */
export function jaccard(a: string, b: string): number {
  if (a === b) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Compute a stable matching key for a block.
 *
 * Strategy (documented heuristic):
 *  1. If the block has a heading path, the key is the lowercased path joined by `>`.
 *  2. Otherwise (preamble / plain rules file), the key is `~plain:<first normalized line>`,
 *     i.e. the first non-empty normalized line, so reworded preambles still co-locate.
 */
export function blockKey(block: Block): string {
  if (block.headingPath.length > 0) {
    return block.headingPath.map((h) => h.trim().toLowerCase()).join(" > ");
  }
  const firstLine = block.normalizedBody.split(" ").slice(0, 6).join(" ");
  return `~plain:${firstLine}`;
}

interface InputFile {
  source: string;
  blocks: Block[];
}

/** Average pairwise Jaccard across all *present* members of a group. 1 if <2 members. */
function avgPairwiseSimilarity(members: GroupMember[]): number {
  if (members.length < 2) return 1;
  let total = 0;
  let count = 0;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      total += jaccard(
        members[i].block.normalizedBody,
        members[j].block.normalizedBody,
      );
      count++;
    }
  }
  return count === 0 ? 1 : total / count;
}

function classifyGroup(
  members: GroupMember[],
  rewordedThreshold: number,
): GroupStatus {
  if (members.length < 2) return "missing";
  const bodies = new Set(members.map((m) => m.block.normalizedBody));
  if (bodies.size === 1) return "aligned";
  const sim = avgPairwiseSimilarity(members);
  return sim >= rewordedThreshold ? "reworded" : "conflict";
}

/**
 * Compute the drift score for a single group.
 *
 * Documented heuristic:
 *   coveragePenalty = 1 - presentSources / totalSources
 *   bodyPenalty     = 1 - avgPairwiseJaccard(presentSources)   (0 if <2 present)
 *   score           = 0.5 * coveragePenalty + 0.5 * bodyPenalty
 *
 * The two halves are weighted equally so that "rule missing from half the flock" and
 * "rule fully contradictory between two files" land in the same ballpark.
 */
function groupScore(members: GroupMember[], totalSources: number): number {
  const present = members.length;
  const coveragePenalty = totalSources === 0 ? 0 : 1 - present / totalSources;
  const bodyPenalty = present < 2 ? 0 : 1 - avgPairwiseSimilarity(members);
  return clamp01(0.5 * coveragePenalty + 0.5 * bodyPenalty);
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Pairwise drift between two sources `a` and `b`.
 *
 * For every group that has a member in `a` or `b`:
 *  - both present → contributes (1 - jaccard(body_a, body_b))
 *  - one present  → contributes 1 (full divergence on that rule)
 *
 * The pair score is the mean contribution, or 0 when no shared groups exist
 * (no rules to disagree about ⇒ no drift).
 */
function pairScore(
  a: string,
  b: string,
  groups: DriftGroup[],
): number {
  let total = 0;
  let count = 0;
  for (const g of groups) {
    const ma = g.members.find((m) => m.source === a);
    const mb = g.members.find((m) => m.source === b);
    if (!ma && !mb) continue;
    if (ma && mb) {
      total += 1 - jaccard(ma.block.normalizedBody, mb.block.normalizedBody);
    } else {
      total += 1;
    }
    count++;
  }
  return count === 0 ? 0 : clamp01(total / count);
}

/**
 * Build a DriftReport from already-parsed per-source block lists.
 *
 * Matching is keyed by `blockKey(block)`; if a single source contributes multiple
 * blocks under the same key (e.g. two `## Rules` sections), only the first is taken
 * and the rest are dropped from matching — callers should normalize headings upstream
 * if that becomes a problem in practice.
 */
export function buildDriftReport(
  inputs: readonly InputFile[],
  options: MatchOptions = {},
): DriftReport {
  const rewordedThreshold = options.rewordedThreshold ?? 0.6;
  const sources = inputs.map((i) => i.source);

  // Build variant → canonical lookup once.
  const aliasLookup = new Map<string, string>();
  if (options.aliases) {
    for (const [canonical, variants] of Object.entries(options.aliases)) {
      for (const v of variants) {
        if (v) aliasLookup.set(v, canonical);
      }
    }
  }
  const remap = (key: string): string => aliasLookup.get(key) ?? key;

  // Preserve first-seen order of keys for stable output.
  const order: string[] = [];
  const byKey = new Map<
    string,
    { headingPath: string[]; members: GroupMember[]; seen: Set<string> }
  >();

  for (const { source, blocks } of inputs) {
    for (const block of blocks) {
      const key = remap(blockKey(block));
      let entry = byKey.get(key);
      if (!entry) {
        entry = { headingPath: block.headingPath, members: [], seen: new Set() };
        byKey.set(key, entry);
        order.push(key);
      }
      if (entry.seen.has(source)) continue; // ignore duplicates within a single file
      entry.seen.add(source);
      entry.members.push({ source, block });
    }
  }

  const groups: DriftGroup[] = order.map((key) => {
    const entry = byKey.get(key)!;
    const presentSources = new Set(entry.members.map((m) => m.source));
    const missingFrom = sources.filter((s) => !presentSources.has(s));
    const status = classifyGroup(entry.members, rewordedThreshold);
    const score = groupScore(entry.members, sources.length);
    return {
      key,
      headingPath: entry.headingPath,
      members: entry.members,
      missingFrom,
      status,
      score,
    };
  });

  const pairs: DriftPair[] = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      pairs.push({
        a: sources[i],
        b: sources[j],
        score: pairScore(sources[i], sources[j], groups),
      });
    }
  }

  const overall =
    groups.length === 0
      ? 0
      : clamp01(groups.reduce((s, g) => s + g.score, 0) / groups.length);

  return { sources, groups, pairs, overall };
}
