import { describe, it, expect } from "vitest";
import { parseBlocks } from "../src/parse.js";
import { buildDriftReport } from "../src/match.js";
import {
  EchoProvider,
  OpenAIProvider,
  buildCandidatePairs,
  enrichReportWithLLM,
  parseModelDecisions,
  type CandidatePair,
  type LLMProvider,
  type ProviderMatch,
} from "../src/llm.js";

function parse(source: string, content: string) {
  return { source, blocks: parseBlocks(source, content) };
}

describe("buildCandidatePairs", () => {
  it("returns pairs sorted by lexical overlap desc, capped by maxCandidates", () => {
    const a = parse("a.md", "# Style\ntabs everywhere please\n");
    const b = parse("b.md", "# Formatting\ntabs everywhere please\n");
    const c = parse("c.md", "# Woof\nsheepdog metaphor barking loudly\n");
    const report = buildDriftReport([a, b, c]);
    const missing = report.groups.filter((g) => g.status === "missing");
    // sanity: three missing groups, three possible pairs.
    expect(missing).toHaveLength(3);

    const pairs = buildCandidatePairs(missing, {
      minOverlap: 0,
      maxCandidates: 10,
    });
    // The identical-body pair should come first.
    expect(pairs[0].aKey === "style" || pairs[0].bKey === "style").toBe(true);
    expect(pairs[0].aKey === "formatting" || pairs[0].bKey === "formatting").toBe(true);
  });

  it("filters pairs below minLexicalOverlap and honours the cap", () => {
    const a = parse("a.md", "# One\nalpha beta gamma\n");
    const b = parse("b.md", "# Two\nalpha beta gamma\n");
    const c = parse("c.md", "# Three\ntotally unrelated words here\n");
    const report = buildDriftReport([a, b, c]);
    const missing = report.groups.filter((g) => g.status === "missing");

    const strict = buildCandidatePairs(missing, {
      minOverlap: 0.5,
      maxCandidates: 10,
    });
    // Only the identical-content pair survives.
    expect(strict).toHaveLength(1);

    const capped = buildCandidatePairs(missing, {
      minOverlap: 0,
      maxCandidates: 1,
    });
    expect(capped).toHaveLength(1);
  });
});

describe("EchoProvider", () => {
  it("returns whatever the decision function returns for each pair", async () => {
    const decide = (p: CandidatePair): ProviderMatch | null =>
      p.aBody === p.bBody
        ? { aKey: p.aKey, bKey: p.bKey, confidence: 0.9 }
        : null;
    const provider = new EchoProvider(decide);
    const pairs: CandidatePair[] = [
      {
        aKey: "x",
        bKey: "y",
        aHeading: [],
        bHeading: [],
        aSource: "a.md",
        bSource: "b.md",
        aBody: "same",
        bBody: "same",
      },
      {
        aKey: "y",
        bKey: "z",
        aHeading: [],
        bHeading: [],
        aSource: "b.md",
        bSource: "c.md",
        aBody: "one",
        bBody: "two",
      },
    ];
    const out = await provider.matchPairs(pairs);
    expect(out).toHaveLength(1);
    expect(out[0].aKey).toBe("x");
  });
});

describe("enrichReportWithLLM", () => {
  it("no-ops when there is less than one candidate pair to consider", async () => {
    const a = parse("a.md", "# Style\ntabs\n");
    const report = buildDriftReport([a]);
    const provider: LLMProvider = {
      name: "should-not-run",
      matchPairs: async () => {
        throw new Error("must not be called");
      },
    };
    const out = await enrichReportWithLLM(report, { provider });
    expect(out.report).toBe(report);
    expect(out.matches).toEqual([]);
    expect(out.candidatesConsidered).toBe(0);
  });

  it("merges provider-approved semantic pairs into a single group", async () => {
    const a = parse("a.md", "# Style\ntabs for indent\n");
    const b = parse("b.md", "# Formatting\ntabs for indentation\n");
    const before = buildDriftReport([a, b]);
    // Different headings + body similarity below reworded threshold → two `missing` groups.
    expect(before.groups).toHaveLength(2);

    const provider = new EchoProvider(() => ({
      aKey: "style",
      bKey: "formatting",
      confidence: 0.95,
    }));
    const out = await enrichReportWithLLM(before, { provider });
    expect(out.matches).toHaveLength(1);
    expect(out.report.groups).toHaveLength(1);
    expect(out.report.groups[0].members.map((m) => m.source).sort()).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("respects minConfidence and drops low-confidence matches", async () => {
    const a = parse("a.md", "# Style\ntabs for indent\n");
    const b = parse("b.md", "# Formatting\ntabs for indent\n");
    const report = buildDriftReport([a, b]);
    const provider = new EchoProvider(() => ({
      aKey: "style",
      bKey: "formatting",
      confidence: 0.4,
    }));
    const out = await enrichReportWithLLM(report, {
      provider,
      minConfidence: 0.9,
    });
    expect(out.matches).toEqual([]);
    // Report unchanged when nothing merges.
    expect(out.report.groups).toHaveLength(2);
  });

  it("ignores self-pairs and duplicate directions", async () => {
    const a = parse("a.md", "# Style\ntabs\n");
    const b = parse("b.md", "# Formatting\ntabs\n");
    const report = buildDriftReport([a, b]);
    let call = 0;
    const provider: LLMProvider = {
      name: "chatty",
      matchPairs: async (pairs) => {
        call++;
        // Return both directions + a self-pair; enrichment must dedupe.
        return [
          { aKey: pairs[0].aKey, bKey: pairs[0].bKey, confidence: 0.9 },
          { aKey: pairs[0].bKey, bKey: pairs[0].aKey, confidence: 0.9 },
          { aKey: pairs[0].aKey, bKey: pairs[0].aKey, confidence: 1 },
        ];
      },
    };
    const out = await enrichReportWithLLM(report, { provider });
    expect(call).toBe(1);
    // Self-pair filtered, but both directions survived filtering.
    expect(out.matches).toHaveLength(2);
    // ...and de-duped before hitting the merger, so we still end up with one group.
    expect(out.report.groups).toHaveLength(1);
  });
});

describe("parseModelDecisions", () => {
  const pairs: CandidatePair[] = [
    {
      aKey: "style",
      bKey: "formatting",
      aHeading: ["Style"],
      bHeading: ["Formatting"],
      aSource: "a.md",
      bSource: "b.md",
      aBody: "tabs",
      bBody: "tabs",
    },
  ];

  it("parses the canonical {decisions:[...]} shape", () => {
    const content = JSON.stringify({
      decisions: [{ index: 0, equivalent: true, confidence: 0.88 }],
    });
    const out = parseModelDecisions(content, pairs);
    expect(out).toHaveLength(1);
    expect(out[0].aKey).toBe("style");
    expect(out[0].confidence).toBe(0.88);
  });

  it("tolerates a bare array reply", () => {
    const content = JSON.stringify([
      { index: 0, equivalent: true, confidence: 0.6 },
    ]);
    const out = parseModelDecisions(content, pairs);
    expect(out).toHaveLength(1);
  });

  it("extracts JSON from prose-wrapped replies", () => {
    const content =
      "Sure! Here you go:\n```json\n" +
      JSON.stringify({
        decisions: [{ index: 0, equivalent: true, confidence: 0.75 }],
      }) +
      "\n```\nHope that helps!";
    const out = parseModelDecisions(content, pairs);
    expect(out).toHaveLength(1);
  });

  it("drops decisions marked equivalent:false", () => {
    const content = JSON.stringify({
      decisions: [{ index: 0, equivalent: false, confidence: 0.99 }],
    });
    expect(parseModelDecisions(content, pairs)).toEqual([]);
  });

  it("clamps out-of-range confidence into [0, 1]", () => {
    const content = JSON.stringify({
      decisions: [{ index: 0, equivalent: true, confidence: 5 }],
    });
    const [m] = parseModelDecisions(content, pairs);
    expect(m.confidence).toBe(1);
  });

  it("ignores decisions referencing out-of-range indices", () => {
    const content = JSON.stringify({
      decisions: [
        { index: 42, equivalent: true, confidence: 1 },
        { index: -1, equivalent: true, confidence: 1 },
      ],
    });
    expect(parseModelDecisions(content, pairs)).toEqual([]);
  });

  it("throws when the reply contains no parseable JSON at all", () => {
    expect(() => parseModelDecisions("not json here", pairs)).toThrow(
      /parseable JSON/,
    );
  });
});

describe("OpenAIProvider", () => {
  const basePair: CandidatePair = {
    aKey: "style",
    bKey: "formatting",
    aHeading: ["Style"],
    bHeading: ["Formatting"],
    aSource: "a.md",
    bSource: "b.md",
    aBody: "tabs for indent",
    bBody: "tabs for indentation",
  };

  it("posts to the configured URL with model + auth headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fakeFetch = async (input: string | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedInit = init;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decisions: [{ index: 0, equivalent: true, confidence: 0.9 }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const provider = new OpenAIProvider({
      url: "https://example.test/v1/chat/completions",
      model: "gpt-mini",
      apiKey: "sekret",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    const out = await provider.matchPairs([basePair]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.9);
    expect(capturedUrl).toBe("https://example.test/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sekret");
    const body = JSON.parse((capturedInit?.body as string) ?? "{}");
    expect(body.model).toBe("gpt-mini");
    expect(body.temperature).toBe(0);
    expect(body.messages).toHaveLength(2);
  });

  it("omits the authorization header when no apiKey is given (local backends)", async () => {
    let seenHeaders: Record<string, string> = {};
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ decisions: [] }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };
    const provider = new OpenAIProvider({
      url: "http://localhost:11434/v1/chat/completions",
      model: "llama3",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await provider.matchPairs([basePair]);
    expect(seenHeaders.authorization).toBeUndefined();
  });

  it("returns [] immediately when there are no pairs (never touches fetch)", async () => {
    const fakeFetch = async () => {
      throw new Error("should not be called");
    };
    const provider = new OpenAIProvider({
      url: "https://example.test",
      model: "m",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(await provider.matchPairs([])).toEqual([]);
  });

  it("throws a helpful error on non-2xx replies", async () => {
    const fakeFetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });
    const provider = new OpenAIProvider({
      url: "https://example.test",
      model: "m",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(provider.matchPairs([basePair])).rejects.toThrow(
      /503 Service Unavailable/,
    );
  });

  it("throws when the constructor is missing url or model", () => {
    expect(
      () => new OpenAIProvider({ url: "", model: "m" }),
    ).toThrow(/`url` is required/);
    expect(
      () => new OpenAIProvider({ url: "https://x", model: "" }),
    ).toThrow(/`model` is required/);
  });
});
