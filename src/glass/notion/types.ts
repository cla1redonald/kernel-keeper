import type { GlassProposalDetail, GlassSource } from "../types.js";

export type NotionApprovalStatus = "Needs review" | "Approved" | "Rejected" | "Request edit" | "Applied" | "Stale" | "Refused";
export type NotionDecision = "Approved" | "Rejected" | "Request edit" | null;

export type NotionExportProperty =
  | { type: "title"; value: string }
  | { type: "rich_text"; value: string | null }
  | { type: "select"; value: string | null }
  | { type: "multi_select"; value: string[] }
  | { type: "number"; value: number }
  | { type: "date"; value: string | null };

export interface NotionExportBlock {
  type: "heading_2" | "heading_3" | "paragraph" | "bulleted_list_item" | "code";
  text: string;
  language?: "markdown" | "plain text";
}

export interface NotionProposalSyncMetadata {
  proposalId: string;
  proposalFile: string;
  sourceRoot: string;
  reviewedSurfaceSha256: string | null;
  renderedAt: string;
}

export interface NotionProposalExport {
  proposalId: string;
  proposalFile: string;
  properties: Record<string, NotionExportProperty>;
  page: {
    title: string;
    blocks: NotionExportBlock[];
  };
  sync: NotionProposalSyncMetadata;
}

export interface NotionSyncExport {
  source: GlassSource;
  dryRun: boolean;
  renderedAt: string;
  proposals: NotionProposalExport[];
  refused: { proposal: string; summary: string; technicalReason: string }[];
}

export interface RenderNotionProposalOptions {
  source: GlassSource;
  proposal: GlassProposalDetail;
  renderedAt: Date;
}
