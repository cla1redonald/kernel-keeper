import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderProposalMarkdown } from "../src/ai/proposal.js";
import { hashReviewedSurface, sha256Hex } from "../src/ai/provenance.js";
import { findingCopy, humanizeCheck } from "../src/glass/copy.js";
import {
  glassApplyApproved,
  glassDecideProposal,
  glassGetAuditTrail,
  glassGetProposalDetail,
  glassListProposals,
  glassPreviewApply,
  glassScanSurface,
} from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NORTHWIND = join(ROOT, "tests", "fixtures", "northwind-memory-lab");
const ESTATE_FIXTURE = join(ROOT, "tests", "fixtures", "estate");
const TARGET_COMMAND = "---\ndescription: Existing command\nowner: Ops\n---\n# Existing\n";

function commandEstateFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kk-glass-"));
  mkdirSync(join(root, "commands"), { recursive: true });
  writeFileSync(join(root, "commands", "target.md"), TARGET_COMMAND);
  return root;
}

function writeNewProcedureProposal(root: string, elected = true): string {
  const props = join(root, "props");
  mkdirSync(props);
  const reviewed = hashReviewedSurface([{ path: "target.md", content: TARGET_COMMAND }]);
  const content = renderProposalMarkdown({
    id: "P-glass-procedure",
    kind: "new-procedure",
    target: "promote-insight.md",
    summary: "Promote repeated insight workflow",
    rationale: "Repeated operating lessons should become governed commands.",
    frontmatterPatch: null,
    bodyDraft: "---\ndescription: Promote repeated insight into governed behavior.\nowner: Ops\n---\n# Promote Insight\n\nUse this when a repeated lesson should become a command.\n",
    journalLine: "- **2026-07-20** - promoted insight command [proposal: P-glass-procedure] [decision: elected] [by: Claire]",
    indexEntry: null,
    confidence: "high",
    evidenceQuotes: [{ file: "target.md", quote: "Existing command" }],
    needsHuman: true,
  }, {
    agent: "drift-reviewer",
    model: "manual-fixture",
    promptSha256: sha256Hex("glass service fixture"),
    evidenceFiles: ["target.md"],
    reviewedSurfaceSha256: reviewed.sha256,
    reviewedSurfaceFiles: reviewed.files,
    generatedAt: "2026-07-20T10:00:00.000Z",
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  writeFileSync(
    join(props, "P-glass-procedure.md"),
    elected ? content.replace("elected: false", "elected: true").replace("- [ ] Elect", "- [x] Elect") : content,
  );
  return props;
}

describe("Glass service boundary", () => {
  it("has business-facing copy for known check names", () => {
    const checks = [
      "agent-visibility",
      "archive-lifecycle",
      "claim-receipts",
      "command-shape",
      "compartment-boundaries",
      "dangling-links",
      "dangling-refs",
      "dated-overview",
      "deprecated-tools",
      "derived-artifacts",
      "frontmatter",
      "index-coverage",
      "index-line-quality",
      "journal",
      "keeper-internal",
      "name-collisions",
      "orphans",
      "ownerless",
      "plugin-shape",
      "pointer-integrity",
      "recall-evidence",
      "semantic-drift",
      "skill-shape",
      "stable-ids",
      "staleness",
      "supersession-integrity",
      "unjournalled-change",
    ];

    for (const check of checks) {
      const copy = findingCopy({ check, severity: "LOW", message: "test" });
      expect(copy.title).not.toBe(humanizeCheck(check));
      expect(copy.whyItMatters).toBeTruthy();
      expect(copy.recommendedAction).toBeTruthy();
    }
  });

  it("scans a bundle surface into business-facing findings", () => {
    const scan = glassScanSurface(join(NORTHWIND, "bundle"), {
      memory: true,
      now: new Date("2026-07-20T10:00:00.000Z"),
    });

    expect(scan.source.kind).toBe("bundle");
    expect(scan.stats.items).toBeGreaterThan(0);
    expect(scan.findings.length).toBeGreaterThan(0);
    expect(scan.findings[0]?.title).toBeTruthy();
    expect(scan.findings[0]?.whyItMatters).toBeTruthy();
    expect(scan.findings[0]?.technical.message).toBeTruthy();
  });

  it("scans an estate surface into business-facing findings", () => {
    const scan = glassScanSurface(ESTATE_FIXTURE, {
      register: "estate",
      now: new Date("2026-07-20T10:00:00.000Z"),
    });

    expect(scan.source.kind).toBe("estate");
    expect(scan.source.register).toBe("estate");
    expect(scan.stats.items).toBeGreaterThan(0);
    expect(scan.findings.some((finding) => finding.register)).toBe(true);
  });

  it("lists proposal cards and details without exposing raw parser output", () => {
    const root = commandEstateFixture();
    try {
      const proposalsDir = writeNewProcedureProposal(root);
      writeFileSync(join(proposalsDir, "not-a-proposal.md"), "---\ntype: Note\n---\n# Nope\n");
      const listed = glassListProposals(proposalsDir);
      expect(listed.refused).toEqual([
        expect.objectContaining({
          proposal: "not-a-proposal",
        }),
      ]);
      expect(listed.proposals).toEqual([
        expect.objectContaining({
          id: "P-glass-procedure",
          state: "approved",
          kind: "new-procedure",
          title: "New procedure: promote-insight.md",
        }),
      ]);

      const detail = glassGetProposalDetail(proposalsDir, "P-glass-procedure");
      expect(detail?.provenance.promptSha256).toHaveLength(64);
      expect(detail?.draft.bodyDraft).toContain("# Promote Insight");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("previews and applies through the Clerk, then exposes audit history", () => {
    const root = commandEstateFixture();
    try {
      const proposalsDir = writeNewProcedureProposal(root);
      const commandsRoot = join(root, "commands");

      const preview = glassPreviewApply(commandsRoot, { register: "commands", proposalsDir });
      expect(preview.canWrite).toBe(true);
      expect(preview.refused).toEqual([]);
      expect(preview.planned[0]?.changes.map((change) => change.file)).toEqual([
        "promote-insight.md",
        ".kernel-keeper/audit/commands-log.md",
      ]);

      const result = glassApplyApproved(commandsRoot, { register: "commands", proposalsDir });
      expect(result.written).toEqual(["promote-insight.md", ".kernel-keeper/audit/commands-log.md"]);
      expect(readFileSync(join(commandsRoot, "promote-insight.md"), "utf8")).toContain("# Promote Insight");

      const again = glassPreviewApply(commandsRoot, { register: "commands", proposalsDir });
      expect(again.canWrite).toBe(false);
      expect(again.skipped).toEqual([
        expect.objectContaining({
          proposal: "P-glass-procedure",
          summary: "This approved change has already been applied.",
        }),
      ]);

      const audit = glassGetAuditTrail(commandsRoot, { register: "commands" });
      expect(audit.entries).toEqual([
        expect.objectContaining({
          date: "2026-07-20",
          proposal: "P-glass-procedure",
          target: "promote-insight.md",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("approves a proposal by writing Clerk-compatible election markers", () => {
    const root = commandEstateFixture();
    try {
      const proposalsDir = writeNewProcedureProposal(root, false);
      const decided = glassDecideProposal(proposalsDir, "P-glass-procedure", "approve", {
        by: "Claire",
        now: new Date("2026-07-20T10:00:00.000Z"),
      });

      expect(decided.state).toBe("approved");
      const content = readFileSync(join(proposalsDir, "P-glass-procedure.md"), "utf8");
      expect(content).toContain("status: elected");
      expect(content).toContain("elected: true");
      expect(content).toContain("- [x] Elect");
      expect(content).toContain("[decision: elected] [by: Claire]");

      const preview = glassPreviewApply(join(root, "commands"), { register: "commands", proposalsDir });
      expect(preview.canWrite).toBe(true);
      expect(preview.refused).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a proposal without making it apply-eligible", () => {
    const root = commandEstateFixture();
    try {
      const proposalsDir = writeNewProcedureProposal(root, false);
      const decided = glassDecideProposal(proposalsDir, "P-glass-procedure", "reject", {
        by: "Claire",
        note: "Wrong target",
        now: new Date("2026-07-20T10:00:00.000Z"),
      });

      expect(decided.state).toBe("rejected");
      const content = readFileSync(join(proposalsDir, "P-glass-procedure.md"), "utf8");
      expect(content).toContain("status: rejected");
      expect(content).toContain("elected: false");
      expect(content).toContain("[decision: rejected] [by: Claire]");
      expect(content).toContain("Wrong target");

      const preview = glassPreviewApply(join(root, "commands"), { register: "commands", proposalsDir });
      expect(preview.canWrite).toBe(false);
      expect(preview.skipped[0]?.technicalReason).toBe("not elected");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records edit requests without altering draft content", () => {
    const root = commandEstateFixture();
    try {
      const proposalsDir = writeNewProcedureProposal(root, false);
      const before = readFileSync(join(proposalsDir, "P-glass-procedure.md"), "utf8");
      const bodyBefore = before.match(/### New procedure:\r?\n```md\r?\n([\s\S]*?)\r?\n```/)?.[1];

      const decided = glassDecideProposal(proposalsDir, "P-glass-procedure", "request-edit", {
        by: "Claire\nReviewer]",
        note: "Make the command name\nmore specific]",
        now: new Date("2026-07-20T10:00:00.000Z"),
      });

      const after = readFileSync(join(proposalsDir, "P-glass-procedure.md"), "utf8");
      const bodyAfter = after.match(/### New procedure:\r?\n```md\r?\n([\s\S]*?)\r?\n```/)?.[1];
      expect(decided.state).toBe("amended");
      expect(bodyAfter).toBe(bodyBefore);
      expect(after).toContain("status: amended");
      expect(after).toContain("[decision: amended] [by: Claire Reviewer)]");
      expect(after).toContain("Make the command name more specific)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes refused proposal reasons for reviewers", () => {
    const root = commandEstateFixture();
    try {
      const proposalsDir = writeNewProcedureProposal(root, false);
      const preview = glassPreviewApply(join(root, "commands"), { register: "commands", proposalsDir });

      expect(preview.canWrite).toBe(false);
      expect(preview.skipped).toEqual([
        expect.objectContaining({
          proposal: "P-glass-procedure",
          summary: "Waiting for human approval.",
          technicalReason: "not elected",
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
