import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyApproved, decideProposal, getAuditTrail, getProposalDetail, listProposals, previewApply, scanSurface } from "./service.js";
import type { GlassDecision } from "./decisions.js";
import { procedurePromotionView } from "./procedure-promotion.js";
import { checkHostAndOrigin, checkSourceParams, csrfTokenValid, isLoopbackHost } from "./guard.js";
import { resolveReviewer } from "./reviewer.js";
import type {
  GlassApplyPreview,
  GlassAuditTrail,
  GlassFinding,
  GlassProposalCard,
  GlassProposalDetail,
  GlassScanResult,
  GlassSource,
} from "./types.js";
import type { RegisterMode } from "../types.js";

export interface GlassServerOptions {
  root: string;
  register?: RegisterMode;
  memory?: boolean;
  host?: string;
  port?: number;
  proposalsDir?: string;
  /** Who signs elections made in this session. Defaults to KERNEL_KEEPER_REVIEWER, git user.name, then "reviewer". */
  reviewer?: string;
  /** Per-process CSRF token. Generated randomly when omitted; tests may pin it. */
  csrfToken?: string;
}

export interface GlassServer {
  server: Server;
  url: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Per-request rendering context for the forms the server owns. */
export interface GlassUi {
  csrfToken: string;
  reviewer: string;
}

const DEFAULT_UI: GlassUi = { csrfToken: "", reviewer: "reviewer" };

function severityClass(severity: string): string {
  if (severity === "HIGH") return "severity high";
  if (severity === "MED") return "severity med";
  return "severity low";
}

interface DashboardOptions {
  severity?: string;
  check?: string;
  owner?: string;
  findingId?: string;
  proposalsDir?: string;
}

function queryFor(opts: DashboardOptions, next: Partial<DashboardOptions>): string {
  const params = new URLSearchParams();
  const merged = { ...opts, ...next };
  if (merged.severity) params.set("severity", merged.severity);
  if (merged.check) params.set("check", merged.check);
  if (merged.owner) params.set("owner", merged.owner);
  if (merged.findingId) params.set("finding", merged.findingId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function filteredFindings(scan: GlassScanResult, opts: DashboardOptions): GlassFinding[] {
  return scan.findings.filter((finding) => {
    if (opts.severity && finding.severity !== opts.severity) return false;
    if (opts.check && !finding.check.toLowerCase().includes(opts.check.toLowerCase())) return false;
    if (opts.owner && !(finding.owner ?? "Needs owner").toLowerCase().includes(opts.owner.toLowerCase())) return false;
    return true;
  });
}

function sourceExcerpt(source: GlassSource, file: string | undefined): string | null {
  if (!file) return null;
  const root = resolve(source.root);
  const candidates = [{ path: resolve(root, file), root }];
  if (source.kind === "bundle" && file.startsWith("bundle/")) {
    const bundleParent = resolve(dirname(root));
    candidates.push({ path: resolve(bundleParent, file), root: bundleParent });
  }
  for (const candidate of candidates) {
    try {
      const relativePath = relative(candidate.root, candidate.path);
      if (relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) continue;
      if (!existsSync(candidate.path) || !lstatSync(candidate.path).isFile()) continue;
      // Resolve symlinks so a link inside the root cannot expose a file outside it.
      const realRelative = relative(realpathSync(candidate.root), realpathSync(candidate.path));
      if (realRelative === ".." || realRelative.startsWith("../") || isAbsolute(realRelative)) continue;
      return readFileSync(candidate.path, "utf8").slice(0, 1800);
    } catch {
      /* try next */
    }
  }
  return null;
}

function reviewHref(): string {
  return "/";
}

function proposalsHref(proposalId?: string): string {
  return proposalId ? `/proposals?${new URLSearchParams({ proposal: proposalId }).toString()}` : "/proposals";
}

function applyHref(proposalId?: string): string {
  return proposalId ? `/apply?${new URLSearchParams({ proposal: proposalId }).toString()}` : "/apply";
}

function stateClass(state: string): string {
  if (state === "approved" || state === "applied") return "severity low";
  if (state === "rejected" || state === "refused" || state === "stale") return "severity high";
  return "severity med";
}

function sharedStyles(): string {
  return `<style>
    :root { color-scheme: light; --ink: #17202a; --muted: #59636f; --line: #d8dee6; --panel: #ffffff; --surface: #f5f7fa; --accent: #126b5f; --high: #b42318; --med: #a15c07; --low: #475467; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--surface); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.45; }
    .shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
    aside { border-right: 1px solid var(--line); background: #fbfcfd; padding: 24px 18px; }
    main { padding: 24px; }
    h1, h2, h3 { margin: 0; line-height: 1.2; letter-spacing: 0; }
    h1 { font-size: 24px; } h2 { font-size: 18px; margin-bottom: 12px; } h3 { font-size: 14px; }
    .muted { color: var(--muted); }
    .brand { display: grid; gap: 4px; margin-bottom: 28px; }
    .nav { display: grid; gap: 8px; }
    .nav div { min-height: 34px; display: flex; align-items: center; color: var(--muted); }
    .nav .active { color: var(--ink); font-weight: 700; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    form { display: grid; grid-template-columns: minmax(220px, 1fr) 150px minmax(220px, 1fr) 92px; gap: 8px; align-items: end; margin-bottom: 20px; }
    label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    input, select, button { min-height: 36px; border: 1px solid var(--line); background: white; color: var(--ink); font: inherit; padding: 7px 10px; }
    button { background: var(--accent); border-color: var(--accent); color: white; font-weight: 700; cursor: pointer; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; background: white; border: 1px solid var(--line); }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--muted); font-size: 12px; font-weight: 700; background: #fbfcfd; }
    .severity { display: inline-flex; min-width: 48px; min-height: 24px; align-items: center; justify-content: center; border-radius: 4px; font-size: 12px; font-weight: 800; border: 1px solid var(--line); }
    .severity.high { color: var(--high); border-color: #f0b8b2; background: #fff4f2; }
    .severity.med { color: var(--med); border-color: #efc27f; background: #fff8ed; }
    .severity.low { color: var(--low); background: #f7f8fa; }
    .empty { padding: 28px; text-align: center; color: var(--muted); }
    a { color: var(--accent); font-weight: 700; }
    .detail { margin-bottom: 18px; }
    .detail-head { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
    .detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
    .promotion { border-left: 4px solid var(--accent); padding: 0 0 0 12px; margin: 0 0 16px; }
    .actions { display: grid; grid-template-columns: 120px minmax(220px, 1fr) minmax(220px, 1fr); gap: 8px; margin-bottom: 14px; }
    .actions form { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin: 0; }
    .actions form:first-child { grid-template-columns: 1fr; }
    p { margin: 6px 0 0; }
    pre { max-height: 260px; overflow: auto; white-space: pre-wrap; background: #f7f8fa; border: 1px solid var(--line); padding: 12px; margin: 8px 0 0; font-size: 12px; }
    @media (max-width: 860px) { .shell { grid-template-columns: 1fr; } aside { border-right: 0; border-bottom: 1px solid var(--line); } form, .detail-grid, .actions, .actions form { grid-template-columns: 1fr; } main { padding: 16px; } }
  </style>`;
}

function renderFindingDetail(scan: GlassScanResult, finding: GlassFinding | undefined): string {
  if (!finding) {
    return `<section class="panel detail muted">Select a finding to see why it matters, what to do next, and the local evidence when available.</section>`;
  }
  const excerpt = sourceExcerpt(scan.source, finding.file);
  return `<section class="panel detail">
    <div class="detail-head">
      <span class="${severityClass(finding.severity)}">${escapeHtml(finding.severity)}</span>
      <div>
        <h2>${escapeHtml(finding.title)}</h2>
        <div class="muted">${escapeHtml(finding.file ?? "Surface")} · ${escapeHtml(finding.check)}</div>
      </div>
    </div>
    <div class="detail-grid">
      <div>
        <h3>Why It Matters</h3>
        <p>${escapeHtml(finding.whyItMatters)}</p>
      </div>
      <div>
        <h3>Recommended Action</h3>
        <p>${escapeHtml(finding.recommendedAction)}</p>
      </div>
      <div>
        <h3>Technical Detail</h3>
        <p>${escapeHtml(finding.technical.message)}</p>
        ${finding.technical.hint ? `<p class="muted">${escapeHtml(finding.technical.hint)}</p>` : ""}
      </div>
    </div>
    ${excerpt ? `<h3>Source Excerpt</h3><pre>${escapeHtml(excerpt)}</pre>` : `<div class="muted">No local source excerpt is available for this finding.</div>`}
  </section>`;
}

function renderProposalDetail(
  proposal: GlassProposalDetail | null,
  preview: GlassApplyPreview | null,
  ui: GlassUi,
): string {
  if (!proposal) return `<section class="panel detail muted">Select a proposal to review its evidence, provenance, and decision controls.</section>`;
  const planned = preview?.planned.find((item) => item.proposal.id === proposal.id);
  const promotion = procedurePromotionView(proposal);
  return `<section class="panel detail">
    <div class="detail-head">
      <span class="${stateClass(proposal.state)}">${escapeHtml(proposal.state)}</span>
      <div>
        <h2>${escapeHtml(proposal.title)}</h2>
        <div class="muted">${escapeHtml(proposal.target ?? "New governed item")} · ${escapeHtml(proposal.kind)}</div>
      </div>
    </div>
    ${promotion ? `<div class="promotion">
      <h2>${escapeHtml(promotion.headline)}</h2>
      <p>${escapeHtml(promotion.explanation)}</p>
      <div class="detail-grid">
        <div><h3>Promotion Type</h3><p>${escapeHtml(promotion.label)}</p></div>
        <div><h3>Proposed File</h3><p>${escapeHtml(promotion.target)}</p></div>
        <div><h3>Target Check</h3><p>${promotion.validTarget ? "Ready for command, skill, or agent review." : "Needs a command, skill, or agent target before apply."}</p></div>
      </div>
    </div>` : ""}
    <div class="detail-grid">
      <div>
        <h3>Why It Matters</h3>
        <p>${escapeHtml(proposal.summary)}</p>
      </div>
      <div>
        <h3>Evidence</h3>
        <p>${proposal.evidence.length ? proposal.evidence.map(escapeHtml).join("<br>") : "No evidence files declared."}</p>
      </div>
      <div>
        <h3>Provenance</h3>
        <p>${escapeHtml(proposal.provenance.promptSha256 ?? "Missing prompt hash")}</p>
        <p class="muted">${escapeHtml(proposal.provenance.reviewedSurfaceSha256 ?? "Missing surface hash")}</p>
      </div>
    </div>
    <div class="actions">
      <form method="post" action="/proposals/decision">
        ${postFields(ui, proposal.id)}
        <input type="hidden" name="decision" value="approve">
        ${reviewerField(ui)}
        <button type="submit">Approve</button>
      </form>
      <form method="post" action="/proposals/decision">
        ${postFields(ui, proposal.id)}
        <input type="hidden" name="decision" value="request-edit">
        <input name="note" placeholder="Edit request">
        <button type="submit">Request Edit</button>
      </form>
      <form method="post" action="/proposals/decision">
        ${postFields(ui, proposal.id)}
        <input type="hidden" name="decision" value="reject">
        <input name="note" placeholder="Reason">
        <button type="submit">Reject</button>
      </form>
    </div>
    ${planned ? `<h3>Before / After Preview</h3>${planned.changes.map((change) => `<pre>${escapeHtml(change.diff)}</pre>`).join("")}` : `<div class="muted">No apply preview is available until this proposal is approved and eligible.</div>`}
    ${proposal.draft.bodyDraft ? `<h3>Draft Content</h3><pre>${escapeHtml(proposal.draft.bodyDraft)}</pre>` : ""}
  </section>`;
}

/** Hidden fields on every POST form: the CSRF token and the proposal the action is about. */
function postFields(ui: GlassUi, proposalId: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(ui.csrfToken)}">
    <input type="hidden" name="proposal" value="${escapeHtml(proposalId)}">`;
}

/** Shows who will sign. Display only: the server uses its own configured reviewer, never a posted one. */
function reviewerField(ui: GlassUi): string {
  return `<label>Electing as
          <input value="${escapeHtml(ui.reviewer)}" readonly aria-label="Reviewer">
        </label>`;
}

export function renderProposalInbox(
  source: GlassSource,
  proposalsDir: string | undefined,
  proposals: GlassProposalCard[] = [],
  selected: GlassProposalDetail | null = null,
  preview: GlassApplyPreview | null = null,
  refused: { proposal: string; summary: string; technicalReason: string }[] = [],
  ui: GlassUi = DEFAULT_UI,
): string {
  const selectedId = selected?.id ?? proposals[0]?.id;
  const rows = proposals.map((proposal) => `
    <tr>
      <td><span class="${stateClass(proposal.state)}">${escapeHtml(proposal.state)}</span></td>
      <td>
        <strong>${escapeHtml(proposal.title)}</strong>
        <div class="muted">${escapeHtml(proposal.summary)}</div>
      </td>
      <td>${escapeHtml(proposal.target ?? "New item")}</td>
      <td>${proposal.checks.map(escapeHtml).join(", ")}</td>
      <td><a href="${escapeHtml(proposalsHref(proposal.id))}">Open detail</a></td>
    </tr>
  `).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kernel Keeper Glass Proposals</title>
  ${sharedStyles()}
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <h1>Kernel Keeper Glass</h1>
        <div class="muted">Business review console</div>
      </div>
      <nav class="nav" aria-label="Glass sections">
        <div><a href="${escapeHtml(reviewHref())}">Review Queue</a></div>
        <div class="active">Proposals</div>
        <div>${proposalsDir ? `<a href="${escapeHtml(applyHref(selectedId))}">Apply</a>` : "Apply"}</div>
        <div>Audit</div>
        <div>Settings</div>
      </nav>
    </aside>
    <main>
      <div class="topbar">
        <div>
          <h1>Proposal Inbox</h1>
          <div class="muted">${escapeHtml(source.kind)} · ${escapeHtml(source.register ?? "truth register")}</div>
        </div>
        <div class="muted">${escapeHtml(proposalsDir ?? "No proposal directory configured")}</div>
      </div>
      <div class="muted" style="margin-bottom: 20px;">Source: ${escapeHtml(source.root)}</div>
      ${refused.length ? `<section class="panel detail"><h2>Refused Proposal Files</h2>${refused.map((item) => `<p><strong>${escapeHtml(item.proposal)}</strong>: ${escapeHtml(item.summary)}</p>`).join("")}</section>` : ""}
      ${proposalsDir && selectedId ? renderProposalDetail(selected, preview, ui) : `<section class="panel empty">Add a proposals directory to review drafted changes.</section>`}
      ${rows ? `<table>
        <thead><tr><th style="width: 110px;">State</th><th>Proposal</th><th>Target</th><th>Checks</th><th style="width: 110px;">Detail</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="panel empty">No proposal files found.</div>`}
    </main>
  </div>
</body>
</html>`;
}

function renderApplyRows(preview: GlassApplyPreview): string {
  return preview.planned.map((planned) => `
    <section class="panel detail">
      <h2>${escapeHtml(planned.proposal.title)}</h2>
      <div class="muted">${escapeHtml(planned.proposal.target ?? planned.proposal.id)}</div>
      ${planned.changes.map((change) => `
        <h3>${escapeHtml(change.summary)}</h3>
        <pre>${escapeHtml(change.diff)}</pre>
      `).join("")}
    </section>
  `).join("");
}

function renderSafety(preview: GlassApplyPreview): string {
  const skipped = preview.skipped.map((item) => `<p><strong>${escapeHtml(item.proposal)}</strong>: ${escapeHtml(item.summary)}</p>`).join("");
  const refused = preview.refused.map((item) => `<p><strong>${escapeHtml(item.proposal)}</strong>: ${escapeHtml(item.summary)}</p>`).join("");
  return `<section class="panel detail">
    <h2>Safety Checks</h2>
    <p>${preview.canWrite ? "Ready to apply. No refusal reasons were found." : "Not ready to apply yet."}</p>
    ${skipped ? `<h3>Skipped</h3>${skipped}` : ""}
    ${refused ? `<h3>Refused</h3>${refused}` : ""}
  </section>`;
}

function renderAudit(audit: GlassAuditTrail): string {
  if (!audit.entries.length) return `<section class="panel detail"><h2>Audit History</h2><p class="muted">No applied proposal audit entries yet.</p></section>`;
  return `<section class="panel detail">
    <h2>Audit History</h2>
    ${audit.entries.slice(-10).reverse().map((entry) => `<p><strong>${escapeHtml(entry.date ?? "unknown")}</strong>: ${escapeHtml(entry.summary)}</p>`).join("")}
  </section>`;
}

export function renderApplyPage(
  source: GlassSource,
  proposalsDir: string | undefined,
  preview: GlassApplyPreview | null = null,
  audit: GlassAuditTrail | null = null,
  opts: { proposalId?: string; message?: string; ui?: GlassUi } = {},
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kernel Keeper Glass Apply</title>
  ${sharedStyles()}
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <h1>Kernel Keeper Glass</h1>
        <div class="muted">Business review console</div>
      </div>
      <nav class="nav" aria-label="Glass sections">
        <div><a href="${escapeHtml(reviewHref())}">Review Queue</a></div>
        <div>${proposalsDir ? `<a href="${escapeHtml(proposalsHref(opts.proposalId))}">Proposals</a>` : "Proposals"}</div>
        <div class="active">Apply</div>
        <div>Audit</div>
        <div>Settings</div>
      </nav>
    </aside>
    <main>
      <div class="topbar">
        <div>
          <h1>Apply Preview</h1>
          <div class="muted">${escapeHtml(source.kind)} · ${escapeHtml(source.register ?? "truth register")}</div>
        </div>
        <div class="muted">${escapeHtml(proposalsDir ?? "No proposal directory configured")}</div>
      </div>
      <div class="muted" style="margin-bottom: 20px;">Source: ${escapeHtml(source.root)}</div>
      ${opts.message ? `<section class="panel detail"><h2>Result</h2><p>${escapeHtml(opts.message)}</p></section>` : ""}
      ${preview ? renderSafety(preview) : `<section class="panel empty">Add a proposals directory to preview approved changes.</section>`}
      ${preview?.canWrite ? `<section class="panel detail">
        <h2>Apply Approved Changes</h2>
        <p class="muted">Type apply by pressing the button below. Glass writes through the deterministic Clerk and records the existing audit markers.</p>
        <form method="post" action="/apply/write">
          ${postFields(opts.ui ?? DEFAULT_UI, opts.proposalId ?? "")}
          <input type="hidden" name="confirm" value="apply">
          <button type="submit">Apply Approved</button>
        </form>
      </section>` : ""}
      ${preview ? renderApplyRows(preview) || `<div class="panel empty">No approved changes are ready to apply.</div>` : ""}
      ${audit ? renderAudit(audit) : ""}
    </main>
  </div>
</body>
</html>`;
}

export function renderGlassDashboard(scan: GlassScanResult, opts: DashboardOptions = {}): string {
  const counts = scan.stats.findingsBySeverity;
  const visible = filteredFindings(scan, opts);
  const selected = visible.find((finding) => finding.id === opts.findingId) ?? visible[0];
  const highImpact = visible.filter((finding) => finding.severity === "HIGH" || finding.severity === "MED");
  const checks = [...new Set(scan.findings.map((finding) => finding.check))].sort();
  const rows = visible.slice(0, 30).map((finding) => `
    <tr>
      <td><span class="${severityClass(finding.severity)}">${escapeHtml(finding.severity)}</span></td>
      <td>
        <strong>${escapeHtml(finding.title)}</strong>
        <div class="muted">${escapeHtml(finding.summary)}</div>
      </td>
      <td>${escapeHtml(finding.file ?? "Surface")}</td>
      <td>${escapeHtml(finding.owner ?? "Needs owner")}</td>
      <td>
        ${escapeHtml(finding.recommendedAction)}
        <div><a href="${escapeHtml(queryFor(opts, { findingId: finding.id }))}">Open detail</a></div>
      </td>
    </tr>
  `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kernel Keeper Glass</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17202a;
      --muted: #59636f;
      --line: #d8dee6;
      --panel: #ffffff;
      --surface: #f5f7fa;
      --accent: #126b5f;
      --high: #b42318;
      --med: #a15c07;
      --low: #475467;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--surface);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }
    .shell {
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
      min-height: 100vh;
    }
    aside {
      border-right: 1px solid var(--line);
      background: #fbfcfd;
      padding: 24px 18px;
    }
    main { padding: 24px; }
    h1, h2, h3 { margin: 0; line-height: 1.2; letter-spacing: 0; }
    h1 { font-size: 24px; }
    h2 { font-size: 18px; margin-bottom: 12px; }
    h3 { font-size: 14px; }
    .muted { color: var(--muted); }
    .brand { display: grid; gap: 4px; margin-bottom: 28px; }
    .nav { display: grid; gap: 8px; }
    .nav div {
      min-height: 34px;
      display: flex;
      align-items: center;
      color: var(--muted);
    }
    .nav .active { color: var(--ink); font-weight: 700; }
    .topbar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    form {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 150px 120px 92px;
      gap: 8px;
      align-items: end;
      margin-bottom: 20px;
    }
    .filters {
      grid-template-columns: 130px minmax(120px, 200px) minmax(120px, 1fr) 92px;
      margin-top: -8px;
    }
    label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; }
    input, select, button {
      min-height: 36px;
      border: 1px solid var(--line);
      background: white;
      color: var(--ink);
      font: inherit;
      padding: 7px 10px;
    }
    button {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
      font-weight: 700;
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .metric { font-size: 28px; font-weight: 800; margin-top: 8px; }
    .metric.high { color: var(--high); }
    .metric.med { color: var(--med); }
    .metric.low { color: var(--low); }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      background: white;
      border: 1px solid var(--line);
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 10px;
      text-align: left;
      vertical-align: top;
      overflow-wrap: anywhere;
    }
    th { color: var(--muted); font-size: 12px; font-weight: 700; background: #fbfcfd; }
    .severity {
      display: inline-flex;
      min-width: 48px;
      min-height: 24px;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 800;
      border: 1px solid var(--line);
    }
    .severity.high { color: var(--high); border-color: #f0b8b2; background: #fff4f2; }
    .severity.med { color: var(--med); border-color: #efc27f; background: #fff8ed; }
    .severity.low { color: var(--low); background: #f7f8fa; }
    .empty { padding: 28px; text-align: center; color: var(--muted); }
    a { color: var(--accent); font-weight: 700; }
    .detail { margin-bottom: 18px; }
    .detail-head {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }
    p { margin: 6px 0 0; }
    pre {
      max-height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      background: #f7f8fa;
      border: 1px solid var(--line);
      padding: 12px;
      margin: 8px 0 0;
      font-size: 12px;
    }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      form, .filters, .grid, .detail-grid { grid-template-columns: 1fr; }
      main { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <div class="brand">
        <h1>Kernel Keeper Glass</h1>
        <div class="muted">Business review console</div>
      </div>
      <nav class="nav" aria-label="Glass sections">
        <div class="active">Review Queue</div>
        <div>${opts.proposalsDir ? `<a href="${escapeHtml(proposalsHref())}">Proposals</a>` : "Proposals"}</div>
        <div>${opts.proposalsDir ? `<a href="${escapeHtml(applyHref())}">Apply</a>` : "Apply"}</div>
        <div>Audit</div>
        <div>Settings</div>
      </nav>
    </aside>
    <main>
      <div class="topbar">
        <div>
          <h1>Review Queue</h1>
          <div class="muted">${escapeHtml(scan.source.kind)} · ${escapeHtml(scan.source.register ?? "truth register")} · scanned ${escapeHtml(scan.scannedAt)}</div>
        </div>
        <div class="muted">${escapeHtml(scan.source.root)}</div>
      </div>

      <form class="filters" method="get" action="/">
        <label>Severity
          <select name="severity">
            <option value=""${opts.severity ? "" : " selected"}>Any</option>
            <option value="HIGH"${opts.severity === "HIGH" ? " selected" : ""}>High</option>
            <option value="MED"${opts.severity === "MED" ? " selected" : ""}>Medium</option>
            <option value="LOW"${opts.severity === "LOW" ? " selected" : ""}>Low</option>
          </select>
        </label>
        <label>Check
          <select name="check">
            <option value=""${opts.check ? "" : " selected"}>Any</option>
            ${checks.map((check) => `<option value="${escapeHtml(check)}"${opts.check === check ? " selected" : ""}>${escapeHtml(check)}</option>`).join("")}
          </select>
        </label>
        <label>Owner
          <input name="owner" value="${escapeHtml(opts.owner ?? "")}" placeholder="Owner or Needs owner">
        </label>
        <button type="submit">Filter</button>
      </form>

      <section class="grid" aria-label="Scan summary">
        <div class="panel"><h3>Governed Items</h3><div class="metric">${scan.stats.items}</div></div>
        <div class="panel"><h3>High Risk</h3><div class="metric high">${counts.HIGH}</div></div>
        <div class="panel"><h3>Needs Review</h3><div class="metric med">${counts.MED}</div></div>
        <div class="panel"><h3>Visible Queue</h3><div class="metric low">${visible.length}</div></div>
      </section>

      <section class="panel" style="margin-bottom: 18px;">
        <h2>What Needs Attention</h2>
        <div class="muted">${highImpact.length} visible high or medium priority items need owner review.</div>
      </section>

      ${renderFindingDetail(scan, selected)}

      ${rows ? `<table>
        <thead>
          <tr>
            <th style="width: 86px;">Severity</th>
            <th>Finding</th>
            <th>Item</th>
            <th style="width: 150px;">Owner</th>
            <th>Recommended Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : `<div class="panel empty">No findings for this scan.</div>`}
    </main>
  </div>
</body>
</html>`;
}

function renderError(error: unknown, source: GlassSource): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kernel Keeper Glass</title></head>
<body style="font-family: system-ui, sans-serif; margin: 32px; color: #17202a;">
  <h1>Glass could not scan this source</h1>
  <p>${escapeHtml(message)}</p>
  <p><strong>Source:</strong> ${escapeHtml(source.root)}</p>
  <p><a href="/">Back to Glass</a></p>
</body>
</html>`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

const MAX_FORM_BYTES = 64 * 1024;
const MAX_NOTE_LENGTH = 500;

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolveRead, reject) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_FORM_BYTES) {
        reject(new FormTooLargeError());
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolveRead(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

class FormTooLargeError extends Error {
  constructor() {
    super("form body too large");
  }
}

/** The one source this server was launched with. Requests cannot change it. */
function configuredSource(options: GlassServerOptions): GlassSource {
  return {
    root: resolve(options.root),
    kind: options.register ? "estate" : "bundle",
    ...(options.register ? { register: options.register } : {}),
    ...(options.memory !== undefined ? { memory: options.memory } : {}),
  };
}

function decisionValue(value: string | null): GlassDecision | null {
  if (value === "approve" || value === "reject" || value === "request-edit") return value;
  return null;
}

function setSecurityHeaders(res: ServerResponse): void {
  // No scripts are served, so nothing may run; forms may only post back to this origin,
  // and the pages may not be framed (clickjacking the Approve button).
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "no-store");
}

function refuse(res: ServerResponse, status: number, reason: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(reason);
}

interface GlassRuntime {
  options: GlassServerOptions;
  csrfToken: string;
  reviewer: string;
  boundHost: string;
}

export function createGlassServer(options: GlassServerOptions): Server {
  const runtime: GlassRuntime = {
    options,
    csrfToken: options.csrfToken ?? randomBytes(32).toString("hex"),
    reviewer: resolveReviewer(options.reviewer),
    boundHost: options.host ?? "127.0.0.1",
  };
  return createServer((req, res) => {
    void handleGlassRequest(req, res, runtime).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof FormTooLargeError) {
        refuse(res, 413, "Form body too large.");
        return;
      }
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
}

async function handleGlassRequest(req: IncomingMessage, res: ServerResponse, runtime: GlassRuntime): Promise<void> {
  const { options, reviewer } = runtime;
  setSecurityHeaders(res);

  // Guards run before any routing, for every method.
  const hostFailure = checkHostAndOrigin(req.headers, req.socket.localPort ?? 0, runtime.boundHost);
  if (hostFailure) return refuse(res, hostFailure.status, hostFailure.reason);
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return refuse(res, 405, "Method not allowed.");

  const url = new URL(req.url ?? "/", "http://localhost");
  const queryFailure = checkSourceParams(url.searchParams, options);
  if (queryFailure) return refuse(res, queryFailure.status, queryFailure.reason);

  const form = method === "POST" ? await readForm(req) : null;
  if (form) {
    if (!csrfTokenValid(runtime.csrfToken, form.get("csrf"))) return refuse(res, 403, "Missing or invalid CSRF token.");
    const formFailure = checkSourceParams(form, options);
    if (formFailure) return refuse(res, formFailure.status, formFailure.reason);
  }

  const root = resolve(options.root);
  const register = options.register;
  const memory = options.memory;
  const proposalsDir = options.proposalsDir;
  const source = configuredSource(options);
  const ui: GlassUi = { csrfToken: runtime.csrfToken, reviewer };
  const registerOpt = register ? { register } : {};
  const memoryOpt = memory !== undefined ? { memory } : {};
  const dashboardOpts: DashboardOptions = {
    ...(proposalsDir ? { proposalsDir } : {}),
    ...(url.searchParams.get("severity") ? { severity: url.searchParams.get("severity") as string } : {}),
    ...(url.searchParams.get("check") ? { check: url.searchParams.get("check") as string } : {}),
    ...(url.searchParams.get("owner") ? { owner: url.searchParams.get("owner") as string } : {}),
    ...(url.searchParams.get("finding") ? { findingId: url.searchParams.get("finding") as string } : {}),
  };
  const html = (body: string, status = 200): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
  try {
    if (url.pathname === "/proposals/decision" && form) {
      const proposalId = form.get("proposal");
      const decision = decisionValue(form.get("decision"));
      if (!proposalsDir || !proposalId || !decision) throw new Error("proposal decision requires a configured proposals directory, proposal, and decision");
      const note = form.get("note")?.trim().slice(0, MAX_NOTE_LENGTH);
      // The reviewer is the one resolved at startup. A posted "by" is ignored.
      decideProposal(proposalsDir, proposalId, decision, { by: reviewer, ...(note ? { note } : {}) });
      res.writeHead(303, { location: proposalsHref(proposalId) });
      res.end();
      return;
    }
    if (url.pathname === "/apply/write" && form) {
      if (!proposalsDir || form.get("confirm") !== "apply") throw new Error("apply write requires a configured proposals directory and explicit confirmation");
      const proposalId = form.get("proposal") || undefined;
      const applyOpts = { proposalsDir, ...registerOpt, ...(proposalId ? { proposalId } : {}) };
      const result = applyApproved(root, applyOpts);
      const afterPreview = previewApply(root, applyOpts);
      const audit = getAuditTrail(root, { ...registerOpt, ...memoryOpt });
      html(renderApplyPage(source, proposalsDir, afterPreview, audit, {
        ...(proposalId ? { proposalId } : {}),
        message: `Applied ${result.written.length} file(s).`,
        ui,
      }));
      return;
    }
    if (form) return refuse(res, 404, "Not found");
    if (url.pathname === "/api/scan") {
      json(res, 200, scanSurface(root, { ...registerOpt, ...memoryOpt }));
      return;
    }
    if (url.pathname === "/proposals") {
      if (!proposalsDir) return html(renderProposalInbox(source, undefined, [], null, null, [], ui));
      const listed = listProposals(proposalsDir);
      const selectedId = url.searchParams.get("proposal") || listed.proposals[0]?.id;
      const detail = selectedId ? getProposalDetail(proposalsDir, selectedId) : null;
      const preview = detail?.elected ? previewApply(root, { proposalsDir, ...registerOpt, proposalId: detail.id }) : null;
      return html(renderProposalInbox(source, proposalsDir, listed.proposals, detail, preview, listed.refused, ui));
    }
    if (url.pathname === "/apply") {
      if (!proposalsDir) return html(renderApplyPage(source, undefined, null, null, { ui }));
      const proposalId = url.searchParams.get("proposal") || undefined;
      const preview = previewApply(root, { proposalsDir, ...registerOpt, ...(proposalId ? { proposalId } : {}) });
      const audit = getAuditTrail(root, { ...registerOpt, ...memoryOpt });
      return html(renderApplyPage(source, proposalsDir, preview, audit, { ...(proposalId ? { proposalId } : {}), ui }));
    }
    if (url.pathname !== "/") return refuse(res, 404, "Not found");
    const scan = scanSurface(root, { ...registerOpt, ...memoryOpt });
    html(renderGlassDashboard(scan, dashboardOpts));
  } catch (err) {
    if (err instanceof FormTooLargeError) throw err;
    if (url.pathname === "/api/scan") {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } else if (url.pathname === "/proposals") {
      html(renderProposalInbox(source, proposalsDir, [], null, null, [], ui));
    } else if (url.pathname === "/apply") {
      html(renderApplyPage(source, proposalsDir, null, null, { ui }));
    } else {
      html(renderError(err, source));
    }
  }
}

export async function startGlassServer(options: GlassServerOptions): Promise<GlassServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  // Glass has no login. The Host and Origin checks only make sense on loopback, so refuse anything else.
  if (!isLoopbackHost(host)) {
    throw new Error(`Glass has no authentication and only binds to loopback (127.0.0.1, localhost or ::1), not ${host}.`);
  }
  const server = createGlassServer({ ...options, host });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = host === "::1" ? "[::1]" : host;
  return { server, url: `http://${urlHost}:${actualPort}` };
}
