import { beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { patrol, exitCode, renderMarkdown } from "../src/index.js";

// The real Northwind Money bundle (github.com/cla1redonald/team-os), used read-only.
// Set TEAM_OS_PATH to a checkout of that repo to run these tests. CI clones it and
// sets the variable; locally the tests skip with a message when it is unset.
const TEAM_OS = process.env.TEAM_OS_PATH ?? "";
const HAS_TEAM_OS = TEAM_OS !== "" && existsSync(TEAM_OS);

if (!HAS_TEAM_OS) {
  console.warn(
    "integration tests skipped: set TEAM_OS_PATH to a checkout of github.com/cla1redonald/team-os to run them.",
  );
}

describe.skipIf(!HAS_TEAM_OS)("integration: the Northwind Money bundle", () => {
  // Lazy: skipIf only skips the tests - the describe body still runs at collection
  // time, so an eager patrol() here would throw on machines without the fixture.
  let result: ReturnType<typeof patrol>;
  beforeAll(() => {
    result = patrol(TEAM_OS, { now: new Date("2026-07-13") });
  });

  it("loads the full bundle", () => {
    expect(result.stats.concepts).toBeGreaterThan(20);
    expect(result.stats.definitions).toBe(3);
  });

  it("produces no false-positive noise storms", () => {
    // The bundle is actively maintained: no dangling links, no missing frontmatter,
    // fresh journal, no staleness at the default 90-day policy.
    const byCheck = new Map<string, number>();
    for (const f of result.findings) byCheck.set(f.check, (byCheck.get(f.check) ?? 0) + 1);
    expect(byCheck.get("dangling-links") ?? 0).toBe(0);
    expect(byCheck.get("frontmatter") ?? 0).toBe(0);
    expect(byCheck.get("staleness") ?? 0).toBe(0);
    expect(byCheck.get("journal") ?? 0).toBe(0);
    expect(byCheck.get("pointer-integrity") ?? 0).toBe(0);
    // Total volume stays a digest, not a storm.
    expect(result.findings.length).toBeLessThan(25);
  });

  it("finds the genuine gaps: ownerless concepts exist (glossary terms are LOW)", () => {
    const ownerlessFindings = result.findings.filter((f) => f.check === "ownerless");
    expect(ownerlessFindings.length).toBeGreaterThan(0);
    const glossary = ownerlessFindings.filter((f) => f.file?.includes("glossary/"));
    expect(glossary.every((f) => f.severity === "LOW")).toBe(true);
  });

  it("renders an owner-grouped report with the health line", () => {
    const md = renderMarkdown(result, "team-os", new Date("2026-07-13"));
    expect(md).toContain("# Patrol report: team-os");
    expect(md).toContain("Needs an owner");
    expect(md).toContain("The keeper reports and proposes; it never edits.");
  });

  it("maps to CI exit codes", () => {
    expect(exitCode(result, "high")).toBeLessThanOrEqual(2);
    expect(exitCode({ findings: [], stats: { concepts: 1, definitions: 0, findingsBySeverity: { HIGH: 0, MED: 0, LOW: 0 } } }, "any")).toBe(0);
  });
});

describe.skipIf(!HAS_TEAM_OS)("v0.5 baseline guard - governance checks are deterministic", () => {
  it("team-os counts are pinned with supersession findings included", () => {
    const result = patrol(TEAM_OS, { now: new Date("2026-07-13") });
    expect(result.stats.findingsBySeverity).toEqual({ HIGH: 0, MED: 5, LOW: 8 });
    expect(result.findings.length).toBe(13);
  });
});
