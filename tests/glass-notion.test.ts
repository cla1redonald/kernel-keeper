import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProposalMarkdown } from "../src/apply/proposals.js";
import { writeApply } from "../src/apply/proposals.js";
import { renderProposalMarkdown } from "../src/ai/proposal.js";
import { hashReviewedSurface, sha256Hex } from "../src/ai/provenance.js";
import { NotionClient } from "../src/glass/notion/client.js";
import { NotionServiceUnavailableError, NotionUsageError } from "../src/glass/notion/errors.js";
import { renderNotionProposal, renderNotionProposals } from "../src/glass/notion/render.js";
import { validateNotionDatabaseContract } from "../src/glass/notion/schema.js";
import { publishNotionProposals, syncNotionAudit, syncNotionDecisions, writeNotionSyncState } from "../src/glass/notion/sync.js";
import { proposalToDetail } from "../src/glass/view-models.js";
import type { GlassSource } from "../src/glass/types.js";
import type { NotionFetch, NotionHttpResponse, NotionPageRef } from "../src/glass/notion/client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NORTHWIND = join(ROOT, "tests", "fixtures", "northwind-memory-lab");
const PROPOSAL = join(NORTHWIND, "proposals", "P-northwind-promote-command.md");
const NOW = new Date("2026-07-21T12:00:00.000Z");

function proposalDetail() {
  return proposalToDetail(parseProposalMarkdown(readFileSync(PROPOSAL, "utf8"), PROPOSAL));
}

const SOURCE: GlassSource = {
  root: join(NORTHWIND, "estate"),
  kind: "estate",
  register: "commands",
};

describe("Notion approval-surface rendering", () => {
  it("renders deterministic proposal properties and page blocks", () => {
    const rendered = renderNotionProposal({ source: SOURCE, proposal: proposalDetail(), renderedAt: NOW });

    expect(rendered.proposalId).toBe("P-northwind-promote-command");
    expect(rendered.properties["Proposal ID"]).toEqual({ type: "title", value: "P-northwind-promote-command" });
    expect(rendered.properties.Status).toEqual({ type: "select", value: "Needs review" });
    expect(rendered.properties.Decision).toEqual({ type: "select", value: null });
    expect(rendered.properties.Checks).toEqual({ type: "multi_select", value: ["procedure-gap"] });
    expect(rendered.properties.Target).toEqual({ type: "rich_text", value: "customer-reconnection-insight.md" });
    expect(rendered.properties["Evidence Count"]).toEqual({ type: "number", value: 1 });
    expect(rendered.properties["Reviewed Hash"]).toEqual({
      type: "rich_text",
      value: "ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c",
    });
    expect(rendered.properties["Last Synced"]).toEqual({ type: "date", value: "2026-07-21T12:00:00.000Z" });
    expect(rendered.page.blocks.map((b) => b.text)).toContain("Evidence");
    expect(rendered.page.blocks.map((b) => b.text)).toContain("Provenance");
    expect(rendered.page.blocks.map((b) => b.text)).toContain("Human reviewer: make your decision by setting the Decision property at the top of this Notion page.");
    expect(rendered.page.blocks.map((b) => b.text)).toContain("Choose Approved when the draft is safe to elect.");
    expect(rendered.page.blocks.map((b) => b.text)).toContain("Leave Decision blank if the proposal is still being reviewed.");
    expect(rendered.sync).toEqual({
      proposalId: "P-northwind-promote-command",
      proposalFile: PROPOSAL,
      sourceRoot: SOURCE.root,
      reviewedSurfaceSha256: "ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c",
      renderedAt: "2026-07-21T12:00:00.000Z",
    });
  });

  it("is pure for the same proposal and timestamp", () => {
    const proposal = proposalDetail();
    expect(renderNotionProposal({ source: SOURCE, proposal, renderedAt: NOW })).toEqual(renderNotionProposal({ source: SOURCE, proposal, renderedAt: NOW }));
  });

  it("maps approved proposals to an approved Notion decision without mutating markdown", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-notion-"));
    const props = join(root, "props");
    mkdirSync(props);
    const path = join(props, "P-northwind-promote-command.md");
    const original = readFileSync(PROPOSAL, "utf8");
    writeFileSync(path, original.replace("elected: false", "elected: true").replace("- [ ] Elect", "- [x] Elect"));

    const parsed = proposalToDetail(parseProposalMarkdown(readFileSync(path, "utf8"), path));
    const rendered = renderNotionProposal({ source: SOURCE, proposal: parsed, renderedAt: NOW });

    expect(rendered.properties.Status).toEqual({ type: "select", value: "Approved" });
    expect(rendered.properties.Decision).toEqual({ type: "select", value: "Approved" });
    expect(readFileSync(path, "utf8")).toContain("elected: true");
  });

  it("renders a list of proposals in stable input order", () => {
    const proposal = proposalDetail();
    const rendered = renderNotionProposals(SOURCE, [proposal], NOW);
    expect(rendered.map((p) => p.proposalId)).toEqual(["P-northwind-promote-command"]);
  });
});

function validDatabase() {
  return {
    properties: {
      "Proposal ID": { type: "title" },
      Status: { type: "select" },
      Decision: { type: "select" },
      Owner: { type: "rich_text" },
      Severity: { type: "select" },
      Checks: { type: "multi_select" },
      Source: { type: "rich_text" },
      Target: { type: "rich_text" },
      "Evidence Count": { type: "number" },
      "Reviewed Hash": { type: "rich_text" },
      "Last Synced": { type: "date" },
      "Applied At": { type: "date" },
    },
  };
}

function fixtureRoot(): { root: string; props: string } {
  const root = mkdtempSync(join(tmpdir(), "kk-notion-publish-"));
  const props = join(root, "props");
  mkdirSync(props);
  writeFileSync(join(props, "P-northwind-promote-command.md"), readFileSync(PROPOSAL, "utf8"));
  return { root, props };
}

class MockNotionClient {
  database = validDatabase();
  matches = new Map<string, NotionPageRef[]>();
  created: { databaseId: string; properties: Record<string, unknown>; children: Record<string, unknown>[] }[] = [];
  updated: { pageId: string; properties: Record<string, unknown> }[] = [];
  appended: { pageId: string; children: Record<string, unknown>[] }[] = [];
  pages = new Map<string, Record<string, unknown>>();

  async retrieveDataSource() {
    return this.database;
  }

  async queryByProposalId(_databaseId: string, _proposalIdPropertyType: "title" | "rich_text", proposalId: string) {
    return this.matches.get(proposalId) ?? [];
  }

  async createPage(databaseId: string, properties: Record<string, unknown>, children: Record<string, unknown>[]) {
    this.created.push({ databaseId, properties, children });
    return { id: `page-${this.created.length}` };
  }

  async updatePage(pageId: string, properties: Record<string, unknown>) {
    this.updated.push({ pageId, properties });
  }

  async retrievePage(pageId: string) {
    return this.pages.get(pageId) ?? notionPage("Needs review", "Needs review");
  }

  async appendBlockChildren(pageId: string, children: Record<string, unknown>[]) {
    this.appended.push({ pageId, children });
  }
}

function notionPage(decision: string | null, status: string | null, reviewedHash = "ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c") {
  return {
    properties: {
      Decision: { type: "select", select: decision ? { name: decision } : null },
      Status: { type: "select", select: status ? { name: status } : null },
      Owner: { type: "rich_text", rich_text: [{ plain_text: "Claire" }] },
      "Reviewed Hash": { type: "rich_text", rich_text: [{ plain_text: reviewedHash }] },
    },
  };
}

function writeSyncState(root: string, props: string, pageId = "page-1") {
  writeNotionSyncState(root, {
    version: 1,
    pages: {
      "P-northwind-promote-command": {
        proposalId: "P-northwind-promote-command",
        proposalFile: join(props, "P-northwind-promote-command.md"),
        databaseId: "db-1",
        pageId,
        sourceRoot: root,
        reviewedSurfaceSha256: "ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c",
        lastSynced: NOW.toISOString(),
      },
    },
  });
}

function commandApplyFixture(): { commandsRoot: string; props: string } {
  const root = mkdtempSync(join(tmpdir(), "kk-notion-audit-"));
  const commandsRoot = join(root, "estate", "commands");
  const props = join(root, "props");
  mkdirSync(commandsRoot, { recursive: true });
  mkdirSync(props);
  const target = "---\ndescription: Existing command\nowner: Ops\n---\n# Existing\n";
  writeFileSync(join(commandsRoot, "target.md"), target);
  const reviewed = hashReviewedSurface([{ path: "target.md", content: target }]);
  const content = renderProposalMarkdown({
    id: "P-northwind-promote-command",
    kind: "new-procedure",
    target: "insight-promotion.md",
    summary: "Promote insight workflow",
    rationale: "Repeated lessons should become governed commands.",
    frontmatterPatch: null,
    bodyDraft: "---\ndescription: Run the customer insight promotion workflow.\nowner: Ops\n---\n# Insight Promotion\n",
    journalLine: "- **2026-07-21** - promoted insight command [proposal: P-northwind-promote-command] [decision: elected] [by: Claire]",
    indexEntry: null,
    confidence: "high",
    evidenceQuotes: [{ file: "target.md", quote: "Existing command" }],
    needsHuman: true,
  }, {
    agent: "procedure-promoter",
    model: "manual-fixture",
    promptSha256: sha256Hex("notion audit fixture"),
    evidenceFiles: ["target.md"],
    reviewedSurfaceSha256: reviewed.sha256,
    reviewedSurfaceFiles: reviewed.files,
    generatedAt: NOW.toISOString(),
    usage: { inputTokens: 0, outputTokens: 0 },
  }).replace("elected: false", "elected: true").replace("- [ ] Elect", "- [x] Elect");
  writeFileSync(join(props, "P-northwind-promote-command.md"), content);
  writeSyncState(commandsRoot, props);
  return { commandsRoot, props };
}

describe("Notion approval-surface publish", () => {
  it("validates required database properties", () => {
    expect(validateNotionDatabaseContract(validDatabase())["Proposal ID"]).toBe("title");
    expect(() => validateNotionDatabaseContract({ properties: { ...validDatabase().properties, Status: { type: "checkbox" } } })).toThrow(NotionUsageError);
    const missing = validDatabase();
    delete (missing.properties as Record<string, unknown>).Checks;
    expect(() => validateNotionDatabaseContract(missing)).toThrow("notion database missing required property: Checks");
  });

  it("creates new Notion proposal pages and writes local sync state", async () => {
    const { root, props } = fixtureRoot();
    const client = new MockNotionClient();
    const result = await publishNotionProposals({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.dryRun).toBe(false);
    expect(result.published).toEqual([
      {
        proposalId: "P-northwind-promote-command",
        proposalFile: join(props, "P-northwind-promote-command.md"),
        pageId: "page-1",
        action: "created",
        reviewedSurfaceSha256: "ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c",
      },
    ]);
    expect(client.created[0]?.properties["Proposal ID"]).toEqual({ title: [{ type: "text", text: { content: "P-northwind-promote-command" } }] });
    expect(client.created[0]?.children.length).toBeGreaterThan(5);
    expect(JSON.stringify(client.created[0]?.children)).toContain("Human reviewer: make your decision");
    const statePath = join(root, ".kernel-keeper", "notion-sync.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.pages["P-northwind-promote-command"].pageId).toBe("page-1");
    expect(state.pages["P-northwind-promote-command"].guidanceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(state)).not.toContain("secret_");
  });

  it("updates the same remote page when a proposal row already exists", async () => {
    const { root, props } = fixtureRoot();
    const client = new MockNotionClient();
    client.matches.set("P-northwind-promote-command", [{ id: "page-existing" }]);

    const result = await publishNotionProposals({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.published[0]?.action).toBe("updated");
    expect(result.published[0]?.pageId).toBe("page-existing");
    expect(client.created).toEqual([]);
    expect(client.updated[0]?.pageId).toBe("page-existing");
    expect(client.appended[0]?.pageId).toBe("page-existing");
    expect(JSON.stringify(client.appended[0]?.children)).toContain("Updated Decision Guidance");
  });

  it("does not append duplicate guidance when the synced guidance hash already matches", async () => {
    const { root, props } = fixtureRoot();
    const client = new MockNotionClient();
    client.matches.set("P-northwind-promote-command", [{ id: "page-existing" }]);
    await publishNotionProposals({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    const second = await publishNotionProposals({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(second.published[0]?.action).toBe("updated");
    expect(client.appended).toHaveLength(1);
  });

  it("refuses duplicate remote rows for the same proposal ID", async () => {
    const { root, props } = fixtureRoot();
    const client = new MockNotionClient();
    client.matches.set("P-northwind-promote-command", [{ id: "page-1" }, { id: "page-2" }]);

    const result = await publishNotionProposals({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.published).toEqual([]);
    expect(result.refused[0]?.technicalReason).toContain("duplicate Notion rows");
  });

  it("bubbles API outages instead of recording them as proposal refusals", async () => {
    const { root, props } = fixtureRoot();
    const client = new MockNotionClient();
    client.createPage = async () => {
      throw new NotionServiceUnavailableError("notion API unavailable");
    };

    await expect(
      publishNotionProposals({
        root,
        proposalsDir: props,
        source: { ...SOURCE, root },
        databaseId: "db-1",
        client,
        now: NOW,
      }),
    ).rejects.toThrow(NotionServiceUnavailableError);
  });
});

describe("Notion client boundary", () => {
  it("requires a token for live sync", () => {
    expect(() => new NotionClient({ token: "" })).toThrow(NotionUsageError);
  });

  it("redacts secrets from network errors", async () => {
    const fetchImpl: NotionFetch = async () => {
      throw new Error("failed for secret_abc123");
    };
    const client = new NotionClient({ token: "secret_real", fetchImpl });

    await expect(client.retrieveDataSource("db")).rejects.toThrow(NotionServiceUnavailableError);
    await expect(client.retrieveDataSource("db")).rejects.not.toThrow("secret_abc123");
  });

  it("sends the current Notion API version and bearer auth", async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = [];
    const fetchImpl: NotionFetch = async (url, init): Promise<NotionHttpResponse> => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return validDatabase();
        },
        async text() {
          return "";
        },
      };
    };
    const client = new NotionClient({ token: "secret_real", fetchImpl });
    await client.retrieveDataSource("db");

    expect(calls[0]?.url).toContain("/v1/data_sources/db");
    expect(calls[0]?.init.headers.Authorization).toBe("Bearer secret_real");
    expect(calls[0]?.init.headers["Notion-Version"]).toBe("2026-03-11");
  });
});

describe("Notion decision sync", () => {
  it("syncs an approved Notion decision into a Clerk-compatible election marker", async () => {
    const { root, props } = fixtureRoot();
    writeSyncState(root, props);
    const client = new MockNotionClient();
    client.pages.set("page-1", notionPage("Approved", "Needs review"));

    const result = await syncNotionDecisions({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.synced).toEqual([{ proposalId: "P-northwind-promote-command", pageId: "page-1", decision: "approve" }]);
    const content = readFileSync(join(props, "P-northwind-promote-command.md"), "utf8");
    expect(content).toContain("status: elected");
    expect(content).toContain("elected: true");
    expect(content).toContain("[decision: elected]");
    expect(content).toContain("[by: Claire]");
  });

  it("syncs rejected Notion decisions without making proposals apply-eligible", async () => {
    const { root, props } = fixtureRoot();
    writeSyncState(root, props);
    const client = new MockNotionClient();
    client.pages.set("page-1", notionPage("Rejected", "Needs review"));

    await syncNotionDecisions({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    const content = readFileSync(join(props, "P-northwind-promote-command.md"), "utf8");
    expect(content).toContain("status: rejected");
    expect(content).toContain("elected: false");
    expect(content).toContain("[decision: rejected]");
  });

  it("syncs request-edit Notion decisions as amended proposal history", async () => {
    const { root, props } = fixtureRoot();
    writeSyncState(root, props);
    const client = new MockNotionClient();
    client.pages.set("page-1", notionPage("Request edit", "Needs review"));

    const result = await syncNotionDecisions({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.synced[0]?.decision).toBe("request-edit");
    const content = readFileSync(join(props, "P-northwind-promote-command.md"), "utf8");
    expect(content).toContain("status: amended");
    expect(content).toContain("[decision: amended]");
    expect(content).toContain("synced from Notion page page-1");
  });

  it("refuses stale Notion decisions when reviewed hashes no longer match", async () => {
    const { root, props } = fixtureRoot();
    writeSyncState(root, props);
    const client = new MockNotionClient();
    client.pages.set("page-1", notionPage("Approved", "Needs review", "stale"));

    const result = await syncNotionDecisions({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.synced).toEqual([]);
    expect(result.refused[0]?.technicalReason).toContain("reviewed hash no longer matches");
    expect(readFileSync(join(props, "P-northwind-promote-command.md"), "utf8")).toContain("elected: false");
  });

  it("refuses missing local proposals instead of recreating them from Notion", async () => {
    const root = mkdtempSync(join(tmpdir(), "kk-notion-missing-"));
    const props = join(root, "props");
    mkdirSync(props);
    writeSyncState(root, props);
    const client = new MockNotionClient();
    client.pages.set("page-1", notionPage("Approved", "Needs review"));

    const result = await syncNotionDecisions({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.refused[0]?.technicalReason).toContain("local proposal file is missing");
  });
});

describe("Notion audit sync", () => {
  it("marks already-applied proposals as Applied and appends one audit block", async () => {
    const { commandsRoot, props } = commandApplyFixture();
    const apply = writeApply(commandsRoot, { proposalsDir: props, register: "commands" });
    expect(apply.plan.refused).toEqual([]);

    const client = new MockNotionClient();
    const result = await syncNotionAudit({
      root: commandsRoot,
      proposalsDir: props,
      source: { root: commandsRoot, kind: "estate", register: "commands" },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.synced[0]?.status).toBe("Applied");
    expect(result.synced[0]?.summary).toContain("applied proposal P-northwind-promote-command");
    expect(client.updated[0]?.properties.Status).toEqual({ select: { name: "Applied" } });
    expect(client.appended[0]?.children[0]).toMatchObject({ type: "heading_3" });

    const second = await syncNotionAudit({
      root: commandsRoot,
      proposalsDir: props,
      source: { root: commandsRoot, kind: "estate", register: "commands" },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(second.synced[0]?.status).toBe("Applied");
    expect(client.appended).toHaveLength(1);
  });

  it("marks Clerk-refused proposals as Refused", async () => {
    const { commandsRoot, props } = commandApplyFixture();
    writeFileSync(join(commandsRoot, "target.md"), "---\ndescription: Changed\n---\n# Changed\n");
    const client = new MockNotionClient();

    const result = await syncNotionAudit({
      root: commandsRoot,
      proposalsDir: props,
      source: { root: commandsRoot, kind: "estate", register: "commands" },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.synced[0]?.status).toBe("Refused");
    expect(result.synced[0]?.summary).toContain("reviewed surface");
    expect(client.updated[0]?.properties.Status).toEqual({ select: { name: "Refused" } });
  });

  it("skips pending proposals without updating Notion", async () => {
    const { root, props } = fixtureRoot();
    writeSyncState(root, props);
    const client = new MockNotionClient();

    const result = await syncNotionAudit({
      root,
      proposalsDir: props,
      source: { ...SOURCE, root },
      databaseId: "db-1",
      client,
      now: NOW,
    });

    expect(result.synced).toEqual([]);
    expect(result.skipped[0]).toEqual({ proposal: "P-northwind-promote-command", reason: "not elected" });
    expect(client.updated).toEqual([]);
  });
});
