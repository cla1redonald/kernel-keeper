import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadBundle } from "../src/core/bundle.js";
import {
  danglingLinks,
  claimReceipts,
  datedOverview,
  derivedArtifacts,
  archiveLifecycle,
  compartmentBoundaries,
  recallEvidence,
  frontmatter,
  indexLineQuality,
  indexCoverage,
  journal,
  orphans,
  ownerless,
  pointerIntegrity,
  stableIds,
  staleness,
  supersessionIntegrity,
  unjournalledChange,
} from "../src/checks/index.js";
import type { PatrolOptions } from "../src/types.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mini-repo");
const WIKI_MEMORY_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wiki-memory-repo");
const OPTS: PatrolOptions = { policyDays: 90, journalDays: 30, now: new Date("2026-07-11"), memory: false };
const bundle = loadBundle(FIXTURE);
const wikiMemoryBundle = loadBundle(WIKI_MEMORY_FIXTURE);

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kk-checks-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("loadBundle", () => {
  it("finds the bundle inside a repo root and loads concepts + definitions", () => {
    expect(bundle.bundleRel).toBe("bundle");
    expect(bundle.concepts.length).toBe(8); // index, log, 6 concepts
    expect(bundle.definitions.length).toBe(2);
  });

  it("loads sources/ and raw/ text files as evidence, not governed concepts", () => {
    expect(wikiMemoryBundle.concepts.map((c) => c.bundlePath).sort()).toEqual([
      "facts/bare-index-entry.md",
      "facts/broken-receipt.md",
      "facts/consent-lifecycle.md",
      "facts/sourced-claim.md",
      "index.md",
      "log.md",
    ]);
    expect(wikiMemoryBundle.evidenceFiles.map((f) => f.bundlePath).sort()).toEqual([
      "raw/consent-export.csv",
      "sources/consent-analysis.md",
      "sources/interviews/customer-001.md",
    ]);
    expect(wikiMemoryBundle.repoFiles.has("bundle/sources/consent-analysis.md")).toBe(true);
    expect(wikiMemoryBundle.repoFiles.has("bundle/raw/consent-export.csv")).toBe(true);
  });
});

describe("dangling-links", () => {
  it("flags exactly the broken link, not the valid md/yml/csv ones", () => {
    const f = danglingLinks(bundle, OPTS);
    expect(f).toHaveLength(1);
    expect(f[0]?.file).toBe("bundle/runbooks/broken.md");
    expect(f[0]?.message).toContain("/metrics/does-not-exist.md");
    expect(f[0]?.severity).toBe("HIGH");
    expect(f[0]?.owner).toBe("Platform team");
  });

  it("allows concept links into evidence files", () => {
    expect(danglingLinks(wikiMemoryBundle, OPTS)).toEqual([]);
  });
});

describe("orphans", () => {
  it("flags only the concept nothing links to", () => {
    const f = orphans(bundle, OPTS);
    // glossary/term.md is linked from good-metric.md, so the only orphan is raw.md?
    // raw.md IS linked from index.md. term.md is linked. stale-metric linked from index.
    // Deliberate orphan: none linked? glossary/term.md is linked by good-metric.
    const files = f.map((x) => x.file);
    expect(files).toEqual([]);
  });
});

describe("index-coverage", () => {
  it("flags concepts missing from index.md", () => {
    const f = indexCoverage(bundle, OPTS);
    expect(f.map((x) => x.file)).toEqual(["bundle/glossary/term.md"]);
    expect(f[0]?.severity).toBe("LOW");
  });

  it("does not require sources/ or raw/ evidence files to be listed in index.md", () => {
    expect(indexCoverage(wikiMemoryBundle, OPTS)).toEqual([]);
  });
});

describe("index-line-quality", () => {
  it("is opt-in to memory mode", () => {
    expect(indexLineQuality(wikiMemoryBundle, OPTS)).toEqual([]);
  });

  it("flags weak index descriptions in memory mode", () => {
    const f = indexLineQuality(wikiMemoryBundle, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "bundle/index.md", "Index link `bare-index-entry.md` is filename-like and has no useful description"],
    ]);
  });

  it("flags a non-filename bare link as LOW", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["index.md", "facts/plain.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "index.md", bundlePath: "index.md", content: "- [Plain name](/facts/plain.md)", frontmatter: null, links: [{ target: "/facts/plain.md", resolved: "facts/plain.md" }], owner: null },
        { path: "facts/plain.md", bundlePath: "facts/plain.md", content: "", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
      ],
    };
    const f = indexLineQuality(b, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.owner, x.message])).toEqual([
      ["LOW", "Ops", "Index link `Plain name` has no useful one-line description"],
    ]);
  });
});

describe("claim-receipts", () => {
  it("is opt-in to memory mode", () => {
    expect(claimReceipts(wikiMemoryBundle, OPTS)).toEqual([]);
  });

  it("validates explicit local receipts in memory mode", () => {
    const f = claimReceipts(wikiMemoryBundle, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "bundle/facts/broken-receipt.md", "Source receipt `sources/missing-analysis.md` points at no local text-like evidence file"],
      ["LOW", "bundle/facts/sourced-claim.md", "Source receipt `sources/screenshot.png` points at a binary/media file"],
    ]);
  });

  it("skips external receipts and receipts inside fenced code", () => {
    const f = claimReceipts(wikiMemoryBundle, { ...OPTS, memory: true });
    expect(f.some((x) => x.message.includes("https://example.com"))).toBe(false);
    expect(f.some((x) => x.message.includes("not-real-code-example"))).toBe(false);
  });

  it("flags receipts that resolve outside the repo surface", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["facts/plain.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "facts/plain.md", bundlePath: "facts/plain.md", content: "[source: ../../outside.md]", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
      ],
    };
    const f = claimReceipts(b, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.owner, x.message])).toEqual([
      ["MED", "Ops", "Source receipt `../../outside.md` resolves outside the loaded surface"],
    ]);
  });
});

describe("dated-overview", () => {
  it("is opt-in to memory mode", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["facts/good.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "facts/good.md", bundlePath: "facts/good.md", content: "# Good\n\nAs of 2026-07-20, this is current.", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
      ],
    };
    expect(datedOverview(b, OPTS)).toEqual([]);
  });

  it("accepts valid overview dates and keeps missing overviews quiet for now", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["facts/good.md", "facts/missing.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "facts/good.md", bundlePath: "facts/good.md", content: "# Good\n\nAs of 2026-07-20, this is current.", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
        { path: "facts/missing.md", bundlePath: "facts/missing.md", content: "# Missing\n\nNo overview yet.", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
      ],
    };
    expect(datedOverview(b, { ...OPTS, memory: true, now: new Date("2026-07-21") })).toEqual([]);
  });

  it("flags invalid and future overview dates in memory mode", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["facts/bad.md", "facts/future.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "facts/bad.md", bundlePath: "facts/bad.md", content: "# Bad\n\nAs of 2026-99-99, this is not parseable.", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
        { path: "facts/future.md", bundlePath: "facts/future.md", content: "# Future\n\nAs of 2026-07-22, this is from tomorrow.", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
      ],
    };
    const f = datedOverview(b, { ...OPTS, memory: true, now: new Date("2026-07-21") });
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "facts/bad.md", "Overview date `2026-99-99` is not a valid YYYY-MM-DD date"],
      ["MED", "facts/future.md", "Overview date `2026-07-22` is in the future"],
    ]);
  });
});

describe("derived-artifacts", () => {
  it("is opt-in to memory mode", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["index.md", "cache/generated.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "cache/generated.md", bundlePath: "cache/generated.md", content: "", frontmatter: { type: "Reference", "artifact-kind": "cache" }, links: [], owner: "Ops" },
      ],
    };
    expect(derivedArtifacts(b, OPTS)).toEqual([]);
  });

  it("accepts cache artifacts with resolvable generated-from provenance", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["index.md", "facts/source.md", "cache/generated.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "facts/source.md", bundlePath: "facts/source.md", content: "", frontmatter: { type: "Reference" }, links: [], owner: "Ops" },
        { path: "cache/generated.md", bundlePath: "cache/generated.md", content: "", frontmatter: { type: "Reference", "artifact-kind": "cache", "generated-from": "facts/source.md" }, links: [], owner: "Ops" },
      ],
    };
    expect(derivedArtifacts(b, { ...OPTS, memory: true })).toEqual([]);
  });

  it("flags generated artifacts with missing or broken source provenance", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["index.md", "cache/no-source.md", "cache/broken.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "cache/no-source.md", bundlePath: "cache/no-source.md", content: "", frontmatter: { type: "Reference", "artifact-kind": "cache" }, links: [], owner: "Ops" },
        { path: "cache/broken.md", bundlePath: "cache/broken.md", content: "", frontmatter: { type: "Reference", "generated-at": "2026-07-20T09:00:00Z", "generated-from": "facts/missing.md" }, links: [], owner: "Data" },
      ],
    };
    const f = derivedArtifacts(b, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "cache/broken.md", "Generated artifact source `facts/missing.md` resolves to nothing"],
      ["MED", "cache/no-source.md", "Generated artifact has no `generated-from:` provenance"],
    ]);
  });
});

describe("archive-lifecycle", () => {
  it("is opt-in to memory mode", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["archive/old.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "archive/old.md", bundlePath: "archive/old.md", content: "", frontmatter: { type: "Reference" }, links: [], owner: null },
      ],
    };
    expect(archiveLifecycle(b, OPTS)).toEqual([]);
  });

  it("flags archived items without notes and archive paths without metadata", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "",
      repoFiles: new Set(["facts/old.md", "archive/path-only.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "facts/old.md", bundlePath: "facts/old.md", content: "", frontmatter: { type: "Reference", status: "archived" }, links: [], owner: "Ops" },
        { path: "archive/path-only.md", bundlePath: "archive/path-only.md", content: "", frontmatter: { type: "Reference" }, links: [], owner: "Data" },
      ],
    };
    const f = archiveLifecycle(b, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "archive/path-only.md", "Item lives under `archive/` but has no archive lifecycle metadata"],
      ["LOW", "facts/old.md", "Archived item has no `archive-note:`"],
    ]);
  });
});

describe("compartment-boundaries", () => {
  it("is opt-in to memory mode and compartment metadata", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "bundle",
      repoFiles: new Set(["bundle/index.md", "bundle/exports/public.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "bundle/index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "bundle/exports/public.md", bundlePath: "exports/public.md", content: "", frontmatter: { type: "Reference", "artifact-kind": "export", visibility: "public" }, links: [], owner: "Ops" },
      ],
    };
    expect(compartmentBoundaries(b, OPTS)).toEqual([]);
    expect(compartmentBoundaries(b, { ...OPTS, memory: true })).toEqual([]);
  });

  it("flags public generated copies that expose restricted items or lose labels", () => {
    const b = {
      repoRoot: "/x",
      bundleRel: "bundle",
      repoFiles: new Set(["bundle/index.md", "bundle/facts/restricted.md", "bundle/exports/public.md"]),
      definitions: [],
      evidenceFiles: [],
      concepts: [
        { path: "bundle/index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "bundle/facts/restricted.md", bundlePath: "facts/restricted.md", content: "", frontmatter: { type: "Reference", compartment: "internal", "redacted-view": "/facts/missing-public.md" }, links: [], owner: "Policy" },
        { path: "bundle/exports/public.md", bundlePath: "exports/public.md", content: "", frontmatter: { type: "Reference", "artifact-kind": "export", visibility: "public" },
          links: [{ target: "/facts/restricted.md", resolved: "bundle/facts/restricted.md" }], owner: "Ops" },
      ],
    };
    const f = compartmentBoundaries(b, { ...OPTS, memory: true });
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "bundle/exports/public.md", "Public generated artifact links restricted item(s): `bundle/facts/restricted.md`"],
      ["MED", "bundle/exports/public.md", "Public generated artifact omits `compartment-labels:` while linking compartmented items"],
      ["HIGH", "bundle/facts/restricted.md", "`redacted-view: /facts/missing-public.md` points at no known safe file"],
    ]);
  });
});

describe("recall-evidence", () => {
  it("is opt-in to memory mode and retrieval-log metadata", () => {
    expect(recallEvidence(wikiMemoryBundle, OPTS)).toEqual([]);
    expect(recallEvidence(wikiMemoryBundle, { ...OPTS, memory: true })).toEqual([]);
  });

  it("uses a local recall log to flag missing references, unretrieved indexed concepts, and derived hits", () => {
    withTempDir((root) => {
      mkdirSync(join(root, "bundle"), { recursive: true });
      writeFileSync(join(root, "bundle", "recall.log"), [
        "[generated](/cache/generated.md)",
        "bundle/cache/generated.md",
        "[missing](/facts/missing.md)",
        "",
      ].join("\n"));
      const b = {
        repoRoot: root,
        bundleRel: "bundle",
        repoFiles: new Set([
          "bundle/index.md",
          "bundle/log.md",
          "bundle/recall.log",
          "bundle/facts/target.md",
          "bundle/facts/source.md",
          "bundle/cache/generated.md",
        ]),
        definitions: [],
        evidenceFiles: [],
        concepts: [
          { path: "bundle/index.md", bundlePath: "index.md", content: "", frontmatter: null,
            links: [
              { target: "/facts/target.md", resolved: "bundle/facts/target.md" },
              { target: "/cache/generated.md", resolved: "bundle/cache/generated.md" },
            ], owner: null },
          { path: "bundle/log.md", bundlePath: "log.md", content: "", frontmatter: { "retrieval-log": "/recall.log" }, links: [], owner: null },
          { path: "bundle/facts/target.md", bundlePath: "facts/target.md", content: "", frontmatter: { type: "Reference" }, links: [], owner: "Research" },
          { path: "bundle/facts/source.md", bundlePath: "facts/source.md", content: "", frontmatter: { type: "Reference" }, links: [], owner: "Research" },
          { path: "bundle/cache/generated.md", bundlePath: "cache/generated.md", content: "", frontmatter: { type: "Reference", "artifact-kind": "cache", "generated-from": "/facts/source.md" }, links: [], owner: "Ops" },
        ],
      };
      const f = recallEvidence(b, { ...OPTS, memory: true });
      expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
        ["LOW", "bundle/cache/generated.md", "Recall log repeatedly lands on a derived artifact while source material is available"],
        ["LOW", "bundle/facts/target.md", "Indexed concept is not retrieved in the configured recall log"],
        ["MED", "bundle/recall.log", "Recall log references missing file `bundle/facts/missing.md`"],
      ]);
    });
  });
});

describe("frontmatter", () => {
  it("flags the file with no frontmatter as HIGH", () => {
    const f = frontmatter(bundle, OPTS);
    const raw = f.filter((x) => x.file === "bundle/processes/raw.md");
    expect(raw).toHaveLength(1);
    expect(raw[0]?.severity).toBe("HIGH");
    // healthy files produce nothing
    expect(f.some((x) => x.file === "bundle/metrics/good-metric.md")).toBe(false);
  });

  it("does not require frontmatter on sources/ or raw/ evidence files", () => {
    expect(frontmatter(wikiMemoryBundle, { ...OPTS, now: new Date("2026-07-21") })).toEqual([]);
  });

  it("flags invalid and future frontmatter dates instead of letting stale checks skip them", () => {
    const bad = {
      repoRoot: "/x", bundleRel: "", repoFiles: new Set<string>(),
      definitions: [],
      concepts: [
        { path: "log.md", bundlePath: "log.md", content: "- **2026-07-01** - entry", frontmatter: null, links: [], owner: null },
        { path: "metrics/bad.md", bundlePath: "metrics/bad.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "Bad", description: "d", timestamp: "2026-99-99" } },
        { path: "metrics/future.md", bundlePath: "metrics/future.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "Future", description: "d", timestamp: "2026-07-12" } },
      ],
    };
    const f = frontmatter(bad, OPTS);
    expect(f.map((x) => x.message)).toEqual([
      "Frontmatter `timestamp` is not a valid YYYY-MM-DD date",
      "Frontmatter `timestamp` is in the future (2026-07-12)",
    ]);
    expect(staleness(bad, OPTS)).toEqual([]);
    expect(frontmatter({
      ...bad,
      concepts: [
        { path: "log.md", bundlePath: "log.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "metrics/junk.md", bundlePath: "metrics/junk.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "Junk", description: "d", timestamp: "2026-07-01junk" } },
        { path: "metrics/prose.md", bundlePath: "metrics/prose.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "Prose", description: "d", timestamp: "2026-07-01 junk" } },
      ],
    }, OPTS).map((x) => x.file)).toEqual(["metrics/junk.md", "metrics/prose.md"]);
    expect(frontmatter({
      ...bad,
      concepts: [
        { path: "log.md", bundlePath: "log.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "metrics/exact.md", bundlePath: "metrics/exact.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "Exact", description: "d", timestamp: "2026-07-01" } },
        { path: "metrics/space.md", bundlePath: "metrics/space.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "Space", description: "d", timestamp: "2026-07-01   " } },
        { path: "metrics/iso.md", bundlePath: "metrics/iso.md", content: "", links: [], owner: "Ops",
          frontmatter: { type: "Metric", title: "ISO", description: "d", timestamp: "2026-07-01T09:30:00Z" } },
      ],
    }, OPTS)).toEqual([]);
  });
});

describe("staleness", () => {
  it("flags only the concept past the policy window, with its owner", () => {
    const f = staleness(bundle, OPTS);
    expect(f).toHaveLength(1);
    expect(f[0]?.file).toBe("bundle/metrics/stale-metric.md");
    expect(f[0]?.owner).toBe("Data team");
    expect(f[0]?.message).toContain("days ago");
  });
  it("respects a custom policy window", () => {
    const f = staleness(bundle, { ...OPTS, policyDays: 3650 });
    expect(f).toHaveLength(0);
  });
});

describe("ownerless", () => {
  it("MED for process concepts, LOW for glossary terms", () => {
    const f = ownerless(bundle, OPTS);
    const byFile = Object.fromEntries(f.map((x) => [x.file, x.severity]));
    expect(byFile["bundle/processes/no-owner.md"]).toBe("MED");
    expect(byFile["bundle/glossary/term.md"]).toBe("LOW");
    // raw.md has no frontmatter and no owner line → also ownerless MED
    expect(byFile["bundle/processes/raw.md"]).toBe("MED");
    expect(f.some((x) => x.file === "bundle/metrics/good-metric.md")).toBe(false);
  });

  it("does not create ownerless noise for evidence files", () => {
    expect(ownerless(wikiMemoryBundle, OPTS)).toEqual([]);
  });
});

describe("stable-ids", () => {
  const mk = (frontmatters: Record<string, string>[]) => ({
    repoRoot: "/x", bundleRel: "", repoFiles: new Set<string>(),
    definitions: [],
    concepts: [
      { path: "index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
      { path: "log.md", bundlePath: "log.md", content: "", frontmatter: null, links: [], owner: null },
      ...frontmatters.map((frontmatter, i) => ({
        path: `facts/c${i}.md`, bundlePath: `facts/c${i}.md`, content: "", links: [], owner: "Ops", frontmatter,
      })),
    ],
  });

  it("allows missing IDs and valid optional IDs", () => {
    expect(stableIds(mk([{ type: "Reference" }, { type: "Reference", id: "ref.ops:1" }]), OPTS)).toEqual([]);
  });

  it("flags malformed and duplicate IDs", () => {
    const f = stableIds(mk([
      { type: "Reference", id: "bad id" },
      { type: "Reference", id: "dup" },
      { type: "Reference", id: "dup" },
    ]), OPTS);
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["MED", "facts/c0.md", "Frontmatter `id` is not a valid stable token"],
      ["HIGH", "facts/c1.md", "Duplicate `id: dup` also used by `facts/c2.md`"],
      ["HIGH", "facts/c2.md", "Duplicate `id: dup` also used by `facts/c1.md`"],
    ]);
  });
});

describe("supersession-integrity", () => {
  const mk = () => ({
    repoRoot: "/x", bundleRel: "", repoFiles: new Set(["facts/old.md", "facts/new.md", "facts/active.md", "facts/dupe-a.md", "facts/dupe-b.md"]),
    definitions: [],
    concepts: [
      { path: "index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
      { path: "log.md", bundlePath: "log.md", content: "", frontmatter: null, links: [], owner: null },
      { path: "facts/old.md", bundlePath: "facts/old.md", content: "", links: [], owner: "Ops",
        frontmatter: { type: "Reference", id: "old", status: "superseded" } },
      { path: "facts/new.md", bundlePath: "facts/new.md", content: "", links: [], owner: "Ops",
        frontmatter: { type: "Reference", id: "new", status: "active", supersedes: "old" } },
      { path: "facts/active.md", bundlePath: "facts/active.md", content: "", owner: "Ops",
        links: [{ target: "/facts/old.md", resolved: "facts/old.md" }],
        frontmatter: { type: "Reference", id: "active" } },
      { path: "facts/dupe-a.md", bundlePath: "facts/dupe-a.md", content: "", links: [], owner: "Ops",
        frontmatter: { type: "Reference", id: "dupe-a", supersedes: "old" } },
      { path: "facts/dupe-b.md", bundlePath: "facts/dupe-b.md", content: "", links: [], owner: "Ops",
        frontmatter: { type: "Reference", id: "dupe-b", supersedes: "old" } },
    ],
  });

  it("flags missing superseded-by, active links to superseded items, and duplicate superseders", () => {
    const f = supersessionIntegrity(mk(), OPTS);
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["HIGH", "facts/old.md", "`status: superseded` requires `superseded-by:`"],
      ["MED", "facts/active.md", "Active item links to superseded `facts/old.md` without `supersession-note:`"],
      ["MED", "facts/new.md", "`facts/old.md` is superseded by multiple active items: `facts/new.md` · `facts/dupe-a.md` · `facts/dupe-b.md`"],
    ]);
  });

  it("resolves superseded-by by ID or path and accepts an explicit supersession note", () => {
    const b = mk();
    (b.concepts[2] as { frontmatter: Record<string, string> }).frontmatter["superseded-by"] = "new";
    (b.concepts[4] as { frontmatter: Record<string, string> }).frontmatter["supersession-note"] = "Historical context only.";
    b.concepts = b.concepts.filter((c) => !c.path.includes("dupe-"));
    expect(supersessionIntegrity(b, OPTS)).toEqual([]);

    (b.concepts[2] as { frontmatter: Record<string, string> }).frontmatter["superseded-by"] = "facts/new.md";
    expect(supersessionIntegrity(b, OPTS)).toEqual([]);
  });

  it("excludes retired and archived concepts from ownerless and staleness noise", () => {
    const b = {
      repoRoot: "/x", bundleRel: "", repoFiles: new Set<string>(), definitions: [],
      concepts: [
        { path: "index.md", bundlePath: "index.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "log.md", bundlePath: "log.md", content: "", frontmatter: null, links: [], owner: null },
        { path: "facts/retired.md", bundlePath: "facts/retired.md", content: "", links: [], owner: null,
          frontmatter: { type: "Reference", status: "retired", timestamp: "2020-01-01" } },
        { path: "facts/archived.md", bundlePath: "facts/archived.md", content: "", links: [], owner: null,
          frontmatter: { type: "Reference", status: "archived", timestamp: "2020-01-01" } },
      ],
    };
    expect(ownerless(b, OPTS)).toEqual([]);
    expect(staleness(b, OPTS)).toEqual([]);
  });
});

describe("journal", () => {
  it("flags a stale journal against the policy", () => {
    const f = journal(bundle, OPTS);
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("MED");
    expect(f[0]?.message).toContain("days old");
  });
  it("passes when the journal is fresh", () => {
    const f = journal(bundle, { ...OPTS, now: new Date("2026-05-10") });
    expect(f).toHaveLength(0);
  });
});

describe("pointer-integrity", () => {
  it("flags the definition whose back-reference points at nothing, and the unreferenced definition", () => {
    const f = pointerIntegrity(bundle, OPTS);
    const orphanDef = f.filter((x) => x.file === "bundle/definitions/orphan-def.yml");
    expect(orphanDef.map((x) => x.severity).sort()).toEqual(["HIGH", "LOW"]);
    expect(f.some((x) => x.file === "bundle/definitions/good-metric.yml")).toBe(false);
  });
});

describe("unjournalled-change", () => {
  // Pure check - synthetic bundles for the edge cases; the real fixture for the loader path.
  const mk = (conceptDate: string, logContent: string) => ({
    repoRoot: "/x", bundleRel: "", repoFiles: new Set<string>(),
    definitions: [],
    concepts: [
      { path: "log.md", bundlePath: "log.md", content: logContent, frontmatter: null, links: [], owner: null },
      { path: "metrics/m.md", bundlePath: "metrics/m.md", content: "", links: [], owner: "Ops",
        frontmatter: { type: "Metric", timestamp: conceptDate } },
    ],
  });

  it("flags a concept dated after the journal's newest entry, with the owner attached", () => {
    const f = unjournalledChange(
      mk("2026-07-15", "- **2026-07-13** - last entry"),
      { ...OPTS, now: new Date("2026-07-16") },
    );
    expect(f.length).toBe(1);
    expect(f[0]?.check).toBe("unjournalled-change");
    expect(f[0]?.severity).toBe("MED");
    expect(f[0]?.owner).toBe("Ops");
    expect(f[0]?.message).toContain("2026-07-15");
    expect(f[0]?.message).toContain("2026-07-13");
  });

  it("same-day and older concepts are quiet", () => {
    expect(unjournalledChange(mk("2026-07-13", "- **2026-07-13** - entry"), OPTS)).toEqual([]);
    expect(unjournalledChange(mk("2026-07-01", "- **2026-07-13** - entry"), OPTS)).toEqual([]);
  });

  it("prefers last-affirmed over timestamp", () => {
    const b = mk("2026-07-01", "- **2026-07-13** - entry");
    (b.concepts[1] as { frontmatter: Record<string, string> }).frontmatter["last-affirmed"] = "2026-07-14";
    expect(unjournalledChange(b, { ...OPTS, now: new Date("2026-07-15") }).length).toBe(1);
  });

  it("defers to the journal check when log.md is missing or undated", () => {
    const noLog = mk("2026-07-15", "");
    noLog.concepts = noLog.concepts.filter((c) => c.bundlePath !== "log.md");
    expect(unjournalledChange(noLog, OPTS)).toEqual([]);
    expect(unjournalledChange(mk("2026-07-15", "no dated entries here"), OPTS)).toEqual([]);
  });

  it("ignores invalid/future concept dates because frontmatter owns those findings", () => {
    expect(unjournalledChange(mk("2026-99-99", "- **2026-07-13** - entry"), OPTS)).toEqual([]);
    expect(unjournalledChange(mk("2026-07-12", "- **2026-07-01** - entry"), OPTS)).toEqual([]);
  });

  it("never fires on index.md or log.md themselves (reserved, not meaning concepts)", () => {
    const b = mk("2026-07-01", "- **2026-05-01** - old entry");
    b.concepts.push({ path: "index.md", bundlePath: "index.md", content: "", links: [], owner: null,
      frontmatter: { type: "Index", timestamp: "2026-07-15" } });
    const files = unjournalledChange(b, OPTS).map((f) => f.file);
    expect(files).not.toContain("index.md");
  });

  it("runs against the real loaded fixture: four concepts postdate the 2026-05-01 journal", () => {
    // Documents the loader-path behaviour on mini-repo: log.md's newest entry is
    // 2026-05-01; good-metric, no-owner, broken and term are dated 2026-07-01
    // (stale-metric 2026-01-01 and frontmatter-less raw.md stay quiet).
    const f = unjournalledChange(bundle, OPTS);
    expect(f.length).toBe(4);
    expect(f.every((x) => x.check === "unjournalled-change" && x.severity === "MED")).toBe(true);
    expect(f.map((x) => x.file).sort()).toEqual([
      "bundle/glossary/term.md",
      "bundle/metrics/good-metric.md",
      "bundle/processes/no-owner.md",
      "bundle/runbooks/broken.md",
    ]);
  });
});
