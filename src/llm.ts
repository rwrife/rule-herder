import type { DriftReport, DriftGroup } from "./match.js";
import { mergeGroupsByEquivalence, type EquivalencePair } from "./match.js";

/**
 * Opt-in LLM block-matcher.
 *
 * Rationale: the heuristic matcher keys blocks by `headingPath` (or the first
 * few normalized words for headless preambles). Two files can therefore carry
 * the *same rule* under different headings — `## Style` in one file, `## Code
 * conventions` in another — and the pure-heuristic pass will report both as
 * single-source `missing` groups instead of a shared drift group.
 *
 * The LLM pass is a **post-processing step** over an already-built
 * `DriftReport`. It looks *only* at groups the heuristic thinks are `missing`
 * (single-source), asks a caller-supplied `LLMProvider` to identify
 * semantically-equivalent pairs among them, and merges the confirmed pairs
 * into shared groups. The heuristic score is then recomputed for the merged
 * group so downstream renderers/exit-codes behave exactly as if the heuristic
 * had found the match itself.
 *
 * Design invariants:
 *  - **Offline by default.** Nothing in this module is invoked unless the
 *    caller explicitly wires it in (CLI flag `--llm-match` or explicit
 *    `config.llm.enabled = true`). The core `buildDriftReport` never imports
 *    this file.
 *  - **Provider-agnostic.** The `LLMProvider` interface takes candidate pairs
 *    in, returns matches out. We ship a real OpenAI-compatible HTTP provider
 *    (which also works with Ollama, LM Studio, llama.cpp, vLLM, etc.) and a
 *    deterministic `EchoProvider` for tests.
 *  - **Bounded work.** The candidate space is capped so we never make an
 *    unbounded number of comparisons even on huge flocks.
 */

/** A single candidate pair the provider is asked to judge. */
export interface CandidatePair {
  /** Stable identifier for the left group (its `DriftGroup.key`). */
  aKey: string;
  /** Stable identifier for the right group. */
  bKey: string;
  /** Presentation-only heading path for the left group. */
  aHeading: string[];
  /** Presentation-only heading path for the right group. */
  bHeading: string[];
  /** Source path of the (single) member of the left group. */
  aSource: string;
  /** Source path of the (single) member of the right group. */
  bSource: string;
  /** Raw body text of the left group's single member. */
  aBody: string;
  /** Raw body text of the right group's single member. */
  bBody: string;
}

/** A confirmed semantic match returned by the provider. */
export interface ProviderMatch {
  aKey: string;
  bKey: string;
  /** Provider confidence in [0, 1]. Callers may drop matches below a threshold. */
  confidence: number;
  /** Optional short rationale for debugging; never surfaced by default. */
  reason?: string;
}

/** Pluggable LLM backend. Implementations must be side-effect free w.r.t. inputs. */
export interface LLMProvider {
  /** Human-readable identifier for logging (`openai`, `echo`, ...). */
  readonly name: string;
  /**
   * Classify candidate pairs. Implementations may filter, batch, or reorder as
   * they see fit. Non-matches must simply be omitted from the returned array.
   */
  matchPairs(pairs: readonly CandidatePair[]): Promise<ProviderMatch[]>;
}

export interface EnrichOptions {
  /** Backend that will make the semantic-equivalence decisions. */
  provider: LLMProvider;
  /**
   * Only consider pairs whose token-set Jaccard is at least this large as
   * plausible candidates. Prevents shipping "war and peace" bodies to the
   * provider. Default 0.05 (essentially any lexical overlap).
   */
  minLexicalOverlap?: number;
  /**
   * Hard cap on candidate pairs sent to the provider per run. Prevents
   * accidental blow-ups on large flocks. Default 50.
   */
  maxCandidates?: number;
  /**
   * Drop matches with confidence below this threshold. Default 0.7.
   */
  minConfidence?: number;
}

export interface EnrichResult {
  report: DriftReport;
  /** Matches the provider returned (post-confidence-filter). */
  matches: ProviderMatch[];
  /** Candidate pairs that were considered. */
  candidatesConsidered: number;
}

/**
 * Enrich a `DriftReport` with semantically-equivalent group merges. Pure w.r.t.
 * the provider — swap `EchoProvider` in for a real backend when testing.
 */
export async function enrichReportWithLLM(
  report: DriftReport,
  options: EnrichOptions,
): Promise<EnrichResult> {
  const minOverlap = options.minLexicalOverlap ?? 0.05;
  const maxCandidates = options.maxCandidates ?? 50;
  const minConfidence = options.minConfidence ?? 0.7;

  const missing = report.groups.filter(
    (g) => g.status === "missing" && g.members.length === 1,
  );
  if (missing.length < 2) {
    return { report, matches: [], candidatesConsidered: 0 };
  }

  const candidates = buildCandidatePairs(missing, {
    minOverlap,
    maxCandidates,
  });
  if (candidates.length === 0) {
    return { report, matches: [], candidatesConsidered: 0 };
  }

  const raw = await options.provider.matchPairs(candidates);
  const matches = raw.filter(
    (m) =>
      typeof m.confidence === "number" &&
      m.confidence >= minConfidence &&
      m.aKey !== m.bKey,
  );

  const seen = new Set<string>();
  const equivalences: EquivalencePair[] = [];
  for (const m of matches) {
    // Normalize direction so we don't double-count.
    const [x, y] = m.aKey < m.bKey ? [m.aKey, m.bKey] : [m.bKey, m.aKey];
    const tag = `${x}::${y}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    equivalences.push({ aKey: x, bKey: y });
  }

  const merged = mergeGroupsByEquivalence(report, equivalences);
  return { report: merged, matches, candidatesConsidered: candidates.length };
}

interface CandidateOptions {
  minOverlap: number;
  maxCandidates: number;
}

/**
 * Build ordered candidate pairs from the `missing` groups. We rank by lexical
 * overlap (Jaccard on normalized bodies) descending so the highest-signal
 * pairs get through the `maxCandidates` cap first.
 */
export function buildCandidatePairs(
  missing: readonly DriftGroup[],
  opts: CandidateOptions,
): CandidatePair[] {
  interface Scored {
    pair: CandidatePair;
    score: number;
  }
  const scored: Scored[] = [];
  for (let i = 0; i < missing.length; i++) {
    for (let j = i + 1; j < missing.length; j++) {
      const a = missing[i];
      const b = missing[j];
      // Only present-single-source groups reach us; take that lone member.
      const am = a.members[0];
      const bm = b.members[0];
      // Skip trivially-empty bodies — nothing useful for a model to judge.
      if (!am.block.normalizedBody && !bm.block.normalizedBody) continue;
      const overlap = tokenOverlap(
        am.block.normalizedBody,
        bm.block.normalizedBody,
      );
      if (overlap < opts.minOverlap) continue;
      scored.push({
        score: overlap,
        pair: {
          aKey: a.key,
          bKey: b.key,
          aHeading: a.headingPath,
          bHeading: b.headingPath,
          aSource: am.source,
          bSource: bm.source,
          aBody: am.block.rawBody,
          bBody: bm.block.rawBody,
        },
      });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, opts.maxCandidates).map((s) => s.pair);
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 0;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* -------------------------------------------------------------------------- */
/*  Providers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic in-process provider. Uses a caller-supplied predicate to
 * decide equivalence — invaluable for tests and for scripted "custom rule"
 * matching without any network.
 */
export class EchoProvider implements LLMProvider {
  readonly name = "echo";
  constructor(
    private readonly decide: (pair: CandidatePair) => ProviderMatch | null,
  ) {}
  async matchPairs(pairs: readonly CandidatePair[]): Promise<ProviderMatch[]> {
    const out: ProviderMatch[] = [];
    for (const p of pairs) {
      const m = this.decide(p);
      if (m) out.push(m);
    }
    return out;
  }
}

/** Configuration for {@link OpenAIProvider}. */
export interface OpenAIProviderConfig {
  /** Base URL of an OpenAI-compatible `chat/completions` endpoint. */
  url: string;
  /** Model name to send in the request body. */
  model: string;
  /** API key. Optional — some local backends don't require one. */
  apiKey?: string;
  /** Request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Sampling temperature. Default 0 (deterministic). */
  temperature?: number;
  /**
   * Custom fetch — injected in tests, defaults to the global `fetch` on Node 18+.
   */
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible chat provider. Also works out-of-the-box with Ollama
 * (`http://localhost:11434/v1/chat/completions`), LM Studio, llama.cpp
 * `--api`, vLLM, and other back-ends that speak the same protocol.
 *
 * Contract with the model: given a JSON array of candidate pairs, return a
 * JSON array of `{a, b, equivalent, confidence, reason?}` objects — one per
 * input pair, in the same order. We only surface the ones the model marks as
 * `equivalent: true`.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  constructor(private readonly cfg: OpenAIProviderConfig) {
    if (!cfg.url) throw new Error("OpenAIProvider: `url` is required");
    if (!cfg.model) throw new Error("OpenAIProvider: `model` is required");
  }

  async matchPairs(pairs: readonly CandidatePair[]): Promise<ProviderMatch[]> {
    if (pairs.length === 0) return [];
    const fetchImpl = this.cfg.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "OpenAIProvider: no fetch implementation available. Use Node 18+ or pass fetchImpl.",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.cfg.timeoutMs ?? 30000,
    );

    const body = {
      model: this.cfg.model,
      temperature: this.cfg.temperature ?? 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt(pairs),
        },
      ],
      // Some backends respect this; harmless when ignored.
      response_format: { type: "json_object" },
    };

    let res: Response;
    try {
      res = await fetchImpl(this.cfg.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey
            ? { authorization: `Bearer ${this.cfg.apiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(
        `OpenAIProvider: request failed (${res.status} ${res.statusText})${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }
    const json = (await res.json()) as unknown;
    const content = extractContent(json);
    return parseModelDecisions(content, pairs);
  }
}

const SYSTEM_PROMPT = [
  "You are a strict semantic-equivalence judge for pairs of AI-agent rule blocks.",
  "For each numbered pair, decide whether the two rule bodies express the SAME requirement,",
  "even if they are worded differently or filed under different headings.",
  "Reply ONLY with a single JSON object of the form:",
  '  {"decisions":[{"index":<int>,"equivalent":<bool>,"confidence":<0..1>,"reason":"<short>"}]}',
  "One entry per input pair, in the same order. Do not include any prose outside the JSON.",
].join(" ");

function buildUserPrompt(pairs: readonly CandidatePair[]): string {
  const items = pairs.map((p, i) => ({
    index: i,
    a: {
      source: p.aSource,
      heading: p.aHeading,
      body: truncate(p.aBody, 1200),
    },
    b: {
      source: p.bSource,
      heading: p.bHeading,
      body: truncate(p.bBody, 1200),
    },
  }));
  return [
    "Classify these candidate rule pairs. Same intent = equivalent, even if reworded.",
    "Different rules that happen to share vocabulary are NOT equivalent.",
    "```json",
    JSON.stringify({ pairs: items }, null, 2),
    "```",
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

function extractContent(raw: unknown): string {
  const cc = raw as ChatCompletion;
  const content = cc?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(
      "OpenAIProvider: response missing `choices[0].message.content`",
    );
  }
  return content;
}

interface ModelDecision {
  index?: number;
  equivalent?: boolean;
  confidence?: number;
  reason?: string;
}

/**
 * Parse a model reply into `ProviderMatch[]`. Tolerates leading/trailing prose
 * around the JSON block and either `{decisions:[...]}` or a bare array.
 */
export function parseModelDecisions(
  content: string,
  pairs: readonly CandidatePair[],
): ProviderMatch[] {
  const parsed = extractJson(content);
  const decisions = normalizeDecisions(parsed);
  const out: ProviderMatch[] = [];
  for (const d of decisions) {
    if (d.equivalent !== true) continue;
    const idx = typeof d.index === "number" ? d.index : -1;
    if (idx < 0 || idx >= pairs.length) continue;
    const pair = pairs[idx];
    const conf =
      typeof d.confidence === "number" && Number.isFinite(d.confidence)
        ? Math.max(0, Math.min(1, d.confidence))
        : 0.5;
    out.push({
      aKey: pair.aKey,
      bKey: pair.bKey,
      confidence: conf,
      reason: typeof d.reason === "string" ? d.reason : undefined,
    });
  }
  return out;
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // Common case: pure JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through and try to find a JSON object substring.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Fall through.
    }
  }
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    try {
      return JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
    } catch {
      // Fall through.
    }
  }
  throw new Error("LLM reply did not contain parseable JSON");
}

function normalizeDecisions(parsed: unknown): ModelDecision[] {
  if (Array.isArray(parsed)) return parsed as ModelDecision[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.decisions)) return obj.decisions as ModelDecision[];
    if (Array.isArray(obj.pairs)) return obj.pairs as ModelDecision[];
    if (Array.isArray(obj.matches)) return obj.matches as ModelDecision[];
  }
  return [];
}
