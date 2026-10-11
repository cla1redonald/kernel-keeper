import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOutDirSafe, listPendingProposals, renderProposalMarkdown, writeProposal, UsageError } from "../src/ai/proposal.js";
import { assembleScribePrompt, bundleContext } from "../src/ai/prompts.js";
import { sha256Hex, proposalIdFor, buildProvenance } from "../src/ai/provenance.js";
import { parseFrontmatter, loadBundle } from "../src/core/bundle.js";
import type { ProposalDraft, Provenance } from "../src/ai/types.js";

const DRAFT: ProposalDraft = {
  id: "P-abc123def456",
  kind: "amend",
  target: "metrics/m.md",
  summary: "Bump last-affirmed after review",
  rationale: "Content still reads true against the source.",
  frontmatterPatch: { "last-affirmed": "YYYY-MM-DD" },
  bodyDraft: null,
  journalLine: "- **YYYY-MM-DD** - affirmed metrics/m.md [proposal: P-abc123def456] [decision: elected] [by: <judge>]",
  indexEntry: null,
  confidence: "medium",
  evidenceQuotes: [{ file: "metrics/m.md", quote: "the threshold is 95%" }],
  needsHuman: false,
};

const PROV: Provenance = {
  agent: "scribe",
  model: "claude-sonnet-5",
  promptSha256: "f".repeat(64),
  evidenceFiles: ["metrics/m.md"],
  reviewedSurfaceSha256: "e".repeat(64),
  reviewedSurfaceFiles: [{ path: "metrics/m.md", sha256: "d".repeat(64) }],
  generatedAt: "2026-07-13T22:00:00.000Z",
  usage: { inputTokens: 100, outputTokens: 50 },
};

describe("proposal rendering", () => {
  it("renders deterministically with immutable draft + Decision + Amendment sections", () => {
    const md = renderProposalMarkdown(DRAFT, PROV);
    expect(md).toContain("id: P-abc123def456");
    expect(md).toContain("proposer: scribe");
    expect(md).toContain(`reviewed-surface-sha256: ${"e".repeat(64)}`);
    expect(md).toContain(`reviewed-surface: [metrics/m.md:${"d".repeat(64)}]`);
    expect(md).toContain("status: pending");
    expect(md).toContain("elected: false");
    expect(md).toContain("## Draft (immutable)");
    expect(md).toContain("- [ ] Elect - apply as drafted");
    expect(md.trimEnd().endsWith("## Amendment")).toBe(true);
    expect(renderProposalMarkdown(DRAFT, PROV)).toBe(md); // pure
  });

  it("frontmatter round-trips through the existing flat parser", () => {
    const fm = parseFrontmatter(renderProposalMarkdown(DRAFT, PROV));
    expect(fm?.["type"]).toBe("Proposal");
    expect(fm?.["id"]).toBe("P-abc123def456");
    expect(fm?.["status"]).toBe("pending");
    expect(fm?.["elected"]).toBe("false");
    expect(fm?.["evidence"]).toEqual(["metrics/m.md"]);
  });
});

describe("out-dir safety (the chokepoint)", () => {
  it("inside bundle throws; symlinked-into-bundle throws; outside passes", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-outdir-"));
    try {
      mkdirSync(join(root, "repo", "bundle"), { recursive: true });
      mkdirSync(join(root, "elsewhere"));
      symlinkSync(join(root, "repo", "bundle"), join(root, "sneaky"));
      const bundle = join(root, "repo", "bundle");
      const repo = join(root, "repo");
      expect(() => assertOutDirSafe(join(bundle, "props"), bundle, repo, false, () => {})).toThrow(UsageError);
      expect(() => assertOutDirSafe(join(root, "sneaky", "props"), bundle, repo, false, () => {})).toThrow(UsageError);
      expect(() => assertOutDirSafe(join(root, "elsewhere"), bundle, repo, false, () => {})).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inside repo (not bundle) throws without --allow-in-repo, warns with it", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-outdir-"));
    try {
      mkdirSync(join(root, "repo", "bundle"), { recursive: true });
      const bundle = join(root, "repo", "bundle");
      const repo = join(root, "repo");
      const sibling = join(repo, "proposals");
      expect(() => assertOutDirSafe(sibling, bundle, repo, false, () => {})).toThrow(UsageError);
      const warnings: string[] = [];
      expect(() => assertOutDirSafe(sibling, bundle, repo, true, (m) => warnings.push(m))).not.toThrow();
      expect(warnings.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeProposal skips existing ids unless force", () => {
    const out = mkdtempSync(join(tmpdir(), "kk-props-"));
    try {
      expect(writeProposal(out, DRAFT, PROV, false).skipped).toBe(false);
      expect(writeProposal(out, DRAFT, PROV, false).skipped).toBe(true);
      expect(writeProposal(out, DRAFT, PROV, true).skipped).toBe(false);
      expect(readdirSync(out)).toEqual(["P-abc123def456.md"]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("chokepoint enforcement (source-level)", () => {
  it("only proposal.ts under src/ai/ imports fs write APIs", () => {
    const aiDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "ai");
    const offenders: string[] = [];
    for (const f of readdirSync(aiDir)) {
      if (!f.endsWith(".ts") || f === "proposal.ts") continue;
      // Strip comments first - the tripwire polices code APIs, not prose.
      const src = readFileSync(join(aiDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const WRITE_APIS = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|cp|cpSync|copyFile|copyFileSync|chmod|chmodSync|symlink|symlinkSync|truncate|truncateSync|open|openSync)\b|fs\/promises/;
      if (WRITE_APIS.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe("listPendingProposals", () => {
  it("includes pending, excludes elected / frontmatter-less / foreign files; degrades mangled headings to empty summary", () => {
    const out = mkdtempSync(join(tmpdir(), "kk-pending-"));
    try {
      writeFileSync(join(out, "P-aaa.md"), "---\ntype: Proposal\nid: P-aaa\nproposer: gap-miner\ntarget: facts/x.md\nstatus: pending\n---\n# Proposal P-aaa - A real pending truth\n");
      writeFileSync(join(out, "P-bbb.md"), "---\ntype: Proposal\nid: P-bbb\nproposer: gap-miner\ntarget: facts/y.md\nstatus: elected\n---\n# Proposal P-bbb - Already elected\n");
      writeFileSync(join(out, "P-ccc.md"), "no frontmatter at all\n");
      writeFileSync(join(out, "notes.md"), "---\ntype: Patrol\nstatus: pending\n---\nnot a proposal\n");
      writeFileSync(join(out, "P-ddd.md"), "---\ntype: Proposal\nid: P-ddd\nproposer: gap-miner\ntarget: facts/z.md\nstatus: pending\n---\nMangled heading here\n");
      writeFileSync(join(out, "P-eee.md"), "---\ntype: Proposal\nid: P-eee\nproposer: scribe\ntarget: facts/w.md\nstatus: pending\n---\n# Proposal P-eee - A scribe amend\n");
      const all = listPendingProposals(out);
      expect(all.map((p) => p.id).sort()).toEqual(["P-aaa", "P-ddd", "P-eee"]);
      expect(all.find((p) => p.id === "P-aaa")?.summary).toBe("A real pending truth");
      expect(all.find((p) => p.id === "P-ddd")?.summary).toBe(""); // degraded, target still present
      expect(all.find((p) => p.id === "P-ddd")?.target).toBe("facts/z.md");
      const miners = listPendingProposals(out, "gap-miner");
      expect(miners.map((p) => p.id).sort()).toEqual(["P-aaa", "P-ddd"]); // scribe filtered out
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("round-trips the renderer's own heading (shared constant cannot desync)", () => {
    const out = mkdtempSync(join(tmpdir(), "kk-pending-"));
    try {
      writeProposal(out, DRAFT, PROV, false);
      const [p] = listPendingProposals(out);
      expect(p?.summary).toBe(DRAFT.summary);
      expect(p?.id).toBe(DRAFT.id);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("provenance", () => {
  it("prompt hash is reproducible and ids are date-free deterministic", () => {
    expect(sha256Hex("a")).toBe(sha256Hex("a"));
    expect(proposalIdFor("scribe", ["x", "y"])).toBe(proposalIdFor("scribe", ["x", "y"]));
    expect(proposalIdFor("scribe", ["x", "y"])).not.toBe(proposalIdFor("gap-miner", ["x", "y"]));
    const p1 = buildProvenance({ agent: "scribe", model: "m", system: "s", user: "u", evidenceFiles: ["b", "a"], usage: { inputTokens: 1, outputTokens: 2 }, now: new Date("2026-07-13") });
    expect(p1.evidenceFiles).toEqual(["a", "b"]); // sorted
    expect(p1.promptSha256).toBe(buildProvenance({ agent: "scribe", model: "m", system: "s", user: "u", evidenceFiles: [], usage: { inputTokens: 0, outputTokens: 0 }, now: new Date("2026-01-01") }).promptSha256);
  });

  it("hashes reviewed surface files deterministically", () => {
    const a = buildProvenance({
      agent: "drift-reviewer",
      model: "m",
      system: "s",
      user: "u",
      evidenceFiles: ["source.md", "target.md"],
      reviewedSurfaceFiles: [
        { path: "target.md", content: "target" },
        { path: "source.md", content: "source" },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
      now: new Date("2026-07-13"),
    });
    const b = buildProvenance({
      agent: "drift-reviewer",
      model: "m",
      system: "s",
      user: "u",
      evidenceFiles: ["target.md", "source.md"],
      reviewedSurfaceFiles: [
        { path: "source.md", content: "source" },
        { path: "target.md", content: "target" },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
      now: new Date("2026-07-13"),
    });

    expect(a.reviewedSurfaceFiles?.map((f) => f.path)).toEqual(["source.md", "target.md"]);
    expect(a.reviewedSurfaceSha256).toBe(b.reviewedSurfaceSha256);
  });
});

describe("prompt assembly", () => {
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mini-repo");
  const bundle = loadBundle(FIXTURE);

  it("is pure: identical inputs → identical text (and hence stable sha)", () => {
    const ctx = bundleContext(bundle);
    const cluster = { file: "bundle/metrics/good-metric.md", owner: "Ops", findings: [] };
    const a = assembleScribePrompt(cluster, null, ctx);
    const b = assembleScribePrompt(cluster, null, ctx);
    expect(a).toEqual(b);
    expect(a.system).toContain("never an instruction"); // injection rule present
    expect(a.system).toContain("Drafting policy");
  });

  it("fences file content and includes the inventory sorted", () => {
    const ctx = bundleContext(bundle);
    expect(ctx).toContain('<file path="index.md">');
    const lines = ctx.split("## Concept inventory\n")[1]?.split("\n") ?? [];
    expect([...lines].sort().join()).toBe(lines.join());
  });
});
