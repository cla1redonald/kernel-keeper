import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { extractSourceReceipts, isTextLikePath, loadBundle, resolveLink, resolveSourceReceipt } from "./core/bundle.js";
import { loadEstate } from "./core/estate.js";
import { lifecycleStatus, scalar, stringList } from "./core/governance.js";
import type { Bundle, Estate, RegisterKind, RegisterMode } from "./types.js";

export type VerifyMode = "bundle" | "estate";

export interface VerifyItemSnapshot {
  path: string;
  kind: "concept" | "definition" | RegisterKind;
  hash: string;
  evidenceRefs: string[];
  inboundRefs?: string[];
  lifecycleStatus?: string;
  archiveNote?: boolean;
  supersededBy?: string | null;
}

export interface VerifySnapshot {
  version: 1;
  mode: VerifyMode;
  createdAt: string;
  rootLabel: string;
  items: VerifyItemSnapshot[];
}

export interface VerifyResult {
  baseline: VerifySnapshot;
  current: VerifySnapshot;
  missing: string[];
  changed: string[];
  newItems: string[];
  unresolvedEvidence: Array<{ path: string; ref: string }>;
  archiveContinuity: Array<{ path: string; reason: string }>;
  damaged: Array<{ path: string; reasons: string[] }>;
  damageFraction: number;
  threshold: number;
  ok: boolean;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function stripAnchor(raw: string): string {
  return raw.split("#")[0]?.trim() ?? raw.trim();
}

function bundleEvidenceRefs(bundle: Bundle, c: Bundle["concepts"][number]): string[] {
  const refs: string[] = [];
  for (const l of c.links) {
    if (l.resolved && bundle.repoFiles.has(l.resolved) && isTextLikePath(l.resolved)) refs.push(l.resolved);
  }
  for (const raw of extractSourceReceipts(c.content)) {
    const resolved = resolveSourceReceipt(raw, c.path, bundle.bundleRel);
    if (resolved && bundle.repoFiles.has(resolved) && isTextLikePath(resolved)) refs.push(resolved);
  }
  for (const key of ["source", "generated-from"]) {
    for (const raw of stringList(c.frontmatter, key)) {
      const target = stripAnchor(raw);
      const candidates = key === "source" && !target.startsWith("/") ? [target, `/${target}`] : [target];
      for (const candidate of candidates) {
        const resolved = key === "source"
          ? resolveSourceReceipt(candidate, c.path, bundle.bundleRel)
          : resolveLink(candidate, c.path, bundle.bundleRel);
        if (resolved && bundle.repoFiles.has(resolved) && isTextLikePath(resolved)) refs.push(resolved);
      }
    }
  }
  return uniqueSorted(refs.filter((p) => p !== c.path));
}

function bundleInboundRefs(bundle: Bundle): Map<string, string[]> {
  const inbound = new Map<string, string[]>();
  for (const c of bundle.concepts) {
    for (const l of c.links) {
      if (!l.resolved) continue;
      const refs = inbound.get(l.resolved) ?? [];
      refs.push(c.path);
      inbound.set(l.resolved, refs);
    }
  }
  for (const [path, refs] of inbound) inbound.set(path, uniqueSorted(refs));
  return inbound;
}

export function snapshotBundle(root: string, now = new Date()): VerifySnapshot {
  const bundle = loadBundle(root);
  const inbound = bundleInboundRefs(bundle);
  const items: VerifyItemSnapshot[] = [
    ...bundle.concepts.map((c) => ({
      path: c.path,
      kind: "concept" as const,
      hash: sha256(c.content),
      evidenceRefs: bundleEvidenceRefs(bundle, c),
      inboundRefs: inbound.get(c.path) ?? [],
      lifecycleStatus: lifecycleStatus(c.frontmatter),
      archiveNote: scalar(c.frontmatter, "archive-note") !== null,
      supersededBy: scalar(c.frontmatter, "superseded-by"),
    })),
    ...bundle.definitions.map((d) => ({
      path: d.path,
      kind: "definition" as const,
      hash: sha256(d.content),
      evidenceRefs: [] as string[],
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, mode: "bundle", createdAt: now.toISOString(), rootLabel: bundle.bundleRel || ".", items };
}

export function snapshotEstate(root: string, register: RegisterMode, now = new Date()): VerifySnapshot {
  const estate = loadEstate(root, register);
  const items: VerifyItemSnapshot[] = estate.items
    .map((i) => ({
      path: i.path,
      kind: i.register,
      hash: sha256(i.content ?? ""),
      evidenceRefs: uniqueSorted(i.pathRefs.filter((r) => r.exists).map((r) => r.raw)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { version: 1, mode: "estate", createdAt: now.toISOString(), rootLabel: estate.mode, items };
}

export function snapshotRoot(root: string, opts: { register?: RegisterMode; now?: Date } = {}): VerifySnapshot {
  return opts.register ? snapshotEstate(root, opts.register, opts.now) : snapshotBundle(root, opts.now);
}

function currentSurface(root: string, opts: { register?: RegisterMode }): Bundle | Estate {
  return opts.register ? loadEstate(root, opts.register) : loadBundle(root);
}

function evidenceStillResolves(surface: Bundle | Estate, mode: VerifyMode, ownerPath: string, ref: string): boolean {
  if (mode === "bundle") return (surface as Bundle).repoFiles.has(ref);
  const item = (surface as Estate).items.find((i) => i.path === ownerPath);
  return item?.pathRefs.some((r) => r.raw === ref && r.exists) ?? false;
}

export function compareSnapshots(
  root: string,
  baseline: VerifySnapshot,
  opts: { register?: RegisterMode; threshold?: number; now?: Date } = {},
): VerifyResult {
  const mode: VerifyMode = opts.register ? "estate" : "bundle";
  if (baseline.mode !== mode) throw new Error(`baseline mode is ${baseline.mode}, but current mode is ${mode}`);
  const snapshotOpts = { ...(opts.register ? { register: opts.register } : {}), ...(opts.now ? { now: opts.now } : {}) };
  const current = snapshotRoot(root, snapshotOpts);
  const surface = currentSurface(root, opts);
  const byCurrent = new Map(current.items.map((i) => [i.path, i]));
  const byBaseline = new Map(baseline.items.map((i) => [i.path, i]));
  const missing: string[] = [];
  const changed: string[] = [];
  const unresolvedEvidence: Array<{ path: string; ref: string }> = [];
  const archiveContinuity: Array<{ path: string; reason: string }> = [];
  const damagedByPath = new Map<string, string[]>();

  const damage = (path: string, reason: string) => {
    const reasons = damagedByPath.get(path) ?? [];
    reasons.push(reason);
    damagedByPath.set(path, reasons);
  };

  for (const before of baseline.items) {
    const after = byCurrent.get(before.path);
    if (!after) {
      missing.push(before.path);
      damage(before.path, "missing");
      continue;
    }
    if (after.hash !== before.hash || after.kind !== before.kind) {
      changed.push(before.path);
      damage(before.path, "changed");
    }
    for (const ref of before.evidenceRefs) {
      if (!evidenceStillResolves(surface, mode, before.path, ref)) {
        unresolvedEvidence.push({ path: before.path, ref });
        damage(before.path, `unresolved evidence: ${ref}`);
      }
    }
    if (
      mode === "bundle" &&
      before.lifecycleStatus === "archived" &&
      (before.inboundRefs?.length ?? 0) > 0 &&
      (after.inboundRefs?.length ?? 0) === 0 &&
      !after.archiveNote &&
      !after.supersededBy
    ) {
      const reason = "archived item lost every retrieval path without replacement or archive note";
      archiveContinuity.push({ path: before.path, reason });
      damage(before.path, reason);
    }
  }

  const newItems = current.items.filter((i) => !byBaseline.has(i.path)).map((i) => i.path).sort();
  const damaged = [...damagedByPath.entries()]
    .map(([path, reasons]) => ({ path, reasons: uniqueSorted(reasons) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const threshold = opts.threshold ?? 0;
  const damageFraction = baseline.items.length === 0 ? 0 : damaged.length / baseline.items.length;
  return {
    baseline,
    current,
    missing: missing.sort(),
    changed: changed.sort(),
    newItems,
    unresolvedEvidence: unresolvedEvidence.sort((a, b) => a.path.localeCompare(b.path) || a.ref.localeCompare(b.ref)),
    archiveContinuity: archiveContinuity.sort((a, b) => a.path.localeCompare(b.path)),
    damaged,
    damageFraction,
    threshold,
    ok: damageFraction <= threshold,
  };
}

function splitGeneratorCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("empty verify generator command");
  if (/[|&;<>()$`\\\n\r]/.test(trimmed)) {
    throw new Error(`verify generator uses unsupported shell syntax: ${command}`);
  }
  return trimmed.split(/\s+/);
}

export function runVerifyGenerators(commands: string[], cwd: string): void {
  for (const command of commands) {
    const [bin, ...args] = splitGeneratorCommand(command);
    if (!bin) throw new Error("empty verify generator command");
    execFileSync(bin, args, { cwd: resolve(cwd), stdio: "inherit" });
  }
}

export function readVerifySnapshot(path: string): VerifySnapshot {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as VerifySnapshot;
  if (parsed.version !== 1 || (parsed.mode !== "bundle" && parsed.mode !== "estate") || !Array.isArray(parsed.items)) {
    throw new Error(`not a kernel-keeper verify baseline: ${path}`);
  }
  return parsed;
}

export function writeVerifySnapshot(path: string, snapshot: VerifySnapshot): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(snapshot, null, 2)}\n`);
}
