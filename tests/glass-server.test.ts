import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGlassServer, renderApplyPage, renderGlassDashboard, renderProposalInbox } from "../src/glass/server.js";
import { glassScanSurface } from "../src/index.js";
import type { GlassApplyPreview, GlassAuditTrail, GlassProposalCard, GlassProposalDetail, GlassScanResult, GlassSource } from "../src/glass/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NORTHWIND = join(ROOT, "tests", "fixtures", "northwind-memory-lab");

describe("Glass local server", () => {
  it("renders a local dashboard backed by a real scan", () => {
    const scan = glassScanSurface(join(NORTHWIND, "bundle"), {
      memory: true,
      now: new Date("2026-07-20T10:00:00.000Z"),
    });
    const html = renderGlassDashboard(scan);

    expect(html).toContain("Kernel Keeper Glass");
    expect(html).toContain("Review Queue");
    expect(html).toContain("Governed Items");
    expect(html).toContain("What Needs Attention");
    expect(html).toContain("Open detail");
    expect(html).toContain("Why It Matters");
  });

  it("renders filtered queue counts and selected finding details", () => {
    const scan = glassScanSurface(join(NORTHWIND, "bundle"), {
      memory: true,
      now: new Date("2026-07-20T10:00:00.000Z"),
    });
    const first = scan.findings[0];
    const html = renderGlassDashboard(scan, {
      severity: first?.severity,
      findingId: first?.id,
    });

    expect(html).toContain("Visible Queue");
    expect(html).toContain(first?.title);
    expect(html).toContain(first?.recommendedAction);
  });

  it("does not render source excerpts outside the selected root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "kernel-keeper-glass-"));
    const surface = join(tmp, "surface");
    mkdirSync(surface);
    writeFileSync(join(tmp, "secret.txt"), "do not show this");
    const scan: GlassScanResult = {
      source: { root: surface, kind: "estate", register: "estate" },
      scannedAt: "2026-07-20T10:00:00.000Z",
      stats: { items: 1, findingsBySeverity: { HIGH: 1, MED: 0, LOW: 0 } },
      findings: [{
        id: "F-path-traversal",
        check: "source-excerpt",
        severity: "HIGH",
        title: "Path traversal probe",
        summary: "Probe",
        whyItMatters: "The console should only show evidence from the selected surface.",
        recommendedAction: "Keep source excerpts root-bound.",
        file: "../secret.txt",
        technical: { message: "Attempted parent path." },
      }],
    };

    const html = renderGlassDashboard(scan);

    expect(html).not.toContain("do not show this");
    expect(html).toContain("No local source excerpt is available");
  });

  it("renders proposal inbox detail and human decision controls", () => {
    const source: GlassSource = { root: NORTHWIND, kind: "bundle", memory: true };
    const card: GlassProposalCard = {
      id: "P-glass",
      file: "/tmp/P-glass.md",
      state: "needs-review",
      kind: "amend",
      target: "bundle/facts/target.md",
      title: "Amend target.md",
      summary: "Update body content.",
      checks: ["semantic-drift"],
      evidence: ["bundle/facts/source.md"],
      needsHuman: true,
      elected: false,
      generatedAt: "2026-07-20T10:00:00.000Z",
    };
    const detail: GlassProposalDetail = {
      ...card,
      provenance: {
        promptSha256: "a".repeat(64),
        reviewedSurfaceSha256: "b".repeat(64),
        reviewedSurfaceFiles: [{ path: "bundle/facts/target.md", sha256: "c".repeat(64) }],
      },
      draft: {
        frontmatterPatch: null,
        bodyDraft: "# Target\n\nUpdated claim.\n",
        indexEntry: null,
        journalLine: "- **YYYY-MM-DD** - update target [proposal: P-glass] [decision: elected] [by: <judge>]",
      },
    };

    const html = renderProposalInbox(source, "/tmp/proposals", [card], detail);

    expect(html).toContain("Proposal Inbox");
    expect(html).toContain("Approve");
    expect(html).toContain("Request Edit");
    expect(html).toContain("Reject");
    expect(html).toContain("Provenance");
    expect(html).toContain("bundle/facts/source.md");
    expect(html).toContain("# Target");
  });

  it("renders apply preview, explicit write control, and audit history", () => {
    const source: GlassSource = { root: NORTHWIND, kind: "estate", register: "commands" };
    const preview: GlassApplyPreview = {
      source,
      canWrite: true,
      skipped: [],
      refused: [],
      planned: [{
        proposal: {
          id: "P-apply",
          file: "/tmp/P-apply.md",
          state: "approved",
          kind: "new-procedure",
          target: "commands/smoke.md",
          title: "New procedure: smoke.md",
          summary: "Promote repeated lesson.",
          checks: ["semantic-drift"],
          evidence: ["commands/source.md"],
          needsHuman: true,
          elected: true,
          generatedAt: "2026-07-20T10:00:00.000Z",
        },
        changes: [{
          file: "commands/smoke.md",
          newFile: true,
          summary: "Create commands/smoke.md",
          diff: "--- before\n+++ after\n@@\n+# Smoke\n",
        }],
      }],
    };
    const audit: GlassAuditTrail = {
      source,
      path: "/tmp/audit.md",
      entries: [{
        date: "2026-07-20",
        proposal: "P-apply",
        target: "commands/smoke.md",
        summary: "applied proposal P-apply",
        raw: "- **2026-07-20** - applied proposal P-apply",
      }],
    };

    const html = renderApplyPage(source, "/tmp/proposals", preview, audit, { proposalId: "P-apply" });

    expect(html).toContain("Apply Preview");
    expect(html).toContain("Safety Checks");
    expect(html).toContain("Apply Approved");
    expect(html).toContain("Create commands/smoke.md");
    expect(html).toContain("# Smoke");
    expect(html).toContain("Audit History");
    expect(html).toContain("applied proposal P-apply");
  });

  it("does not render apply control when preview cannot write", () => {
    const source: GlassSource = { root: NORTHWIND, kind: "estate", register: "commands" };
    const preview: GlassApplyPreview = {
      source,
      canWrite: false,
      planned: [],
      refused: [],
      skipped: [{ proposal: "P-apply", summary: "This approved change has already been applied.", technicalReason: "already applied" }],
    };

    const html = renderApplyPage(source, "/tmp/proposals", preview, null, { proposalId: "P-apply" });

    expect(html).toContain("already been applied");
    expect(html).not.toContain("Apply Approved</button>");
  });

  it("creates a server without opening a port during unit tests", () => {
    const server = createGlassServer({
      root: join(NORTHWIND, "estate"),
      register: "estate",
    });
    expect(server.listening).toBe(false);
  });
});
