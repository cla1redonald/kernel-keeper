import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compareSnapshots, runVerifyGenerators, snapshotRoot } from "../src/verify.js";

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "kk-verify-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root: string, rel: string, content: string): void {
  const parts = rel.split("/");
  parts.pop();
  const dir = join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe("verify snapshots", () => {
  it("compares a clean bundle baseline with zero damage", () => {
    withTempDir((root) => {
      write(root, "bundle/index.md", "# Index\n\n- [Target](/facts/target.md) - sourced claim.\n");
      write(root, "bundle/log.md", "- **2026-07-20** - Init\n");
      write(root, "bundle/facts/target.md", "---\ntype: Reference\n---\n# Target\n\n[source](/sources/source.md)\n");
      write(root, "bundle/sources/source.md", "# Source\n\nTruth.\n");

      const baseline = snapshotRoot(root, { now: new Date("2026-07-20") });
      const result = compareSnapshots(root, baseline, { now: new Date("2026-07-20") });
      expect(result.ok).toBe(true);
      expect(result.damageFraction).toBe(0);
      expect(result.current.items.map((i) => i.path)).toEqual(["bundle/facts/target.md", "bundle/index.md", "bundle/log.md"]);
    });
  });

  it("counts changed, missing, and newly unresolvable bundle evidence once per damaged item", () => {
    withTempDir((root) => {
      write(root, "bundle/index.md", "# Index\n\n- [Target](/facts/target.md) - sourced claim.\n- [Other](/facts/other.md) - another claim.\n");
      write(root, "bundle/log.md", "- **2026-07-20** - Init\n");
      write(root, "bundle/facts/target.md", "---\ntype: Reference\n---\n# Target\n\n[source](/sources/source.md)\n");
      write(root, "bundle/facts/other.md", "---\ntype: Reference\n---\n# Other\n");
      write(root, "bundle/sources/source.md", "# Source\n\nTruth.\n");
      const baseline = snapshotRoot(root, { now: new Date("2026-07-20") });

      write(root, "bundle/facts/other.md", "---\ntype: Reference\n---\n# Other changed\n");
      unlinkSync(join(root, "bundle", "sources", "source.md"));
      unlinkSync(join(root, "bundle", "log.md"));

      const result = compareSnapshots(root, baseline, { now: new Date("2026-07-20") });
      expect(result.ok).toBe(false);
      expect(result.missing).toEqual(["bundle/log.md"]);
      expect(result.changed).toEqual(["bundle/facts/other.md"]);
      expect(result.unresolvedEvidence).toEqual([{ path: "bundle/facts/target.md", ref: "bundle/sources/source.md" }]);
      expect(result.damaged.map((d) => d.path)).toEqual(["bundle/facts/other.md", "bundle/facts/target.md", "bundle/log.md"]);
      expect(result.damageFraction).toBe(3 / 4);
    });
  });

  it("compares estate baselines and path refs", () => {
    withTempDir((root) => {
      write(root, "skills/deploy/SKILL.md", "---\ndescription: Deploy\n---\n# Deploy\n\nSee [checklist](checklist.md).\n");
      write(root, "skills/deploy/checklist.md", "# Checklist\n");
      const baseline = snapshotRoot(root, { register: "estate", now: new Date("2026-07-20") });

      unlinkSync(join(root, "skills", "deploy", "checklist.md"));
      const result = compareSnapshots(root, baseline, { register: "estate", now: new Date("2026-07-20") });
      expect(result.unresolvedEvidence).toEqual([{ path: "skills/deploy/SKILL.md", ref: "checklist.md" }]);
      expect(result.damageFraction).toBe(1);
    });
  });

  it("flags archived items that lose retrieval paths without replacement or note", () => {
    withTempDir((root) => {
      write(root, "bundle/index.md", "# Index\n\n- [Old](/archive/old.md) - archived but discoverable.\n");
      write(root, "bundle/log.md", "- **2026-07-20** - Init\n");
      write(root, "bundle/archive/old.md", "---\ntype: Reference\nstatus: archived\narchive-note: Kept for continuity.\n---\n# Old\n");
      const baseline = snapshotRoot(root, { now: new Date("2026-07-20") });

      write(root, "bundle/index.md", "# Index\n\n");
      write(root, "bundle/archive/old.md", "---\ntype: Reference\nstatus: archived\n---\n# Old\n");
      const result = compareSnapshots(root, baseline, { now: new Date("2026-07-20") });

      expect(result.archiveContinuity).toEqual([
        {
          path: "bundle/archive/old.md",
          reason: "archived item lost every retrieval path without replacement or archive note",
        },
      ]);
      expect(result.damaged.find((d) => d.path === "bundle/archive/old.md")?.reasons).toContain(
        "archived item lost every retrieval path without replacement or archive note",
      );
    });
  });

  it("runs explicit generators before comparing snapshots", () => {
    withTempDir((root) => {
      write(root, "bundle/index.md", "# Index\n\n- [Cache](/cache/generated.md) - generated.\n");
      write(root, "bundle/log.md", "- **2026-07-20** - Init\n");
      write(root, "bundle/cache/generated.md", "---\ntype: Reference\nartifact-kind: cache\ngenerated-from: /sources/source.md\n---\n# Generated\n\nold\n");
      write(root, "bundle/sources/source.md", "# Source\n\nTruth.\n");
      const baseline = snapshotRoot(root, { now: new Date("2026-07-20") });

      write(root, "bundle/cache/generated.md", "---\ntype: Reference\nartifact-kind: cache\ngenerated-from: /sources/source.md\n---\n# Generated\n\nbroken\n");
      write(root, "generate.mjs", [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('bundle/cache/generated.md', '---\\ntype: Reference\\nartifact-kind: cache\\ngenerated-from: /sources/source.md\\n---\\n# Generated\\n\\nold\\n');",
      ].join("\n"));

      runVerifyGenerators([`${process.execPath} ${join(root, "generate.mjs")}`], root);
      const result = compareSnapshots(root, baseline, { now: new Date("2026-07-20") });
      expect(result.ok).toBe(true);
      expect(result.changed).toEqual([]);
    });
  });
});
