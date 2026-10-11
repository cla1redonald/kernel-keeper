import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sha256Hex } from "../../ai/provenance.js";
import { parseProposalMarkdown, planApply } from "../../apply/proposals.js";
import { writeProposalDecision } from "../decisions.js";
import { getAuditTrail } from "../service.js";
import { proposalToDetail, refusalToGlass } from "../view-models.js";
import { notionDecisionGuidanceBlocks, renderNotionProposals } from "./render.js";
import { NotionConflictError } from "./errors.js";
import { validateNotionDatabaseContract } from "./schema.js";
import type { ParsedProposal } from "../../apply/proposals.js";
import type { GlassSource } from "../types.js";
import type { NotionClient, NotionPageRef } from "./client.js";
import type { NotionExportBlock, NotionExportProperty, NotionProposalExport, NotionSyncExport } from "./types.js";
import type { NotionPropertyType, ValidatedNotionSchema } from "./schema.js";

export interface NotionPublishOptions {
  root: string;
  proposalsDir: string;
  source: GlassSource;
  databaseId: string;
  client: Pick<NotionClient, "retrieveDataSource" | "queryByProposalId" | "createPage" | "updatePage" | "appendBlockChildren">;
  now?: Date;
}

export interface NotionDecisionSyncOptions {
  root: string;
  proposalsDir: string;
  source: GlassSource;
  databaseId: string;
  client: Pick<NotionClient, "retrievePage">;
  now?: Date;
}

export interface NotionAuditSyncOptions {
  root: string;
  proposalsDir: string;
  source: GlassSource;
  databaseId: string;
  client: Pick<NotionClient, "retrieveDataSource" | "updatePage" | "appendBlockChildren">;
  now?: Date;
}

export interface NotionPublishedProposal {
  proposalId: string;
  proposalFile: string;
  pageId: string;
  action: "created" | "updated";
  reviewedSurfaceSha256: string | null;
}

export interface NotionPublishResult extends NotionSyncExport {
  dryRun: false;
  databaseId: string;
  published: NotionPublishedProposal[];
}

export interface NotionSyncStateEntry {
  proposalId: string;
  proposalFile: string;
  databaseId: string;
  pageId: string;
  sourceRoot: string;
  reviewedSurfaceSha256: string | null;
  lastSynced: string;
  guidanceSha256?: string;
  lastAuditStatus?: "Applied" | "Refused";
  lastAuditSummary?: string;
  lastAuditSynced?: string;
}

export interface NotionSyncState {
  version: 1;
  pages: Record<string, NotionSyncStateEntry>;
}

export interface NotionDecisionSyncResult {
  source: GlassSource;
  databaseId: string;
  syncedAt: string;
  synced: { proposalId: string; pageId: string; decision: "approve" | "reject" | "request-edit" }[];
  skipped: { proposal: string; reason: string }[];
  refused: { proposal: string; summary: string; technicalReason: string }[];
}

export interface NotionAuditSyncResult {
  source: GlassSource;
  databaseId: string;
  syncedAt: string;
  synced: { proposalId: string; pageId: string; status: "Applied" | "Refused"; summary: string }[];
  skipped: { proposal: string; reason: string }[];
  refused: { proposal: string; summary: string; technicalReason: string }[];
}

function loadProposalInputs(dir: string): { proposals: ParsedProposal[]; refused: { proposal: string; reason: string }[] } {
  const proposals: ParsedProposal[] = [];
  const refused: { proposal: string; reason: string }[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const path = join(dir, f);
    try {
      proposals.push(parseProposalMarkdown(readFileSync(path, "utf8"), path));
    } catch (err) {
      refused.push({ proposal: f.replace(/\.md$/, ""), reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { proposals, refused };
}

function syncStatePath(root: string): string {
  return join(resolve(root), ".kernel-keeper", "notion-sync.json");
}

export function readNotionSyncState(root: string): NotionSyncState {
  const path = syncStatePath(root);
  if (!existsSync(path)) return { version: 1, pages: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<NotionSyncState>;
  return { version: 1, pages: parsed.pages ?? {} };
}

export function writeNotionSyncState(root: string, state: NotionSyncState): void {
  const path = syncStatePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function richText(content: string | null | undefined): { type: "text"; text: { content: string } }[] {
  if (!content) return [];
  const out: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < content.length; i += 1900) out.push({ type: "text", text: { content: content.slice(i, i + 1900) } });
  return out;
}

function propertyValue(prop: NotionExportProperty, actualType: NotionPropertyType): Record<string, unknown> {
  if (actualType === "title") return { title: richText(String(prop.value ?? "")) };
  if (actualType === "rich_text") return { rich_text: richText(prop.value === null ? null : String(prop.value)) };
  if (actualType === "select") return { select: typeof prop.value === "string" && prop.value ? { name: prop.value } : null };
  if (actualType === "status") return { status: typeof prop.value === "string" && prop.value ? { name: prop.value } : null };
  if (actualType === "multi_select") return { multi_select: prop.type === "multi_select" ? prop.value.map((name) => ({ name })) : [] };
  if (actualType === "number") return { number: typeof prop.value === "number" ? prop.value : null };
  if (actualType === "date") return { date: typeof prop.value === "string" && prop.value ? { start: prop.value } : null };
  if (actualType === "people") return { people: [] };
  return {};
}

export function notionPropertiesForApi(proposal: NotionProposalExport, schema: ValidatedNotionSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, actualType] of Object.entries(schema)) {
    const prop = proposal.properties[name];
    if (prop) out[name] = propertyValue(prop, actualType);
  }
  return out;
}

export function notionBlocksForApi(blocks: NotionExportBlock[]): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (block.type === "code") {
      return {
        object: "block",
        type: "code",
        code: { rich_text: richText(block.text), language: block.language ?? "plain text" },
      };
    }
    return {
      object: "block",
      type: block.type,
      [block.type]: { rich_text: richText(block.text) },
    };
  });
}

function proposalIdPropertyType(schema: ValidatedNotionSchema): "title" | "rich_text" {
  const type = schema["Proposal ID"];
  return type === "rich_text" ? "rich_text" : "title";
}

function guidanceSha256(): string {
  return sha256Hex(notionDecisionGuidanceBlocks().map((block) => `${block.type}\0${block.text}`).join("\n"));
}

async function publishOne(
  rendered: NotionProposalExport,
  opts: NotionPublishOptions,
  schema: ValidatedNotionSchema,
  priorState: NotionSyncState,
): Promise<NotionPublishedProposal> {
  const matches = await opts.client.queryByProposalId(opts.databaseId, proposalIdPropertyType(schema), rendered.proposalId);
  if (matches.length > 1) throw new NotionConflictError(`duplicate Notion rows for proposal ${rendered.proposalId}`);
  const properties = notionPropertiesForApi(rendered, schema);
  let page: NotionPageRef;
  let action: "created" | "updated";
  if (matches.length === 0) {
    page = await opts.client.createPage(opts.databaseId, properties, notionBlocksForApi(rendered.page.blocks));
    action = "created";
  } else {
    page = matches[0]!;
    await opts.client.updatePage(page.id, properties);
    const expectedGuidanceSha = guidanceSha256();
    if (priorState.pages[rendered.proposalId]?.guidanceSha256 !== expectedGuidanceSha) {
      await opts.client.appendBlockChildren(page.id, notionBlocksForApi([{ type: "heading_3", text: "Updated Decision Guidance" }, ...notionDecisionGuidanceBlocks()]));
    }
    action = "updated";
  }
  return {
    proposalId: rendered.proposalId,
    proposalFile: rendered.proposalFile,
    pageId: page.id,
    action,
    reviewedSurfaceSha256: rendered.sync.reviewedSurfaceSha256,
  };
}

export async function publishNotionProposals(opts: NotionPublishOptions): Promise<NotionPublishResult> {
  const now = opts.now ?? new Date();
  const loaded = loadProposalInputs(opts.proposalsDir);
  const proposals = loaded.proposals.map(proposalToDetail);
  const rendered = renderNotionProposals(opts.source, proposals, now);
  const schema = validateNotionDatabaseContract(await opts.client.retrieveDataSource(opts.databaseId));
  const published: NotionPublishedProposal[] = [];
  const refused = loaded.refused.map(refusalToGlass);
  const state = readNotionSyncState(opts.root);
  const guidanceSha = guidanceSha256();

  for (const proposal of rendered) {
    try {
      published.push(await publishOne(proposal, opts, schema, state));
    } catch (err) {
      if (err instanceof NotionConflictError) {
        refused.push(refusalToGlass({ proposal: proposal.proposalId, reason: err.message }));
      } else {
        throw err;
      }
    }
  }

  for (const p of published) {
    state.pages[p.proposalId] = {
      proposalId: p.proposalId,
      proposalFile: p.proposalFile,
      databaseId: opts.databaseId,
      pageId: p.pageId,
      sourceRoot: opts.source.root,
      reviewedSurfaceSha256: p.reviewedSurfaceSha256,
      lastSynced: now.toISOString(),
      guidanceSha256: guidanceSha,
    };
  }
  if (published.length > 0) writeNotionSyncState(opts.root, state);

  return {
    source: opts.source,
    dryRun: false,
    renderedAt: now.toISOString(),
    databaseId: opts.databaseId,
    proposals: rendered,
    refused,
    published,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function richTextPlain(value: unknown): string | null {
  const items = Array.isArray(value) ? value : [];
  const text = items
    .map((item) => object(item).plain_text)
    .filter((item): item is string => typeof item === "string")
    .join("");
  return text.trim() || null;
}

function pageProperty(page: Record<string, unknown>, name: string): Record<string, unknown> {
  return object(object(page.properties)[name]);
}

function selectName(prop: Record<string, unknown>): string | null {
  const type = prop.type;
  if (type === "select") {
    const name = object(prop.select).name;
    return typeof name === "string" ? name : null;
  }
  if (type === "status") {
    const name = object(prop.status).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function textProperty(prop: Record<string, unknown>): string | null {
  if (prop.type === "rich_text") return richTextPlain(prop.rich_text);
  if (prop.type === "title") return richTextPlain(prop.title);
  if (prop.type === "people") {
    const people = Array.isArray(prop.people) ? prop.people : [];
    const names = people
      .map((person) => object(person).name)
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    return names.join(", ") || null;
  }
  return null;
}

function notionDecision(page: Record<string, unknown>): "approve" | "reject" | "request-edit" | null {
  const decision = selectName(pageProperty(page, "Decision")) ?? selectName(pageProperty(page, "Status"));
  if (decision === "Approved") return "approve";
  if (decision === "Rejected") return "reject";
  if (decision === "Request edit") return "request-edit";
  return null;
}

function notionReviewedHash(page: Record<string, unknown>): string | null {
  return textProperty(pageProperty(page, "Reviewed Hash"));
}

function notionReviewer(page: Record<string, unknown>): string {
  return textProperty(pageProperty(page, "Owner")) ?? "Notion reviewer";
}

export async function syncNotionDecisions(opts: NotionDecisionSyncOptions): Promise<NotionDecisionSyncResult> {
  const now = opts.now ?? new Date();
  const state = readNotionSyncState(opts.root);
  const synced: NotionDecisionSyncResult["synced"] = [];
  const skipped: NotionDecisionSyncResult["skipped"] = [];
  const refused: NotionDecisionSyncResult["refused"] = [];

  for (const entry of Object.values(state.pages).sort((a, b) => a.proposalId.localeCompare(b.proposalId))) {
    if (entry.databaseId !== opts.databaseId) continue;
    const localPath = join(resolve(opts.proposalsDir), `${entry.proposalId}.md`);
    if (!existsSync(localPath)) {
      refused.push(refusalToGlass({ proposal: entry.proposalId, reason: "local proposal file is missing; Notion cannot recreate canonical proposals" }));
      continue;
    }
    const page = await opts.client.retrievePage(entry.pageId);
    const decision = notionDecision(page);
    if (!decision) {
      skipped.push({ proposal: entry.proposalId, reason: "no Notion decision recorded" });
      continue;
    }
    const parsed = parseProposalMarkdown(readFileSync(localPath, "utf8"), localPath);
    const pageHash = notionReviewedHash(page);
    if (!pageHash || pageHash !== parsed.reviewedSurfaceSha256) {
      refused.push(refusalToGlass({ proposal: entry.proposalId, reason: "Notion decision is stale; reviewed hash no longer matches the canonical proposal" }));
      continue;
    }
    writeProposalDecision(opts.proposalsDir, entry.proposalId, decision, {
      by: notionReviewer(page),
      note: `synced from Notion page ${entry.pageId}`,
      now,
    });
    synced.push({ proposalId: entry.proposalId, pageId: entry.pageId, decision });
  }

  return {
    source: opts.source,
    databaseId: opts.databaseId,
    syncedAt: now.toISOString(),
    synced,
    skipped,
    refused,
  };
}

function statusProperties(status: "Applied" | "Refused", appliedAt: string | null, schema: ValidatedNotionSchema): Record<string, unknown> {
  const statusType = schema.Status;
  const appliedAtType = schema["Applied At"];
  if (!statusType || !appliedAtType) throw new NotionConflictError("validated Notion schema is missing audit status properties");
  const properties = {
    Status: { type: "select" as const, value: status },
    "Applied At": { type: "date" as const, value: appliedAt },
  };
  return {
    Status: propertyValue(properties.Status, statusType),
    "Applied At": propertyValue(properties["Applied At"], appliedAtType),
  };
}

function auditSummaryFor(root: string, source: GlassSource, proposalId: string): { date: string | null; summary: string } | null {
  const entries = getAuditTrail(root, { ...(source.register ? { register: source.register } : {}), ...(source.memory !== undefined ? { memory: source.memory } : {}) }).entries;
  const match = entries.slice().reverse().find((entry) => entry.proposal === proposalId);
  return match ? { date: match.date, summary: match.summary || match.raw } : null;
}

function auditBlocks(status: "Applied" | "Refused", summary: string): Record<string, unknown>[] {
  return notionBlocksForApi([
    { type: "heading_3", text: "Kernel Keeper Audit" },
    { type: "paragraph", text: `${status}: ${summary}` },
  ]);
}

export async function syncNotionAudit(opts: NotionAuditSyncOptions): Promise<NotionAuditSyncResult> {
  const now = opts.now ?? new Date();
  const schema = validateNotionDatabaseContract(await opts.client.retrieveDataSource(opts.databaseId));
  const state = readNotionSyncState(opts.root);
  const synced: NotionAuditSyncResult["synced"] = [];
  const skipped: NotionAuditSyncResult["skipped"] = [];
  const refused: NotionAuditSyncResult["refused"] = [];

  for (const entry of Object.values(state.pages).sort((a, b) => a.proposalId.localeCompare(b.proposalId))) {
    if (entry.databaseId !== opts.databaseId) continue;
    const plan = planApply(opts.root, {
      proposalsDir: opts.proposalsDir,
      proposalId: entry.proposalId,
      ...(opts.source.register ? { register: opts.source.register } : {}),
    });
    const skippedAlreadyApplied = plan.skipped.find((s) => s.proposal === entry.proposalId && s.reason === "already applied");
    const hardRefusal = plan.refused.find((r) => r.proposal === entry.proposalId || r.proposal === "(write)");
    const notElected = plan.skipped.find((s) => s.proposal === entry.proposalId && s.reason === "not elected");

    let status: "Applied" | "Refused" | null = null;
    let summary: string | null = null;
    let appliedAt: string | null = null;
    if (skippedAlreadyApplied) {
      const audit = auditSummaryFor(opts.root, opts.source, entry.proposalId);
      status = "Applied";
      summary = audit?.summary ?? `applied proposal ${entry.proposalId}`;
      appliedAt = audit?.date ?? now.toISOString();
    } else if (hardRefusal) {
      status = "Refused";
      summary = hardRefusal.reason;
    } else if (notElected) {
      skipped.push({ proposal: entry.proposalId, reason: "not elected" });
      continue;
    } else {
      skipped.push({ proposal: entry.proposalId, reason: "not applied or refused" });
      continue;
    }

    await opts.client.updatePage(entry.pageId, statusProperties(status, appliedAt, schema));
    if (entry.lastAuditStatus !== status || entry.lastAuditSummary !== summary) {
      await opts.client.appendBlockChildren(entry.pageId, auditBlocks(status, summary));
    }
    entry.lastAuditStatus = status;
    entry.lastAuditSummary = summary;
    entry.lastAuditSynced = now.toISOString();
    synced.push({ proposalId: entry.proposalId, pageId: entry.pageId, status, summary });
  }

  writeNotionSyncState(opts.root, state);
  return {
    source: opts.source,
    databaseId: opts.databaseId,
    syncedAt: now.toISOString(),
    synced,
    skipped,
    refused,
  };
}
