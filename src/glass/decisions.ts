import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseProposalMarkdown } from "../apply/proposals.js";
import type { GlassProposalDetail } from "./types.js";
import { proposalToDetail } from "./view-models.js";

export type GlassDecision = "approve" | "reject" | "request-edit";

export interface GlassDecisionOptions {
  by?: string;
  note?: string;
  now?: Date;
}

function frontmatterBounds(content: string): { start: number; end: number; bodyStart: number } {
  const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/);
  if (!match || match.index !== 0) throw new Error("proposal missing frontmatter");
  return { start: 0, end: match[0].length, bodyStart: match[0].length };
}

function setFrontmatterValue(content: string, key: string, value: string): string {
  const bounds = frontmatterBounds(content);
  const block = content.slice(bounds.start, bounds.end);
  const pattern = new RegExp(`^${key}:.*$`, "m");
  const replacement = `${key}: ${value}`;
  const nextBlock = pattern.test(block)
    ? block.replace(pattern, replacement)
    : block.replace(/^---[ \t]*\r?\n/, (open) => `${open}${replacement}\n`);
  return `${nextBlock}${content.slice(bounds.end)}`;
}

function decisionStatus(decision: GlassDecision): string {
  if (decision === "approve") return "elected";
  if (decision === "reject") return "rejected";
  return "amended";
}

function decisionLabel(decision: GlassDecision): string {
  if (decision === "approve") return "elected";
  if (decision === "reject") return "rejected";
  return "amended";
}

function decisionSummary(decision: GlassDecision): string {
  if (decision === "approve") return "approved in Glass";
  if (decision === "reject") return "rejected in Glass";
  return "requested edits in Glass";
}

function setElectionCheckbox(content: string, elected: boolean): string {
  if (!/^- \[[ xX]\] Elect\b/m.test(content)) return content;
  return content.replace(/^- \[[ xX]\] Elect\b/m, elected ? "- [x] Elect" : "- [ ] Elect");
}

function lineText(value: string | undefined, fallback: string): string {
  const cleaned = value?.replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim();
  return cleaned || fallback;
}

function appendDecisionLine(content: string, proposalId: string, decision: GlassDecision, opts: GlassDecisionOptions): string {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const by = lineText(opts.by, "Glass reviewer");
  const note = lineText(opts.note, "");
  const suffix = note ? ` - ${note}` : "";
  const line = `- **${date}** - ${decisionSummary(decision)}${suffix} [proposal: ${proposalId}] [decision: ${decisionLabel(decision)}] [by: ${by}]`;
  const heading = "## Glass decisions";
  const trimmed = content.endsWith("\n") ? content : `${content}\n`;
  if (trimmed.includes(`${heading}\n`)) return `${trimmed}${line}\n`;
  return `${trimmed}\n${heading}\n\n${line}\n`;
}

function proposalPath(proposalsDir: string, proposalId: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(proposalId)) throw new Error(`invalid proposal id: ${proposalId}`);
  const absDir = resolve(proposalsDir);
  const path = resolve(absDir, `${proposalId}.md`);
  if (basename(path) !== `${proposalId}.md` || !path.startsWith(`${absDir}/`)) {
    throw new Error(`invalid proposal id: ${proposalId}`);
  }
  return path;
}

export function writeProposalDecision(
  proposalsDir: string,
  proposalId: string,
  decision: GlassDecision,
  opts: GlassDecisionOptions = {},
): GlassProposalDetail {
  const path = proposalPath(proposalsDir, proposalId);
  const original = readFileSync(path, "utf8");
  const parsed = parseProposalMarkdown(original, path);
  if (parsed.id !== proposalId) throw new Error(`proposal id mismatch: expected ${proposalId}, got ${parsed.id}`);
  const elected = decision === "approve";
  let next = setFrontmatterValue(original, "status", decisionStatus(decision));
  next = setFrontmatterValue(next, "elected", elected ? "true" : "false");
  next = setElectionCheckbox(next, elected);
  next = appendDecisionLine(next, proposalId, decision, opts);
  writeFileSync(path, next);
  return proposalToDetail(parseProposalMarkdown(next, path));
}
