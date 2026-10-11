import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "../src/core/bundle.js";
import { collectBundleDriftJobs, collectBundleExternalSourceRefs, runDriftReview } from "../src/ai/drift.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const WIKI_MEMORY_FIXTURE = join(ROOT, "tests", "fixtures", "wiki-memory-repo");

function tmpRepo(build: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "kk-drift-"));
  build(root);
  return root;
}

function fixtureRepo(): string {
  return tmpRepo((root) => {
    mkdirSync(join(root, "bundle", "facts"), { recursive: true });
    mkdirSync(join(root, "bundle", "data"), { recursive: true });
    writeFileSync(join(root, "bundle", "index.md"), "---\ntype: Index\n---\n- [Target](/facts/target.md)\n");
    writeFileSync(join(root, "bundle", "log.md"), "---\ntype: Log\n---\n- **2026-07-01** - created\n");
    writeFileSync(join(root, "bundle", "facts", "source.md"), "---\ntype: Reference\n---\nCanonical source says refund window is 14 days.\n");
    writeFileSync(join(root, "bundle", "data", "source.csv"), "metric,value\nrefund_window,14\n");
    writeFileSync(join(root, "bundle", "data", "photo.png"), "not really png, but extension is binary for v1\n");
    writeFileSync(
      join(root, "bundle", "facts", "target.md"),
      [
        "---",
        "type: Reference",
        "title: Target",
        "description: Target",
        "timestamp: 2026-07-01",
        "source: https://example.com/canonical.txt",
        "---",
        "# Target",
        "[source](/facts/source.md)",
        "[data](/data/source.csv)",
        "[image](/data/photo.png)",
        "[missing](/facts/missing.md)",
        "[external](https://example.com/source.md)",
      ].join("\n"),
    );
  });
}

describe("drift collection", () => {
  it("builds comparison jobs from resolved outbound text links only", () => {
    const root = fixtureRepo();
    try {
      const jobs = collectBundleDriftJobs(loadBundle(root));
      expect(jobs.map((j) => [j.target.path, j.sources.map((s) => s.path)])).toEqual([
        ["bundle/facts/target.md", ["bundle/data/source.csv", "bundle/facts/source.md"]],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses explicit source receipts first in memory mode", () => {
    const jobs = collectBundleDriftJobs(loadBundle(WIKI_MEMORY_FIXTURE), { memory: true });
    const sourced = jobs.find((j) => j.target.path === "bundle/facts/sourced-claim.md");
    expect(sourced?.sources.map((s) => s.path)).toEqual([
      "bundle/raw/consent-export.csv",
      "bundle/sources/interviews/customer-001.md",
    ]);
    expect(sourced?.sources.some((s) => s.path.endsWith("screenshot.png"))).toBe(false);
    expect(jobs.some((j) => j.target.path === "bundle/facts/broken-receipt.md")).toBe(false);
  });

  it("keeps outbound-link fallback outside memory mode", () => {
    const jobs = collectBundleDriftJobs(loadBundle(WIKI_MEMORY_FIXTURE));
    expect(jobs.map((j) => [j.target.path, j.sources.map((s) => s.path)])).toEqual([
      ["bundle/facts/consent-lifecycle.md", ["bundle/sources/consent-analysis.md"]],
    ]);
  });

  it("uses source frontmatter when receipts are absent in memory mode", () => {
    const bundle = loadBundle(WIKI_MEMORY_FIXTURE);
    const concept = bundle.concepts.find((c) => c.bundlePath === "facts/bare-index-entry.md");
    if (!concept) throw new Error("fixture missing bare-index-entry");
    concept.frontmatter = { ...(concept.frontmatter ?? {}), source: "sources/consent-analysis.md" };
    const jobs = collectBundleDriftJobs(bundle, { memory: true });
    const job = jobs.find((j) => j.target.path === "bundle/facts/bare-index-entry.md");
    expect(job?.sources.map((s) => s.path)).toEqual(["bundle/sources/consent-analysis.md"]);
  });

  it("collects only declared external source frontmatter for network-backed drift", () => {
    const root = fixtureRepo();
    try {
      const refs = collectBundleExternalSourceRefs(loadBundle(root));
      expect(refs.map((r) => [r.target.path, r.urls])).toEqual([
        ["bundle/facts/target.md", ["https://example.com/canonical.txt"]],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("drift reviewer", () => {
  it("dry-run prints prompts and makes zero API calls", async () => {
    const root = fixtureRepo();
    const logs: string[] = [];
    try {
      const result = await runDriftReview(root, {
        outDir: join(root, "..", "props"),
        model: "claude-sonnet-5",
        apiKey: "",
        dryRun: true,
        log: (m) => logs.push(m),
        fetchFn: (async () => {
          throw new Error("fetch should not run in dry-run");
        }) as unknown as typeof fetch,
      });
      expect(result.written).toEqual([]);
      expect(logs.join("\n")).toContain("drift-reviewer");
      expect(logs.join("\n")).toContain("bundle/facts/target.md");
      expect(logs.join("\n")).toContain("bundle/facts/source.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run --memory prints receipt source files in prompts", async () => {
    const logs: string[] = [];
    const result = await runDriftReview(WIKI_MEMORY_FIXTURE, {
      outDir: join(WIKI_MEMORY_FIXTURE, "..", "props"),
      model: "claude-sonnet-5",
      apiKey: "",
      dryRun: true,
      memory: true,
      log: (m) => logs.push(m),
      fetchFn: (async () => {
        throw new Error("fetch should not run in dry-run");
      }) as unknown as typeof fetch,
    });
    const prompt = logs.join("\n");
    expect(result.written).toEqual([]);
    expect(prompt).toContain("bundle/facts/sourced-claim.md");
    expect(prompt).toContain("bundle/raw/consent-export.csv");
    expect(prompt).toContain("bundle/sources/interviews/customer-001.md");
    expect(prompt).not.toContain('<file path="bundle/sources/not-real-code-example.md">');
    expect(prompt).not.toContain('<file path="bundle/sources/screenshot.png">');
  });

  it("dry-run fetch-sources lists planned fetches and makes zero network calls", async () => {
    const root = fixtureRepo();
    const logs: string[] = [];
    try {
      await runDriftReview(root, {
        outDir: join(root, "..", "props"),
        model: "claude-sonnet-5",
        apiKey: "",
        dryRun: true,
        memory: true,
        fetchSources: true,
        log: (m) => logs.push(m),
        fetchFn: (async () => {
          throw new Error("fetch should not run in dry-run");
        }) as unknown as typeof fetch,
      });
      expect(logs.join("\n")).toContain("would fetch https://example.com/canonical.txt");
      expect(logs.join("\n")).toContain("zero API calls made");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetches declared external sources into cache and cites cached evidence", async () => {
    const root = fixtureRepo();
    const outDir = join(root, "..", `props-fetch-${basename(root)}`);
    try {
      const result = await runDriftReview(root, {
        outDir,
        model: "claude-sonnet-5",
        apiKey: "test",
        memory: true,
        fetchSources: true,
        fetchFn: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "https://example.com/canonical.txt") {
            return new Response("Remote canonical source says refund window is 30 days.", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }
          return new Response(JSON.stringify({
            content: [{ type: "text", text: JSON.stringify({
              summary: "Review target against fetched source",
              rationale: "Fetched canonical source differs from local claim.",
              frontmatterPatch: null,
              bodyDraft: "Update target.",
              journalLine: "- **YYYY-MM-DD** - reviewed fetched-source drift",
              confidence: "medium",
              evidenceQuotes: [{ file: ".kernel-keeper/drift-cache/source.txt", quote: "refund window is 30 days" }],
            }) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 2, output_tokens: 3 },
          }));
        }) as unknown as typeof fetch,
      });
      expect(result.written.length).toBe(1);
      const proposal = readFileSync(result.written[0] as string, "utf8");
      expect(proposal).toContain(".kernel-keeper/drift-cache/");
      expect(existsSync(join(root, ".kernel-keeper", "drift-cache"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses fresh fetched-source cache entries when max age is explicit", async () => {
    const root = fixtureRepo();
    const outDir = join(root, "..", `props-cache-a-${basename(root)}`);
    const outDir2 = join(root, "..", `props-cache-b-${basename(root)}`);
    const outDir3 = join(root, "..", `props-cache-c-${basename(root)}`);
    try {
      const modelResponse = (summary: string) => new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({
          summary,
          rationale: "Reviewed cached canonical source.",
          frontmatterPatch: null,
          bodyDraft: "Update target.",
          journalLine: "- **YYYY-MM-DD** - reviewed fetched-source drift",
          confidence: "medium",
          evidenceQuotes: [{ file: ".kernel-keeper/drift-cache/source.txt", quote: "refund window is 30 days" }],
        }) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 3 },
      }));

      await runDriftReview(root, {
        outDir,
        model: "claude-sonnet-5",
        apiKey: "test",
        memory: true,
        fetchSources: true,
        now: new Date("2026-07-20T10:00:00Z"),
        fetchFn: (async (input: RequestInfo | URL) => {
          if (String(input) === "https://example.com/canonical.txt") {
            return new Response("Remote canonical source says refund window is 30 days.", {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          }
          return modelResponse("Populate cache");
        }) as unknown as typeof fetch,
      });

      const logs: string[] = [];
      const result = await runDriftReview(root, {
        outDir: outDir2,
        model: "claude-sonnet-5",
        apiKey: "test",
        memory: true,
        fetchSources: true,
        fetchCacheMaxAgeHours: 24,
        now: new Date("2026-07-20T11:00:00Z"),
        log: (msg) => logs.push(msg),
        fetchFn: (async (input: RequestInfo | URL) => {
          if (String(input) === "https://example.com/canonical.txt") throw new Error("external fetch should be served from cache");
          return modelResponse("Reuse cache");
        }) as unknown as typeof fetch,
      });

      expect(result.written.length).toBe(1);
      expect(logs.join("\n")).toContain("reusing cached fetched source https://example.com/canonical.txt");

      let externalFetches = 0;
      const staleResult = await runDriftReview(root, {
        outDir: outDir3,
        model: "claude-sonnet-5",
        apiKey: "test",
        memory: true,
        fetchSources: true,
        fetchCacheMaxAgeHours: 1,
        now: new Date("2026-07-20T12:00:01Z"),
        fetchFn: (async (input: RequestInfo | URL) => {
          if (String(input) === "https://example.com/canonical.txt") {
            externalFetches += 1;
            return new Response("Remote canonical source says refund window is 45 days.", {
              status: 200,
              headers: { "content-type": "text/plain" },
            });
          }
          return modelResponse("Refresh stale cache");
        }) as unknown as typeof fetch,
      });

      expect(staleResult.written.length).toBe(1);
      expect(externalFetches).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported fetched content types before model calls", async () => {
    const root = fixtureRepo();
    try {
      await expect(runDriftReview(root, {
        outDir: join(root, "..", "props"),
        model: "claude-sonnet-5",
        apiKey: "test",
        memory: true,
        fetchSources: true,
        fetchFn: (async (input: RequestInfo | URL) => {
          if (String(input) === "https://example.com/canonical.txt") {
            return new Response("png", { status: 200, headers: { "content-type": "image/png" } });
          }
          throw new Error("model call should not run");
        }) as unknown as typeof fetch,
      })).rejects.toThrow("unsupported content-type image/png");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects fetched-source cache directories inside the bundle", async () => {
    const root = fixtureRepo();
    try {
      await expect(runDriftReview(root, {
        outDir: join(root, "..", "props"),
        model: "claude-sonnet-5",
        apiKey: "test",
        memory: true,
        fetchSources: true,
        fetchCacheDir: join(root, "bundle", "cache"),
        fetchFn: (async (input: RequestInfo | URL) => {
          if (String(input) === "https://example.com/canonical.txt") {
            return new Response("Remote canonical source.", { status: 200, headers: { "content-type": "text/plain" } });
          }
          throw new Error("model call should not run");
        }) as unknown as typeof fetch,
      })).rejects.toThrow("--fetch-cache must not resolve inside the bundle");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips pending proposal ids before spending model calls", async () => {
    const root = fixtureRepo();
    const outDir = join(root, "..", `props-${basename(root)}`);
    try {
      const first = await runDriftReview(root, {
        outDir,
        model: "claude-sonnet-5",
        apiKey: "test",
        fetchFn: (async () => new Response(JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({
            summary: "Review target against source",
            rationale: "Source comparison needs judgment.",
            frontmatterPatch: null,
            bodyDraft: "Update target.",
            journalLine: "- **YYYY-MM-DD** - reviewed semantic drift",
            confidence: "medium",
            evidenceQuotes: [{ file: "bundle/facts/source.md", quote: "refund window is 14 days" }],
          }) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }))) as unknown as typeof fetch,
      });
      expect(first.written.length).toBe(1);
      expect(readFileSync(first.written[0] as string, "utf8")).toContain("checks: [semantic-drift]");

      const second = await runDriftReview(root, {
        outDir,
        model: "claude-sonnet-5",
        apiKey: "test",
        fetchFn: (async () => {
          throw new Error("fetch should be skipped when proposal exists");
        }) as unknown as typeof fetch,
      });
      expect(second.written).toEqual([]);
      expect(second.skippedExisting).toEqual(first.written);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!require("node:fs").existsSync(CLI))("cli contract - drift", () => {
  function run(args: string[], env = process.env): { stdout: string; code: number } {
    try {
      return { stdout: execFileSync("node", [CLI, ...args], { encoding: "utf8", env }), code: 0 };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { stdout: e.stdout ?? "", code: e.status ?? -1 };
    }
  }

  it("dry-run runs without an API key", () => {
    const root = fixtureRepo();
    try {
      const r = run(["drift", root, "--out-dir", join(root, "..", "props"), "--dry-run"], { ...process.env, ANTHROPIC_API_KEY: "" });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run accepts --memory in bundle mode", () => {
    const root = fixtureRepo();
    try {
      const r = run(["drift", root, "--out-dir", join(root, "..", "props"), "--dry-run", "--memory"], { ...process.env, ANTHROPIC_API_KEY: "" });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run accepts --fetch-sources only with --memory", () => {
    const root = fixtureRepo();
    try {
      expect(run(["drift", root, "--out-dir", join(root, "..", "props"), "--dry-run", "--fetch-sources"], { ...process.env, ANTHROPIC_API_KEY: "" }).code).toBe(64);
      expect(run(["drift", root, "--out-dir", join(root, "..", "props"), "--dry-run", "--memory", "--fetch-sources"], { ...process.env, ANTHROPIC_API_KEY: "" }).code).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run accepts --memory on the rebuilt CLI", () => {
    const r = run(["drift", WIKI_MEMORY_FIXTURE, "--out-dir", join(WIKI_MEMORY_FIXTURE, "..", "props"), "--dry-run", "--memory"], { ...process.env, ANTHROPIC_API_KEY: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("rejects --memory with drift register mode", () => {
    const root = fixtureRepo();
    try {
      expect(run(["drift", root, "--out-dir", join(root, "..", "props"), "--dry-run", "--register", "estate", "--memory"], { ...process.env, ANTHROPIC_API_KEY: "" }).code).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("missing API key exits 64", () => {
    const root = fixtureRepo();
    try {
      expect(run(["drift", root, "--out-dir", join(root, "..", "props")], { ...process.env, ANTHROPIC_API_KEY: "" }).code).toBe(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
