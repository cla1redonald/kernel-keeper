import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLinks, extractOwner, loadBundle, parseFrontmatter, resolveLink } from "../src/core/bundle.js";
import { pointerIntegrity, orphans } from "../src/checks/index.js";
import type { PatrolOptions } from "../src/types.js";

const OPTS: PatrolOptions = { policyDays: 90, journalDays: 30, now: new Date("2026-07-11") };

describe("symlink safety (reviewer Must Fix)", () => {
  it("never follows symlinks - no foreign ingestion, no cycle crash", () => {
    const outside = mkdtempSync(join(tmpdir(), "kk-outside-"));
    writeFileSync(join(outside, "secret.md"), "---\ntype: Secret\n---\nnot yours");
    const repo = mkdtempSync(join(tmpdir(), "kk-repo-"));
    const bundle = join(repo, "bundle");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "index.md"), "---\ntype: Index\n---\n# i\n- [a](/a.md)");
    writeFileSync(join(bundle, "log.md"), "---\ntype: Log\n---\n- **2026-07-01** - created.");
    writeFileSync(join(bundle, "a.md"), "---\ntype: Metric\ntitle: A\ndescription: d\ntimestamp: 2026-07-01\n---\n**Owner.** Team A.");
    symlinkSync(join(outside, "secret.md"), join(bundle, "stolen.md")); // file symlink out of repo
    symlinkSync(repo, join(bundle, "loop")); // directory symlink cycle
    const b = loadBundle(repo);
    expect([...b.repoFiles].some((p) => p.includes("stolen"))).toBe(false);
    expect(b.concepts.some((c) => c.content.includes("not yours"))).toBe(false);
    expect(b.concepts.length).toBe(3); // index, log, a - nothing via the loop
  });
});

describe("BOM tolerance (reviewer Should Fix)", () => {
  it("parses frontmatter behind a UTF-8 BOM", () => {
    expect(parseFrontmatter("﻿---\ntype: Metric\n---\n# x")).toEqual({ type: "Metric" });
  });
});

describe("relative concept back-references (reviewer Should Fix)", () => {
  const mini = {
    repoRoot: "/x",
    bundleRel: "bundle",
    repoFiles: new Set(["bundle/metrics/m.md", "bundle/definitions/m.yml"]),
    concepts: [
      {
        path: "bundle/metrics/m.md",
        bundlePath: "metrics/m.md",
        content: "[def](../definitions/m.yml)",
        frontmatter: { type: "Metric" },
        links: [{ target: "../definitions/m.yml", resolved: "bundle/definitions/m.yml" }],
        owner: "Team A",
      },
    ],
    definitions: [
      { path: "bundle/definitions/m.yml", bundlePath: "definitions/m.yml", content: "", owner: null, conceptRef: "../metrics/m.md" },
    ],
  };
  it("pointer-integrity resolves relative refs - no false HIGH", () => {
    const f = pointerIntegrity(mini, OPTS);
    expect(f.filter((x) => x.severity === "HIGH")).toHaveLength(0);
  });
  it("orphans counts relative back-refs as inbound", () => {
    expect(orphans(mini, OPTS)).toHaveLength(0);
  });
});

describe("owner placeholders", () => {
  it("rejects TBD/N-A style placeholders", () => {
    expect(extractOwner("**Owner.** TBD.", null)).toBeNull();
    expect(extractOwner("**Owner.** Unassigned.", null)).toBeNull();
    expect(extractOwner("**Owner.** Payments team.", null)).toBe("Payments team");
  });
});

describe("link extraction edge cases", () => {
  it("handles title attributes", () => {
    expect(extractLinks('[a](/x.md "The Title") [b](y.md \'t\')')).toEqual(["/x.md", "y.md"]);
  });
  it("decodes percent-encoded targets", () => {
    expect(resolveLink("my%20file.md", "bundle/a.md", "bundle")).toBe("bundle/my file.md");
  });
});

describe("fence whitespace tolerance (field-tested: iOS predictive text)", () => {
  it("parses frontmatter whose opening fence has a trailing space", () => {
    const fm = parseFrontmatter("--- \ntype: Concept\ntitle: T\n---\n\n# T\n");
    expect(fm?.type).toBe("Concept");
  });
  it("parses frontmatter whose opening fence has a trailing tab", () => {
    const fm = parseFrontmatter("---\t\ntype: Concept\n---\nbody");
    expect(fm?.type).toBe("Concept");
  });
});
