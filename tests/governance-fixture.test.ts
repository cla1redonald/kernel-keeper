import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { patrol } from "../src/index.js";
import { loadBundle } from "../src/core/bundle.js";
import { collectBundleDriftJobs } from "../src/ai/drift.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "governance-repo");
const NOW = new Date("2026-07-11");

describe("governance fixture", () => {
  it("pins the v0.5 governance finding contract", () => {
    const result = patrol(FIXTURE, { now: NOW });
    expect(result.stats.findingsBySeverity).toEqual({ HIGH: 4, MED: 2, LOW: 1 });
    expect(result.findings.map((f) => [f.check, f.severity, f.file, f.message])).toEqual([
      ["dangling-links", "HIGH", "bundle/facts/drift-target.md", "Link `/facts/missing.md` resolves to nothing"],
      ["stable-ids", "HIGH", "bundle/facts/dup-a.md", "Duplicate `id: duplicate-id` also used by `bundle/facts/dup-b.md`"],
      ["stable-ids", "HIGH", "bundle/facts/dup-b.md", "Duplicate `id: duplicate-id` also used by `bundle/facts/dup-a.md`"],
      ["supersession-integrity", "HIGH", "bundle/facts/superseded-missing.md", "`status: superseded` requires `superseded-by:`"],
      ["stable-ids", "MED", "bundle/facts/malformed-id.md", "Frontmatter `id` is not a valid stable token"],
      ["supersession-integrity", "MED", "bundle/facts/active-link.md", "Active item links to superseded `bundle/facts/superseded-missing.md` without `supersession-note:`"],
      ["index-coverage", "LOW", "bundle/facts/source.md", "Not listed in index.md"],
    ]);
  });

  it("keeps retired items out of ownerless and staleness findings", () => {
    const result = patrol(FIXTURE, { now: NOW });
    expect(result.findings.some((f) => f.file === "bundle/facts/retired.md")).toBe(false);
  });

  it("pins drift source filtering for text, binary, missing and external links", () => {
    const jobs = collectBundleDriftJobs(loadBundle(FIXTURE));
    const byTarget = new Map(jobs.map((j) => [j.target.path, j.sources.map((s) => s.path)]));
    expect(byTarget.get("bundle/facts/drift-target.md")).toEqual([
      "bundle/data/source.csv",
      "bundle/facts/source.md",
    ]);
    expect(byTarget.get("bundle/facts/drift-target.md")).not.toContain("bundle/data/photo.png");
    expect([...byTarget.keys()].sort()).toEqual([
      "bundle/facts/active-link.md",
      "bundle/facts/active-note.md",
      "bundle/facts/drift-target.md",
    ]);
  });
});
