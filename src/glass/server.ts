import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyApproved, decideProposal, getAuditTrail, getProposalDetail, listProposals, previewApply, scanSurface } from "./service.js";
import type { GlassDecision } from "./decisions.js";
import { procedurePromotionView } from "./procedure-promotion.js";
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

function registerValue(value: string | null): RegisterMode | undefined {
  if (value === "skills" || value === "agents" || value === "commands" || value === "estate") return value;
  return undefined;
}

interface RequestSource extends GlassServerOptions {
  proposalsDir?: string;
}

function sourceFromRequest(req: IncomingMessage, defaults: GlassServerOptions): RequestSource {
  const url = new URL(req.url ?? "/", "http://localhost");
  const root = url.searchParams.get("root") || defaults.root;
  const register = registerValue(url.searchParams.get("register")) ?? defaults.register;
  const memory = url.searchParams.has("memory") ? url.searchParams.get("memory") === "true" : defaults.memory;
  const proposalsDir = url.searchParams.get("proposals") || defaults.proposalsDir;
  return {
    root,
    ...(register ? { register } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(proposalsDir ? { proposalsDir } : {}),
  };
}

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

function queryFor(scan: GlassScanResult, opts: DashboardOptions, next: Partial<DashboardOptions>): string {
  const params = new URLSearchParams();
  params.set("root", scan.source.root);
  if (scan.source.register) params.set("register", scan.source.register);
  if (scan.source.memory !== undefined) params.set("memory", String(scan.source.memory));
  const merged = { ...opts, ...next };
  if (merged.proposalsDir) params.set("proposals", merged.proposalsDir);
  if (merged.severity) params.set("severity", merged.severity);
  if (merged.check) params.set("check", merged.check);
  if (merged.owner) params.set("owner", merged.owner);
  if (merged.findingId) params.set("finding", merged.findingId);
  return `/?${params.toString()}`;
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
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
      if (!existsSync(candidate.path) || !lstatSync(candidate.path).isFile()) continue;
      return readFileSync(candidate.path, "utf8").slice(0, 1800);
    } catch {
      /* try next */
    }
  }
  return null;
}

function sourceParams(source: GlassSource, proposalsDir?: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set("root", source.root);
  if (source.register) params.set("register", source.register);
  if (source.memory !== undefined) params.set("memory", String(source.memory));
  if (proposalsDir) params.set("proposals", proposalsDir);
  return params;
}

function reviewHref(source: GlassSource, proposalsDir?: string): string {
  return `/?${sourceParams(source, proposalsDir).toString()}`;
}

function proposalsHref(source: GlassSource, proposalsDir: string, proposalId?: string): string {
  const params = sourceParams(source, proposalsDir);
  if (proposalId) params.set("proposal", proposalId);
  return `/proposals?${params.toString()}`;
}

function applyHref(source: GlassSource, proposalsDir: string, proposalId?: string): string {
  const params = sourceParams(source, proposalsDir);
  if (proposalId) params.set("proposal", proposalId);
  return `/apply?${params.toString()}`;
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
  source: GlassSource,
  proposalsDir: string,
  proposal: GlassProposalDetail | null,
  preview: GlassApplyPreview | null,
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
        ${decisionHiddenFields(source, proposalsDir, proposal.id)}
        <input type="hidden" name="decision" value="approve">
        <input type="hidden" name="by" value="Claire">
        <button type="submit">Approve</button>
      </form>
      <form method="post" action="/proposals/decision">
        ${decisionHiddenFields(source, proposalsDir, proposal.id)}
        <input type="hidden" name="decision" value="request-edit">
        <input name="note" placeholder="Edit request">
        <button type="submit">Request Edit</button>
      </form>
      <form method="post" action="/proposals/decision">
        ${decisionHiddenFields(source, proposalsDir, proposal.id)}
        <input type="hidden" name="decision" value="reject">
        <input name="note" placeholder="Reason">
        <button type="submit">Reject</button>
      </form>
    </div>
    ${planned ? `<h3>Before / After Preview</h3>${planned.changes.map((change) => `<pre>${escapeHtml(change.diff)}</pre>`).join("")}` : `<div class="muted">No apply preview is available until this proposal is approved and eligible.</div>`}
    ${proposal.draft.bodyDraft ? `<h3>Draft Content</h3><pre>${escapeHtml(proposal.draft.bodyDraft)}</pre>` : ""}
  </section>`;
}

function decisionHiddenFields(source: GlassSource, proposalsDir: string, proposalId: string): string {
  return `<input type="hidden" name="root" value="${escapeHtml(source.root)}">
    ${source.register ? `<input type="hidden" name="register" value="${escapeHtml(source.register)}">` : ""}
    ${source.memory !== undefined ? `<input type="hidden" name="memory" value="${escapeHtml(String(source.memory))}">` : ""}
    <input type="hidden" name="proposals" value="${escapeHtml(proposalsDir)}">
    <input type="hidden" name="proposal" value="${escapeHtml(proposalId)}">`;
}

export function renderProposalInbox(
  source: GlassSource,
  proposalsDir: string | undefined,
  proposals: GlassProposalCard[] = [],
  selected: GlassProposalDetail | null = null,
  preview: GlassApplyPreview | null = null,
  refused: { proposal: string; summary: string; technicalReason: string }[] = [],
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
      <td><a href="${escapeHtml(proposalsHref(source, proposalsDir ?? "", proposal.id))}">Open detail</a></td>
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
        <div><a href="${escapeHtml(reviewHref(source, proposalsDir))}">Review Queue</a></div>
        <div class="active">Proposals</div>
        <div>${proposalsDir ? `<a href="${escapeHtml(applyHref(source, proposalsDir, selectedId))}">Apply</a>` : "Apply"}</div>
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
      <form method="get" action="/proposals">
        <label>Source path
          <input name="root" value="${escapeHtml(source.root)}">
        </label>
        <label>Register
          <select name="register">
            <option value=""${source.kind === "bundle" ? " selected" : ""}>Truth bundle</option>
            <option value="estate"${source.register === "estate" ? " selected" : ""}>Estate</option>
            <option value="skills"${source.register === "skills" ? " selected" : ""}>Skills</option>
            <option value="agents"${source.register === "agents" ? " selected" : ""}>Agents</option>
            <option value="commands"${source.register === "commands" ? " selected" : ""}>Commands</option>
          </select>
        </label>
        <label>Proposals path
          <input name="proposals" value="${escapeHtml(proposalsDir ?? "")}">
        </label>
        <button type="submit">Load</button>
      </form>
      ${refused.length ? `<section class="panel detail"><h2>Refused Proposal Files</h2>${refused.map((item) => `<p><strong>${escapeHtml(item.proposal)}</strong>: ${escapeHtml(item.summary)}</p>`).join("")}</section>` : ""}
      ${proposalsDir && selectedId ? renderProposalDetail(source, proposalsDir, selected, preview) : `<section class="panel empty">Add a proposals directory to review drafted changes.</section>`}
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
  opts: { proposalId?: string; message?: string } = {},
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
        <div><a href="${escapeHtml(reviewHref(source, proposalsDir))}">Review Queue</a></div>
        <div>${proposalsDir ? `<a href="${escapeHtml(proposalsHref(source, proposalsDir, opts.proposalId))}">Proposals</a>` : "Proposals"}</div>
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
      <form method="get" action="/apply">
        <label>Source path
          <input name="root" value="${escapeHtml(source.root)}">
        </label>
        <label>Register
          <select name="register">
            <option value=""${source.kind === "bundle" ? " selected" : ""}>Truth bundle</option>
            <option value="estate"${source.register === "estate" ? " selected" : ""}>Estate</option>
            <option value="skills"${source.register === "skills" ? " selected" : ""}>Skills</option>
            <option value="agents"${source.register === "agents" ? " selected" : ""}>Agents</option>
            <option value="commands"${source.register === "commands" ? " selected" : ""}>Commands</option>
          </select>
        </label>
        <label>Proposals path
          <input name="proposals" value="${escapeHtml(proposalsDir ?? "")}">
        </label>
        <button type="submit">Preview</button>
      </form>
      ${opts.message ? `<section class="panel detail"><h2>Result</h2><p>${escapeHtml(opts.message)}</p></section>` : ""}
      ${preview ? renderSafety(preview) : `<section class="panel empty">Add a proposals directory to preview approved changes.</section>`}
      ${preview?.canWrite ? `<section class="panel detail">
        <h2>Apply Approved Changes</h2>
        <p class="muted">Type apply by pressing the button below. Glass writes through the deterministic Clerk and records the existing audit markers.</p>
        <form method="post" action="/apply/write">
          ${decisionHiddenFields(source, proposalsDir ?? "", opts.proposalId ?? "")}
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
        <div><a href="${escapeHtml(queryFor(scan, opts, { findingId: finding.id }))}">Open detail</a></div>
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
        <div>${opts.proposalsDir ? `<a href="${escapeHtml(proposalsHref(scan.source, opts.proposalsDir))}">Proposals</a>` : "Proposals"}</div>
        <div>${opts.proposalsDir ? `<a href="${escapeHtml(applyHref(scan.source, opts.proposalsDir))}">Apply</a>` : "Apply"}</div>
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

      <form method="get" action="/">
        <label>Source path
          <input name="root" value="${escapeHtml(scan.source.root)}">
        </label>
        <label>Register
          <select name="register">
            <option value=""${scan.source.kind === "bundle" ? " selected" : ""}>Truth bundle</option>
            <option value="estate"${scan.source.register === "estate" ? " selected" : ""}>Estate</option>
            <option value="skills"${scan.source.register === "skills" ? " selected" : ""}>Skills</option>
            <option value="agents"${scan.source.register === "agents" ? " selected" : ""}>Agents</option>
            <option value="commands"${scan.source.register === "commands" ? " selected" : ""}>Commands</option>
          </select>
        </label>
        <label>Memory mode
          <select name="memory">
            <option value="false"${scan.source.memory ? "" : " selected"}>Off</option>
            <option value="true"${scan.source.memory ? " selected" : ""}>On</option>
          </select>
        </label>
        ${opts.proposalsDir ? `<input type="hidden" name="proposals" value="${escapeHtml(opts.proposalsDir)}">` : ""}
        <button type="submit">Scan</button>
      </form>

      <form class="filters" method="get" action="/">
        <input type="hidden" name="root" value="${escapeHtml(scan.source.root)}">
        ${scan.source.register ? `<input type="hidden" name="register" value="${escapeHtml(scan.source.register)}">` : ""}
        ${scan.source.memory !== undefined ? `<input type="hidden" name="memory" value="${escapeHtml(String(scan.source.memory))}">` : ""}
        ${opts.proposalsDir ? `<input type="hidden" name="proposals" value="${escapeHtml(opts.proposalsDir)}">` : ""}
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

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolveRead, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 64) reject(new Error("form body too large"));
    });
    req.on("end", () => resolveRead(new URLSearchParams(body)));
    req.on("error", reject);
  });
}

function sourceFromValues(values: URLSearchParams, defaults: GlassServerOptions): RequestSource {
  const register = registerValue(values.get("register")) ?? defaults.register;
  const memory = values.has("memory") ? values.get("memory") === "true" : defaults.memory;
  const proposalsDir = values.get("proposals") || defaults.proposalsDir;
  return {
    root: values.get("root") || defaults.root,
    ...(register ? { register } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(proposalsDir ? { proposalsDir } : {}),
  };
}

function glassSourceFor(current: RequestSource): GlassSource {
  return {
    root: resolve(current.root),
    kind: current.register ? "estate" : "bundle",
    ...(current.register ? { register: current.register } : {}),
    ...(current.memory !== undefined ? { memory: current.memory } : {}),
  };
}

function decisionValue(value: string | null): GlassDecision | null {
  if (value === "approve" || value === "reject" || value === "request-edit") return value;
  return null;
}

export function createGlassServer(options: GlassServerOptions): Server {
  return createServer((req, res) => {
    void handleGlassRequest(req, res, options).catch((err) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
}

async function handleGlassRequest(req: IncomingMessage, res: ServerResponse, options: GlassServerOptions): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const current = sourceFromRequest(req, options);
    const dashboardOpts: DashboardOptions = {
      ...(current.proposalsDir ? { proposalsDir: current.proposalsDir } : {}),
      ...(url.searchParams.get("severity") ? { severity: url.searchParams.get("severity") as string } : {}),
      ...(url.searchParams.get("check") ? { check: url.searchParams.get("check") as string } : {}),
      ...(url.searchParams.get("owner") ? { owner: url.searchParams.get("owner") as string } : {}),
      ...(url.searchParams.get("finding") ? { findingId: url.searchParams.get("finding") as string } : {}),
    };
    try {
      if (url.pathname === "/proposals/decision" && req.method === "POST") {
        const form = await readForm(req);
        const posted = sourceFromValues(form, options);
        const proposalId = form.get("proposal");
        const decision = decisionValue(form.get("decision"));
        if (!posted.proposalsDir || !proposalId || !decision) throw new Error("proposal decision requires proposals, proposal, and decision");
        const by = form.get("by")?.trim();
        const note = form.get("note")?.trim();
        decideProposal(posted.proposalsDir, proposalId, decision, {
          ...(by ? { by } : {}),
          ...(note ? { note } : {}),
        });
        res.writeHead(303, { location: proposalsHref(glassSourceFor(posted), posted.proposalsDir, proposalId) });
        res.end();
        return;
      }
      if (url.pathname === "/apply/write" && req.method === "POST") {
        const form = await readForm(req);
        const posted = sourceFromValues(form, options);
        if (!posted.proposalsDir || form.get("confirm") !== "apply") throw new Error("apply write requires proposals and explicit confirmation");
        const proposalId = form.get("proposal") || undefined;
        const result = applyApproved(posted.root, {
          proposalsDir: posted.proposalsDir,
          ...(posted.register ? { register: posted.register } : {}),
          ...(proposalId ? { proposalId } : {}),
        });
        const afterPreview = previewApply(posted.root, {
          proposalsDir: posted.proposalsDir,
          ...(posted.register ? { register: posted.register } : {}),
          ...(proposalId ? { proposalId } : {}),
        });
        const source = glassSourceFor(posted);
        const audit = getAuditTrail(posted.root, {
          ...(posted.register ? { register: posted.register } : {}),
          ...(posted.memory !== undefined ? { memory: posted.memory } : {}),
        });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderApplyPage(source, posted.proposalsDir, afterPreview, audit, {
          ...(proposalId ? { proposalId } : {}),
          message: `Applied ${result.written.length} file(s).`,
        }));
        return;
      }
      if (url.pathname === "/api/scan") {
        json(res, 200, scanSurface(current.root, {
          ...(current.register ? { register: current.register } : {}),
          ...(current.memory !== undefined ? { memory: current.memory } : {}),
        }));
        return;
      }
      if (url.pathname === "/proposals") {
        const source = glassSourceFor(current);
        if (!current.proposalsDir) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(renderProposalInbox(source, undefined));
          return;
        }
        const listed = listProposals(current.proposalsDir);
        const selectedId = url.searchParams.get("proposal") || listed.proposals[0]?.id;
        const detail = selectedId ? getProposalDetail(current.proposalsDir, selectedId) : null;
        const preview = detail?.elected ? previewApply(current.root, {
          proposalsDir: current.proposalsDir,
          ...(current.register ? { register: current.register } : {}),
          proposalId: detail.id,
        }) : null;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderProposalInbox(source, current.proposalsDir, listed.proposals, detail, preview, listed.refused));
        return;
      }
      if (url.pathname === "/apply") {
        const source = glassSourceFor(current);
        if (!current.proposalsDir) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(renderApplyPage(source, undefined));
          return;
        }
        const proposalId = url.searchParams.get("proposal") || undefined;
        const preview = previewApply(current.root, {
          proposalsDir: current.proposalsDir,
          ...(current.register ? { register: current.register } : {}),
          ...(proposalId ? { proposalId } : {}),
        });
        const audit = getAuditTrail(current.root, {
          ...(current.register ? { register: current.register } : {}),
          ...(current.memory !== undefined ? { memory: current.memory } : {}),
        });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderApplyPage(source, current.proposalsDir, preview, audit, {
          ...(proposalId ? { proposalId } : {}),
        }));
        return;
      }
      if (url.pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const scan = scanSurface(current.root, {
        ...(current.register ? { register: current.register } : {}),
        ...(current.memory !== undefined ? { memory: current.memory } : {}),
      });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderGlassDashboard(scan, dashboardOpts));
    } catch (err) {
      const source: GlassSource = {
        root: resolve(current.root),
        kind: current.register ? "estate" : "bundle",
        ...(current.register ? { register: current.register } : {}),
        ...(current.memory !== undefined ? { memory: current.memory } : {}),
      };
      res.writeHead(url.pathname === "/api/scan" ? 500 : 200, {
        "content-type": url.pathname === "/api/scan" ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      });
      if (url.pathname === "/api/scan") res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      else if (url.pathname === "/proposals") res.end(renderProposalInbox(source, current.proposalsDir));
      else if (url.pathname === "/apply") res.end(renderApplyPage(source, current.proposalsDir));
      else res.end(renderError(err, source));
    }
}

export async function startGlassServer(options: GlassServerOptions): Promise<GlassServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const server = createGlassServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return { server, url: `http://${host}:${actualPort}` };
}
