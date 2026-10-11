import type { GlassProposalDetail, GlassProposalState, GlassSource } from "../types.js";
import type { NotionApprovalStatus, NotionDecision, NotionExportBlock, NotionProposalExport, RenderNotionProposalOptions } from "./types.js";

function stateToStatus(state: GlassProposalState): NotionApprovalStatus {
  if (state === "approved") return "Approved";
  if (state === "rejected") return "Rejected";
  if (state === "amended") return "Request edit";
  if (state === "applied") return "Applied";
  if (state === "refused") return "Refused";
  if (state === "stale") return "Stale";
  return "Needs review";
}

function stateToDecision(state: GlassProposalState, elected: boolean): NotionDecision {
  if (elected || state === "approved") return "Approved";
  if (state === "rejected") return "Rejected";
  if (state === "amended") return "Request edit";
  return null;
}

function sourceLabel(source: GlassSource): string {
  if (source.label) return source.label;
  if (source.register) return `${source.kind}:${source.register}`;
  return source.kind;
}

function nonEmpty(values: string[]): string[] {
  return values.map((v) => v.trim()).filter(Boolean);
}

function draftBlocks(proposal: GlassProposalDetail): NotionExportBlock[] {
  const blocks: NotionExportBlock[] = [];
  if (proposal.draft.frontmatterPatch) {
    blocks.push({ type: "heading_3", text: "Frontmatter Patch" });
    blocks.push({
      type: "code",
      language: "markdown",
      text: Object.entries(proposal.draft.frontmatterPatch)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n"),
    });
  }
  if (proposal.draft.bodyDraft) {
    blocks.push({ type: "heading_3", text: "Body Draft" });
    blocks.push({ type: "code", language: "markdown", text: proposal.draft.bodyDraft });
  }
  if (proposal.draft.indexEntry) {
    blocks.push({ type: "heading_3", text: "Index Entry" });
    blocks.push({ type: "code", language: "markdown", text: proposal.draft.indexEntry });
  }
  if (proposal.draft.journalLine) {
    blocks.push({ type: "heading_3", text: "Journal Line" });
    blocks.push({ type: "code", language: "markdown", text: proposal.draft.journalLine });
  }
  return blocks;
}

function evidenceBlocks(proposal: GlassProposalDetail): NotionExportBlock[] {
  if (proposal.evidence.length === 0) return [{ type: "paragraph", text: "No evidence files were recorded on this proposal." }];
  return proposal.evidence.map((file) => ({ type: "bulleted_list_item", text: file }));
}

function provenanceBlocks(proposal: GlassProposalDetail): NotionExportBlock[] {
  const files = proposal.provenance.reviewedSurfaceFiles.map((entry) => `${entry.path}: ${entry.sha256}`);
  return [
    { type: "bulleted_list_item", text: `Prompt hash: ${proposal.provenance.promptSha256 ?? "not recorded"}` },
    { type: "bulleted_list_item", text: `Reviewed surface hash: ${proposal.provenance.reviewedSurfaceSha256 ?? "not recorded"}` },
    ...(files.length > 0 ? files.map((text) => ({ type: "bulleted_list_item" as const, text })) : [{ type: "bulleted_list_item" as const, text: "Reviewed files: not recorded" }]),
  ];
}

export function notionDecisionGuidanceBlocks(): NotionExportBlock[] {
  return [
    {
      type: "paragraph",
      text: "Human reviewer: make your decision by setting the Decision property at the top of this Notion page.",
    },
    { type: "bulleted_list_item", text: "Choose Approved when the draft is safe to elect." },
    { type: "bulleted_list_item", text: "Choose Rejected when the proposal should not be applied." },
    { type: "bulleted_list_item", text: "Choose Request edit when the proposal needs a human amendment before election." },
    { type: "bulleted_list_item", text: "Leave Decision blank if the proposal is still being reviewed." },
    {
      type: "paragraph",
      text: "After a decision is set, Kernel Keeper syncs it back to the canonical proposal file. The Clerk then previews the apply diff and only writes changes for elected proposals.",
    },
  ];
}

export function renderNotionProposal(opts: RenderNotionProposalOptions): NotionProposalExport {
  const renderedAt = opts.renderedAt.toISOString();
  const proposal = opts.proposal;
  const status = stateToStatus(proposal.state);
  const decision = stateToDecision(proposal.state, proposal.elected);
  const target = proposal.target ?? "(new item)";
  const reviewedHash = proposal.provenance.reviewedSurfaceSha256;
  const checks = nonEmpty(proposal.checks);

  return {
    proposalId: proposal.id,
    proposalFile: proposal.file,
    properties: {
      "Proposal ID": { type: "title", value: proposal.id },
      Status: { type: "select", value: status },
      Decision: { type: "select", value: decision },
      Owner: { type: "rich_text", value: null },
      Severity: { type: "select", value: "Unspecified" },
      Checks: { type: "multi_select", value: checks },
      Source: { type: "rich_text", value: sourceLabel(opts.source) },
      Target: { type: "rich_text", value: target },
      "Evidence Count": { type: "number", value: proposal.evidence.length },
      "Reviewed Hash": { type: "rich_text", value: reviewedHash },
      "Last Synced": { type: "date", value: renderedAt },
      "Applied At": { type: "date", value: null },
    },
    page: {
      title: `${proposal.id}: ${proposal.title}`,
      blocks: [
        { type: "heading_2", text: proposal.title },
        { type: "paragraph", text: proposal.summary },
        { type: "heading_3", text: "Target" },
        { type: "paragraph", text: target },
        { type: "heading_3", text: "Evidence" },
        ...evidenceBlocks(proposal),
        { type: "heading_3", text: "Draft" },
        ...draftBlocks(proposal),
        { type: "heading_3", text: "Provenance" },
        ...provenanceBlocks(proposal),
        { type: "heading_3", text: "Decision Guidance" },
        ...notionDecisionGuidanceBlocks(),
      ],
    },
    sync: {
      proposalId: proposal.id,
      proposalFile: proposal.file,
      sourceRoot: opts.source.root,
      reviewedSurfaceSha256: reviewedHash,
      renderedAt,
    },
  };
}

export function renderNotionProposals(source: GlassSource, proposals: GlassProposalDetail[], renderedAt: Date): NotionProposalExport[] {
  return proposals.map((proposal) => renderNotionProposal({ source, proposal, renderedAt }));
}
