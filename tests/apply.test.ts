import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProposalMarkdown, planApply, writeApply } from "../src/apply/proposals.js";
import { hashReviewedSurface } from "../src/ai/provenance.js";
import { renderProposalMarkdown } from "../src/ai/proposal.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const DEFAULT_TARGET_CONTENT = "---\ntype: Reference\ntitle: Target\ndescription: Old\ntimestamp: 2026-07-01\n---\n# Target\n\nOld body.\n";
const DEFAULT_REVIEWED = hashReviewedSurface([{ path: "bundle/facts/target.md", content: DEFAULT_TARGET_CONTENT }]);
const ESTATE_TARGET_CONTENT = "---\ndescription: Target command\nowner: Claire\n---\n# Target\n\nOld command.\n";

function proposal(overrides: {
  id?: string;
  target?: string;
  elected?: string;
  status?: string;
  needsHuman?: string;
  checks?: string;
  evidence?: string;
  patch?: string;
  body?: string;
  indexEntry?: string;
  journal?: string;
  kind?: "amend" | "new-concept" | "new-procedure";
  reviewedSurface?: { sha256: string; files: { path: string; sha256: string }[] } | null;
} = {}): string {
  const id = overrides.id ?? "P-abc123def456";
  const target = overrides.target ?? "bundle/facts/target.md";
  const kind = overrides.kind ?? "amend";
  const patch = overrides.patch === undefined ? "last-affirmed: 2026-07-19\nowner: Claire" : overrides.patch;
  const body = overrides.body ?? "";
  const journal = overrides.journal ?? `- **2026-07-19** - elected ${target} [proposal: ${id}] [decision: elected] [by: Claire]`;
  const reviewedSurface = overrides.reviewedSurface === undefined ? DEFAULT_REVIEWED : overrides.reviewedSurface;
  return `---
type: Proposal
id: ${id}
proposer: scribe
model: claude-sonnet-5
prompt-sha256: ${"f".repeat(64)}
${reviewedSurface ? `reviewed-surface-sha256: ${reviewedSurface.sha256}
reviewed-surface: [${reviewedSurface.files.map((f) => `${f.path}:${f.sha256}`).join(", ")}]
` : ""}target: ${target}
kind: ${kind}
checks: [${overrides.checks ?? "frontmatter"}]
confidence: medium
needs-human: ${overrides.needsHuman ?? "true"}
evidence: [${overrides.evidence ?? target}]
generated-at: 2026-07-19T00:00:00.000Z
usage-tokens: 1+1
status: ${overrides.status ?? "pending"}
elected: ${overrides.elected ?? "false"}
---
# Proposal ${id} - Test proposal

## Draft (immutable)
${patch && kind === "amend" ? `### Frontmatter patch
\`\`\`yaml
${patch}
\`\`\`
` : ""}${body ? `### ${kind === "new-concept" ? `New concept: ${target}` : kind === "new-procedure" ? `New procedure: ${target}` : "Body draft"}
\`\`\`markdown
${body}
\`\`\`
` : ""}${overrides.indexEntry ? `### index.md entry
\`\`\`markdown
${overrides.indexEntry}
\`\`\`
` : ""}### Journal line (paste into log.md on election)
\`\`\`markdown
${journal}
\`\`\`

## Decision
- [ ] Elect - apply as drafted
- [ ] Amend - record changes under Amendment, then elect
- [ ] Reject
`;
}

function bundleFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kk-apply-"));
  mkdirSync(join(root, "bundle", "facts"), { recursive: true });
  writeFileSync(join(root, "bundle", "index.md"), "---\ntype: Index\n---\n[target](/facts/target.md)\n");
  writeFileSync(join(root, "bundle", "log.md"), "---\ntype: Log\n---\n# Log\n");
  writeFileSync(join(root, "bundle", "facts", "target.md"), DEFAULT_TARGET_CONTENT);
  return root;
}

function addSecondTarget(root: string): string {
  const content = "---\ntype: Reference\ntitle: Other\ndescription: Old\ntimestamp: 2026-07-01\n---\n# Other\n\nOld body.\n";
  writeFileSync(join(root, "bundle", "facts", "other.md"), content);
  return content;
}

function estateFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "kk-apply-estate-"));
  mkdirSync(join(root, "estate", "commands"), { recursive: true });
  writeFileSync(join(root, "outside.md"), "outside evidence\n");
  writeFileSync(join(root, "estate", "commands", "target.md"), ESTATE_TARGET_CONTENT);
  return root;
}

function estateProposal(overrides: Parameters<typeof proposal>[0] = {}): string {
  return proposal({
    target: "commands/target.md",
    evidence: "commands/target.md",
    reviewedSurface: hashReviewedSurface([{ path: "commands/target.md", content: ESTATE_TARGET_CONTENT }]),
    ...overrides,
  });
}

describe("apply proposal parsing", () => {
  it("requires a real human election marker, not merely an elected journal draft", () => {
    const pending = parseProposalMarkdown(proposal());
    expect(pending.journalLine).toContain("[decision: elected]");
    expect(pending.elected).toBe(false);

    expect(parseProposalMarkdown(proposal({ elected: "true" })).elected).toBe(true);
    expect(parseProposalMarkdown(proposal({ status: "elected" })).elected).toBe(true);
    expect(parseProposalMarkdown(proposal().replace("- [ ] Elect", "- [x] Elect")).elected).toBe(true);
  });

  it("renders and parses new-procedure proposal drafts", () => {
    const content = renderProposalMarkdown({
      id: "P-procedure",
      kind: "new-procedure",
      target: "skills/customer-insight/SKILL.md",
      summary: "Promote customer insight workflow",
      rationale: "Repeated work should become an invokable skill.",
      frontmatterPatch: null,
      bodyDraft: "---\ndescription: Turn repeated customer notes into reusable insight.\n---\n# Customer Insight\n",
      journalLine: "- **YYYY-MM-DD** - created customer insight skill [proposal: P-procedure] [decision: elected] [by: <judge>]",
      indexEntry: null,
      confidence: "medium",
      evidenceQuotes: [{ file: "notes/customer.md", quote: "repeat this insight workflow" }],
      needsHuman: true,
    }, {
      agent: "gap-miner",
      model: "claude-sonnet-5",
      promptSha256: "a".repeat(64),
      evidenceFiles: ["notes/customer.md"],
      reviewedSurfaceSha256: "b".repeat(64),
      reviewedSurfaceFiles: [{ path: "notes/customer.md", sha256: "c".repeat(64) }],
      generatedAt: "2026-07-20T10:00:00.000Z",
      usage: { inputTokens: 1, outputTokens: 2 },
    });

    expect(content).toContain("kind: new-procedure");
    expect(content).toContain("### New procedure: skills/customer-insight/SKILL.md");
    const parsed = parseProposalMarkdown(content);
    expect(parsed.kind).toBe("new-procedure");
    expect(parsed.bodyDraft).toContain("# Customer Insight");
  });
});

describe("apply planning", () => {
  it("plans frontmatter and journal diffs for elected proposals without writing", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-abc123def456.md"), proposal({ elected: "true" }));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.skipped).toEqual([]);
      expect(plan.refused).toEqual([]);
      expect(plan.planned).toHaveLength(1);
      expect(plan.planned[0]?.changes.map((c) => c.file)).toEqual(["bundle/facts/target.md", "bundle/log.md"]);
      expect(plan.planned[0]?.changes[0]?.diff).toContain("+last-affirmed: 2026-07-19");
      expect(readFileSync(join(root, "bundle", "facts", "target.md"), "utf8")).not.toContain("last-affirmed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips unelected proposals and refuses ambiguous target collisions", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-a.md"), proposal({ id: "P-a" }));
      writeFileSync(join(props, "P-b.md"), proposal({ id: "P-b", elected: "true" }));
      writeFileSync(join(props, "P-c.md"), proposal({ id: "P-c", elected: "true" }));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.skipped).toEqual([{ proposal: "P-a", reason: "not elected" }]);
      expect(plan.refused.map((r) => r.reason)).toEqual([
        "multiple proposals target bundle/facts/target.md",
        "multiple proposals target bundle/facts/target.md",
      ]);
      expect(plan.planned).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses missing provenance and missing evidence files", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-missing-evidence.md"), proposal({ id: "P-missing-evidence", elected: "true", evidence: "bundle/facts/missing.md" }));
      writeFileSync(join(props, "P-no-prov.md"), proposal({ id: "P-no-prov", target: "bundle/facts/other.md", elected: "true" }).replace(/^prompt-sha256: .+\n/m, ""));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.refused).toEqual([
        { proposal: "P-missing-evidence", reason: "missing evidence file(s): bundle/facts/missing.md" },
        { proposal: "P-no-prov", reason: "missing prompt-sha256 provenance" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses stale reviewed target content by default", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-stale.md"), proposal({ id: "P-stale", elected: "true" }));
      writeFileSync(join(root, "bundle", "facts", "target.md"), DEFAULT_TARGET_CONTENT.replace("Old body.", "Changed after review."));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.planned).toEqual([]);
      expect(plan.refused).toEqual([{ proposal: "P-stale", reason: "reviewed surface changed since proposal was drafted" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses frontmatter patches against non-simple YAML target frontmatter", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      const complex = "---\ntype: Reference\ntitle: Target\ndescription: |\n  Old multiline description\n---\n# Target\n\nOld body.\n";
      writeFileSync(join(root, "bundle", "facts", "target.md"), complex);
      writeFileSync(join(props, "P-complex.md"), proposal({
        id: "P-complex",
        elected: "true",
        reviewedSurface: hashReviewedSurface([{ path: "bundle/facts/target.md", content: complex }]),
      }));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.planned).toEqual([]);
      expect(plan.refused).toEqual([
        {
          proposal: "P-complex",
          reason: "target frontmatter uses non-simple YAML; apply write-mode cannot safely round-trip it",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips fully applied frontmatter, body, and journal changes idempotently", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      const id = "P-applied";
      const appliedTarget = "---\ntype: Reference\ntitle: Target\ndescription: Old\ntimestamp: 2026-07-01\nlast-affirmed: 2026-07-19\nowner: Claire\n---\n# Target\n\nNew body.\n";
      const journal = `- **2026-07-19** - elected bundle/facts/target.md [proposal: ${id}] [decision: elected] [by: Claire]`;
      writeFileSync(join(root, "bundle", "facts", "target.md"), appliedTarget);
      writeFileSync(join(root, "bundle", "log.md"), `---\ntype: Log\n---\n# Log\n${journal}\n`);
      writeFileSync(join(props, `${id}.md`), proposal({
        id,
        elected: "true",
        body: "# Target\n\nNew body.",
        journal,
        reviewedSurface: hashReviewedSurface([{ path: "bundle/facts/target.md", content: appliedTarget }]),
      }));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.planned).toEqual([]);
      expect(plan.refused).toEqual([]);
      expect(plan.skipped).toEqual([{ proposal: id, reason: "already applied" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects already-applied index entries and inserts missing bundle index entries", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      const entry = "- [target](/facts/target.md) - Target fact.";
      writeFileSync(join(root, "bundle", "index.md"), `---\ntype: Index\n---\n${entry}\n`);
      writeFileSync(join(props, "P-index-applied.md"), proposal({
        id: "P-index-applied",
        elected: "true",
        patch: "",
        journal: "",
        indexEntry: entry,
      }));
      writeFileSync(join(props, "P-index-missing.md"), proposal({
        id: "P-index-missing",
        elected: "true",
        patch: "",
        journal: "",
        indexEntry: "- [target](/facts/target.md) - Target fact, newly indexed.",
      }));

      const appliedPlan = planApply(root, { proposalsDir: props, proposalId: "P-index-applied" });
      expect(appliedPlan.skipped).toEqual([{ proposal: "P-index-applied", reason: "already applied" }]);
      expect(appliedPlan.refused).toEqual([]);
      expect(appliedPlan.planned).toEqual([]);

      const missingPlan = planApply(root, { proposalsDir: props, proposalId: "P-index-missing" });
      expect(missingPlan.skipped).toEqual([]);
      expect(missingPlan.refused).toEqual([]);
      expect(missingPlan.planned[0]?.changes.map((c) => c.file)).toEqual(["bundle/index.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a complete new concept, index entry, and journal line as one write unit", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      const target = "facts/new-concept.md";
      const concept = "---\ntype: Reference\ntitle: New concept\ndescription: A new governed fact.\ntimestamp: 2026-07-20\n---\n# New concept\n\nA new governed fact.\n";
      writeFileSync(join(props, "P-new.md"), proposal({
        id: "P-new",
        target,
        kind: "new-concept",
        needsHuman: "false",
        patch: "",
        body: concept,
        indexEntry: "- [New concept](/facts/new-concept.md) - A new governed fact.",
        evidence: "bundle/facts/target.md",
        reviewedSurface: DEFAULT_REVIEWED,
        elected: "true",
      }));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.refused).toEqual([]);
      expect(plan.planned[0]?.changes.map((c) => c.file)).toEqual([
        "bundle/facts/new-concept.md",
        "bundle/index.md",
        "bundle/log.md",
      ]);

      const result = writeApply(root, { proposalsDir: props });
      expect(result.written).toEqual(["bundle/facts/new-concept.md", "bundle/index.md", "bundle/log.md"]);
      expect(readFileSync(join(root, "bundle", "facts", "new-concept.md"), "utf8")).toBe(concept);
      expect(readFileSync(join(root, "bundle", "index.md"), "utf8")).toContain("[New concept](/facts/new-concept.md)");
      expect(planApply(root, { proposalsDir: props }).skipped).toEqual([{ proposal: "P-new", reason: "already applied" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses new concepts whose target exists with different content", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-conflict.md"), proposal({
        id: "P-conflict",
        target: "bundle/facts/target.md",
        kind: "new-concept",
        patch: "",
        body: "---\ntype: Reference\ntitle: Different\n---\n# Different\n",
        indexEntry: "- [Different](/facts/target.md) - Different.",
        evidence: "bundle/facts/target.md",
        reviewedSurface: DEFAULT_REVIEWED,
        elected: "true",
      }));

      expect(planApply(root, { proposalsDir: props }).refused).toEqual([
        { proposal: "P-conflict", reason: "target already exists with different content: bundle/facts/target.md" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses new concept targets that escape the bundle", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-escape.md"), proposal({
        id: "P-escape",
        target: "../outside.md",
        kind: "new-concept",
        patch: "",
        body: "---\ntype: Reference\ntitle: Outside\n---\n# Outside\n",
        indexEntry: "- [Outside](../outside.md) - Outside.",
        evidence: "bundle/facts/target.md",
        reviewedSurface: DEFAULT_REVIEWED,
        elected: "true",
      }));

      expect(planApply(root, { proposalsDir: props }).refused).toEqual([
        { proposal: "P-escape", reason: "proposal target escapes bundle root" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes eligible changes only when there are no refused proposals", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-abc123def456.md"), proposal({ elected: "true" }));

      const result = writeApply(root, { proposalsDir: props });
      expect(result.written).toEqual(["bundle/facts/target.md", "bundle/log.md"]);
      expect(result.plan.refused).toEqual([]);
      expect(readFileSync(join(root, "bundle", "facts", "target.md"), "utf8")).toContain("last-affirmed: 2026-07-19");
      expect(readFileSync(join(root, "bundle", "log.md"), "utf8")).toContain("[proposal: P-abc123def456]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses write mode when multiple planned changes touch the same file", () => {
    const root = bundleFixture();
    try {
      const otherContent = addSecondTarget(root);
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-one.md"), proposal({ id: "P-one", elected: "true" }));
      writeFileSync(join(props, "P-two.md"), proposal({
        id: "P-two",
        target: "bundle/facts/other.md",
        elected: "true",
        evidence: "bundle/facts/other.md",
        reviewedSurface: hashReviewedSurface([{ path: "bundle/facts/other.md", content: otherContent }]),
      }));

      const result = writeApply(root, { proposalsDir: props });
      expect(result.written).toEqual([]);
      expect(result.plan.refused).toEqual([{ proposal: "(write)", reason: "multiple planned changes touch bundle/log.md; use --proposal to apply one at a time" }]);
      expect(readFileSync(join(root, "bundle", "facts", "target.md"), "utf8")).not.toContain("last-affirmed");
      expect(readFileSync(join(root, "bundle", "facts", "other.md"), "utf8")).not.toContain("last-affirmed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses malformed proposal files without aborting the whole run", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-good.md"), proposal({ id: "P-good", elected: "true" }));
      writeFileSync(join(props, "P-bad.md"), proposal({ id: "P-bad", elected: "true", patch: "not a patch line" }));

      const plan = planApply(root, { proposalsDir: props });
      expect(plan.planned.map((p) => p.proposal.id)).toEqual(["P-good"]);
      expect(plan.refused).toEqual([{ proposal: "P-bad", reason: "malformed frontmatter patch line: not a patch line" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filters by proposal id and check label", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-frontmatter.md"), proposal({ id: "P-frontmatter", elected: "true", checks: "frontmatter" }));
      writeFileSync(join(props, "P-drift.md"), proposal({ id: "P-drift", target: "bundle/facts/other.md", elected: "true", checks: "semantic-drift", evidence: "bundle/facts/target.md" }));

      expect(planApply(root, { proposalsDir: props, proposalId: "P-frontmatter" }).refused).toEqual([]);
      expect(planApply(root, { proposalsDir: props, check: "semantic-drift" }).refused[0]?.reason).toBe("target is not in the loaded surface: bundle/facts/other.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses estate evidence paths that escape the loaded root", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-escape.md"), proposal({
        id: "P-escape",
        target: "commands/target.md",
        elected: "true",
        evidence: "../outside.md",
        reviewedSurface: hashReviewedSurface([{ path: "commands/target.md", content: ESTATE_TARGET_CONTENT }]),
      }));

      const plan = planApply(estateRoot, { proposalsDir: props, register: "estate" });
      expect(plan.planned).toEqual([]);
      expect(plan.refused).toEqual([{ proposal: "P-escape", reason: "missing evidence file(s): ../outside.md" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plans and writes an estate audit log entry with authored estate changes", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-estate.md"), estateProposal({
        id: "P-estate",
        elected: "true",
        checks: "command-shape",
        journal: "- **2026-07-20** - elected commands/target.md [proposal: P-estate] [decision: elected] [by: Claire]",
      }));

      const plan = planApply(estateRoot, { proposalsDir: props, register: "estate" });
      expect(plan.refused).toEqual([]);
      expect(plan.planned[0]?.changes.map((c) => c.file)).toEqual([
        "commands/target.md",
        ".kernel-keeper/audit/estate-log.md",
      ]);
      expect(plan.planned[0]?.changes[1]?.diff).toContain("applied proposal P-estate to `commands/target.md`");
      expect(existsSync(join(estateRoot, ".kernel-keeper", "audit", "estate-log.md"))).toBe(false);

      const result = writeApply(estateRoot, { proposalsDir: props, register: "estate" });
      expect(result.written).toEqual(["commands/target.md", ".kernel-keeper/audit/estate-log.md"]);
      expect(readFileSync(join(estateRoot, "commands", "target.md"), "utf8")).toContain("last-affirmed: 2026-07-19");
      expect(readFileSync(join(estateRoot, ".kernel-keeper", "audit", "estate-log.md"), "utf8")).toContain(
        "- **2026-07-20** - applied proposal P-estate to `commands/target.md` [proposal: P-estate] [decision: elected] [by: Claire] [checks: command-shape]",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows estate write planning without an audit log only when explicitly requested", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-no-audit.md"), estateProposal({ id: "P-no-audit", elected: "true" }));

      const plan = planApply(estateRoot, { proposalsDir: props, register: "estate", noAuditLog: true });
      expect(plan.refused).toEqual([]);
      expect(plan.planned[0]?.changes.map((c) => c.file)).toEqual(["commands/target.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses writes to third-party plugin estate items", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      mkdirSync(join(estateRoot, "plugins", "vendor", "commands"), { recursive: true });
      const pluginContent = "---\ndescription: Vendor command\n---\n# Vendor\n";
      writeFileSync(join(estateRoot, "plugins", "vendor", "commands", "ship.md"), pluginContent);
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-plugin.md"), proposal({
        id: "P-plugin",
        target: "plugins/vendor/commands/ship.md",
        evidence: "plugins/vendor/commands/ship.md",
        elected: "true",
        reviewedSurface: hashReviewedSurface([{ path: "plugins/vendor/commands/ship.md", content: pluginContent }]),
      }));

      expect(planApply(estateRoot, { proposalsDir: props, register: "estate" }).refused).toEqual([
        { proposal: "P-plugin", reason: "target is a third-party plugin item; apply write-mode only edits authored estate items" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a new authored skill and estate audit entry as one write unit", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      const skill = "---\ndescription: Promote repeated customer notes into reusable insight.\nowner: Research Ops\n---\n# Customer Insight\n\nUse this when customer notes repeat across interviews.\n";
      writeFileSync(join(props, "P-new-skill.md"), estateProposal({
        id: "P-new-skill",
        kind: "new-procedure",
        target: "skills/customer-insight/SKILL.md",
        body: skill,
        patch: "",
        evidence: "commands/target.md",
        checks: "procedure-gap",
        elected: "true",
        journal: "- **2026-07-20** - promoted customer insight skill [proposal: P-new-skill] [decision: elected] [by: Claire]",
      }));

      const plan = planApply(estateRoot, { proposalsDir: props, register: "estate" });
      expect(plan.refused).toEqual([]);
      expect(plan.planned[0]?.changes.map((c) => c.file)).toEqual([
        "skills/customer-insight/SKILL.md",
        ".kernel-keeper/audit/estate-log.md",
      ]);

      const result = writeApply(estateRoot, { proposalsDir: props, register: "estate" });
      expect(result.written).toEqual(["skills/customer-insight/SKILL.md", ".kernel-keeper/audit/estate-log.md"]);
      expect(readFileSync(join(estateRoot, "skills", "customer-insight", "SKILL.md"), "utf8")).toBe(skill);
      expect(readFileSync(join(estateRoot, ".kernel-keeper", "audit", "estate-log.md"), "utf8")).toContain("[proposal: P-new-skill]");
      expect(planApply(estateRoot, { proposalsDir: props, register: "estate" }).skipped).toEqual([{ proposal: "P-new-skill", reason: "already applied" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a new command in single-register mode", () => {
    const root = estateFixture();
    try {
      const commandsRoot = join(root, "estate", "commands");
      const props = join(root, "props");
      mkdirSync(props);
      const command = "---\ndescription: Run the customer insight promotion workflow.\n---\n# Insight Promotion\n";
      writeFileSync(join(props, "P-new-command.md"), estateProposal({
        id: "P-new-command",
        kind: "new-procedure",
        target: "insight-promotion.md",
        body: command,
        patch: "",
        evidence: "target.md",
        reviewedSurface: hashReviewedSurface([{ path: "target.md", content: ESTATE_TARGET_CONTENT }]),
        checks: "procedure-gap",
        elected: "true",
      }));

      const result = writeApply(commandsRoot, { proposalsDir: props, register: "commands" });
      expect(result.plan.refused).toEqual([]);
      expect(result.written).toEqual(["insight-promotion.md", ".kernel-keeper/audit/commands-log.md"]);
      expect(readFileSync(join(commandsRoot, "insight-promotion.md"), "utf8")).toBe(command);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses new procedures outside authored register shapes", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-plugin-create.md"), estateProposal({
        id: "P-plugin-create",
        kind: "new-procedure",
        target: "plugins/vendor/commands/ship.md",
        body: "---\ndescription: Do not create plugin files.\n---\n# Plugin\n",
        patch: "",
        elected: "true",
      }));

      expect(planApply(estateRoot, { proposalsDir: props, register: "estate" }).refused).toEqual([
        { proposal: "P-plugin-create", reason: "new-procedure target must be an authored skill, agent, or command path" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses new procedures without discoverable descriptions", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-no-desc.md"), estateProposal({
        id: "P-no-desc",
        kind: "new-procedure",
        target: "agents/insight.md",
        body: "---\nname: insight\n---\n# Insight\n",
        patch: "",
        elected: "true",
      }));

      expect(planApply(estateRoot, { proposalsDir: props, register: "estate" }).refused).toEqual([
        { proposal: "P-no-desc", reason: "new-procedure frontmatter must include `description:`" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires needs-human true for new procedures", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-auto-procedure.md"), estateProposal({
        id: "P-auto-procedure",
        kind: "new-procedure",
        target: "agents/insight.md",
        body: "---\ndescription: Promote insight.\n---\n# Insight\n",
        patch: "",
        needsHuman: "false",
        elected: "true",
      }));

      expect(planApply(estateRoot, { proposalsDir: props, register: "estate" }).refused).toEqual([
        { proposal: "P-auto-procedure", reason: "missing needs-human: true" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!existsSync(CLI))("apply CLI", () => {
  it("prints dry-run diffs by default and writes only with --write", () => {
    const root = bundleFixture();
    try {
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-abc123def456.md"), proposal({ elected: "true" }));
      const stdout = execFileSync("node", [CLI, "apply", root, "--proposals", props], { encoding: "utf8" });
      expect(stdout).toContain("apply --dry-run: P-abc123def456 -> bundle/facts/target.md");
      expect(stdout).toContain("--- a/bundle/facts/target.md");
      expect(readFileSync(join(root, "bundle", "facts", "target.md"), "utf8")).not.toContain("last-affirmed");
      const writeStdout = execFileSync("node", [CLI, "apply", root, "--proposals", props, "--write"], { encoding: "utf8" });
      expect(writeStdout).toContain("apply --write: P-abc123def456 -> bundle/facts/target.md, bundle/log.md");
      expect(readFileSync(join(root, "bundle", "facts", "target.md"), "utf8")).toContain("last-affirmed: 2026-07-19");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes estate audit logs by default", () => {
    const root = estateFixture();
    try {
      const estateRoot = join(root, "estate");
      const props = join(root, "props");
      mkdirSync(props);
      writeFileSync(join(props, "P-estate.md"), estateProposal({
        id: "P-estate",
        elected: "true",
        checks: "command-shape",
        journal: "- **2026-07-20** - elected commands/target.md [proposal: P-estate] [decision: elected] [by: Claire]",
      }));

      const stdout = execFileSync("node", [CLI, "apply", estateRoot, "--register", "estate", "--proposals", props, "--write"], { encoding: "utf8" });
      expect(stdout).toContain("apply --write: P-estate -> commands/target.md, .kernel-keeper/audit/estate-log.md");
      expect(readFileSync(join(estateRoot, ".kernel-keeper", "audit", "estate-log.md"), "utf8")).toContain("[proposal: P-estate]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
