import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { collectBundleDriftJobs, collectBundleExternalSourceRefs } from "../src/ai/drift.js";
import { loadBundle } from "../src/core/bundle.js";
import { loadEstate } from "../src/core/estate.js";
import { patrol, patrolEstate } from "../src/index.js";
import { snapshotBundle, snapshotEstate } from "../src/verify.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "northwind-memory-lab");
const NOW = new Date("2026-07-20");

describe("synthetic project: northwind-memory-lab", () => {
  it("exercises bundle memory checks without becoming a noise storm", () => {
    const result = patrol(FIXTURE, { now: NOW, memory: true });
    expect(result.stats.concepts).toBe(7);
    expect(result.stats.definitions).toBe(1);
    expect(result.stats.findingsBySeverity.HIGH).toBe(0);
    expect(result.findings.length).toBeLessThanOrEqual(3);
  });

  it("loads source/raw evidence for drift and verify without treating it as governed concepts", () => {
    const bundle = loadBundle(FIXTURE);
    expect(bundle.evidenceFiles.map((f) => f.bundlePath).sort()).toEqual([
      "raw/consent-export.csv",
      "sources/consent-analysis.md",
      "sources/interviews/customer-001.md",
      "sources/refund-policy.md",
    ]);

    const jobs = collectBundleDriftJobs(bundle, { memory: true });
    const byTarget = new Map(jobs.map((j) => [j.target.path, j.sources.map((s) => s.path).sort()]));
    expect(byTarget.get("bundle/facts/consent-lifecycle.md")).toEqual([
      "bundle/raw/consent-export.csv",
      "bundle/sources/consent-analysis.md",
    ]);
    expect(collectBundleExternalSourceRefs(bundle)).toEqual([
      {
        target: {
          path: "bundle/facts/refund-policy.md",
          content: bundle.concepts.find((c) => c.bundlePath === "facts/refund-policy.md")?.content ?? "",
        },
        urls: ["https://example.com/northwind/refunds.txt"],
      },
    ]);
  });

  it("covers the estate surface with authored and plugin-hosted items", () => {
    const estate = loadEstate(join(FIXTURE, "estate"), "estate", { homeDir: FIXTURE });
    expect(estate.items.map((i) => [i.register, i.name, i.thirdParty])).toEqual([
      ["skill", "reconcile-ledger", false],
      ["agent", "researcher", false],
      ["command", "patrol", false],
      ["plugin", "vendor", true],
      ["skill", "vendor-helper", true],
    ]);

    const result = patrolEstate(join(FIXTURE, "estate"), "estate", { now: NOW, homeDir: FIXTURE });
    expect(result.stats.findingsBySeverity.HIGH).toBe(0);
  });

  it("creates verify baselines across bundle and estate surfaces", () => {
    const bundleSnapshot = snapshotBundle(FIXTURE, NOW);
    expect(bundleSnapshot.items.some((i) => i.path === "bundle/facts/consent-lifecycle.md")).toBe(true);
    expect(bundleSnapshot.items.find((i) => i.path === "bundle/cache/search-index.md")?.evidenceRefs).toEqual([
      "bundle/facts/consent-lifecycle.md",
    ]);

    const estateSnapshot = snapshotEstate(join(FIXTURE, "estate"), "estate", NOW);
    expect(estateSnapshot.items.map((i) => i.path).sort()).toEqual([
      "agents/researcher.md",
      "commands/patrol.md",
      "plugins/vendor",
      "plugins/vendor/skills/vendor-helper/SKILL.md",
      "skills/reconcile-ledger/SKILL.md",
    ]);
  });
});
