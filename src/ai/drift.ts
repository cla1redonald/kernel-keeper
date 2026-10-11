import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";
import { loadBundle, extractLinks, extractSourceReceipts, isTextLikePath, resolveSourceReceipt } from "../core/bundle.js";
import { loadEstate } from "../core/estate.js";
import { stringList } from "../core/governance.js";
import type { Bundle, Estate, EstateItem, RegisterMode } from "../types.js";
import { createMessage, runWithConcurrency } from "./client.js";
import { assembleDriftPrompt, DRIFT_SCHEMA } from "./prompts.js";
import { buildProvenance, proposalIdFor, stampJournalLine } from "./provenance.js";
import { assertOutDirSafe, proposalExists, proposalPath, readFetchedSourceCache, writeFetchedSourceCache, writeProposal } from "./proposal.js";
import { assertShape, DRIFT_RESPONSE_SPEC } from "./validate.js";
import type { AgentRunResult, Confidence, ProposalDraft } from "./types.js";

const TEXT_EXT = new Set([".md", ".yml", ".yaml", ".json", ".csv", ".txt"]);

export interface DriftSource {
  path: string;
  content: string;
}

export interface DriftJob {
  target: DriftSource;
  sources: DriftSource[];
}

export interface DriftReviewOptions {
  outDir: string;
  model: string;
  apiKey: string;
  register?: RegisterMode;
  dryRun?: boolean;
  force?: boolean;
  allowInRepo?: boolean;
  concurrency?: number;
  maxTokens?: number;
  memory?: boolean;
  fetchSources?: boolean;
  fetchCacheDir?: string;
  fetchCacheMaxAgeHours?: number;
  maxFetchBytes?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: Date;
  log?: (msg: string) => void;
}

interface ExternalSourceRef {
  target: DriftSource;
  urls: string[];
}

function extnamePosix(path: string): string {
  const base = posix.basename(path);
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i).toLowerCase() : "";
}

function isTextLike(path: string): boolean {
  return TEXT_EXT.has(extnamePosix(path));
}

function readRepoFile(root: string, rel: string): string | null {
  if (!isTextLike(rel)) return null;
  const abs = resolve(root, rel);
  try {
    if (!existsSync(abs) || !lstatSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function validBundleSourcePaths(bundle: Bundle, paths: string[]): string[] {
  return uniqueSorted(paths).filter((p) => bundle.repoFiles.has(p) && isTextLikePath(p));
}

function memorySourcePaths(bundle: Bundle, c: Bundle["concepts"][number]): string[] {
  const receipts = extractSourceReceipts(c.content)
    .map((raw) => resolveSourceReceipt(raw, c.path, bundle.bundleRel))
    .filter((p): p is string => !!p);
  if (receipts.length > 0) return validBundleSourcePaths(bundle, receipts);

  const frontmatterSources = stringList(c.frontmatter, "source").flatMap((raw) => {
    const candidates = [raw];
    if (!raw.startsWith("/")) candidates.push(`/${raw}`);
    return candidates.map((candidate) => resolveSourceReceipt(candidate, c.path, bundle.bundleRel)).filter((p): p is string => !!p);
  });
  return validBundleSourcePaths(bundle, frontmatterSources);
}

function declaredExternalSources(c: Bundle["concepts"][number]): string[] {
  return uniqueSorted(stringList(c.frontmatter, "source").filter((raw) => /^https?:\/\//i.test(raw)));
}

export function collectBundleDriftJobs(bundle: Bundle, opts: { memory?: boolean } = {}): DriftJob[] {
  const jobs: DriftJob[] = [];
  for (const c of bundle.concepts) {
    if (c.bundlePath === "index.md" || c.bundlePath === "log.md") continue;
    const memorySources = opts.memory ? memorySourcePaths(bundle, c) : [];
    const sourcePaths = memorySources.length > 0
      ? memorySources
      : uniqueSorted(c.links.map((l) => l.resolved).filter((p): p is string => !!p));
    const sources = sourcePaths
      .filter((p) => p !== c.path && bundle.repoFiles.has(p) && isTextLike(p))
      .sort()
      .map((p) => {
        const content = readRepoFile(bundle.repoRoot, p);
        return content === null ? null : { path: p, content };
      })
      .filter((s): s is DriftSource => s !== null);
    if (sources.length > 0) jobs.push({ target: { path: c.path, content: c.content }, sources });
  }
  return jobs.sort((a, b) => a.target.path.localeCompare(b.target.path));
}

export function collectBundleExternalSourceRefs(bundle: Bundle): ExternalSourceRef[] {
  const refs: ExternalSourceRef[] = [];
  for (const c of bundle.concepts) {
    if (c.bundlePath === "index.md" || c.bundlePath === "log.md") continue;
    const urls = declaredExternalSources(c);
    if (urls.length > 0) refs.push({ target: { path: c.path, content: c.content }, urls });
  }
  return refs.sort((a, b) => a.target.path.localeCompare(b.target.path));
}

function authoredItems(estate: Estate): EstateItem[] {
  return estate.items.filter((i) => !i.thirdParty && i.content !== null);
}

function resolveEstateLink(target: string, fromPath: string): string | null {
  if (/^(https?:|mailto:|#|~|\$HOME\/)/i.test(target)) return null;
  const clean = target.split("#")[0]?.trim();
  if (!clean || isAbsolute(clean)) return null;
  return posix.normalize(posix.join(posix.dirname(fromPath), clean));
}

export function collectEstateDriftJobs(estate: Estate): DriftJob[] {
  const items = authoredItems(estate);
  const byPath = new Map(items.map((i) => [i.path, i]));
  const jobs: DriftJob[] = [];
  for (const i of items) {
    const content = i.content as string;
    const sources = [...new Set(extractLinks(content).map((raw) => resolveEstateLink(raw, i.path)).filter((p): p is string => !!p))]
      .filter((p) => p !== i.path && isTextLike(p))
      .sort()
      .map((p) => {
        const item = byPath.get(p);
        if (item?.content !== null && item?.content !== undefined) return { path: p, content: item.content };
        const fileContent = readRepoFile(estate.root, p);
        return fileContent === null ? null : { path: p, content: fileContent };
      })
      .filter((s): s is DriftSource => s !== null);
    if (sources.length > 0) jobs.push({ target: { path: i.path, content }, sources });
  }
  return jobs.sort((a, b) => a.target.path.localeCompare(b.target.path));
}

function loadDriftSurface(inputPath: string, register?: RegisterMode, memory = false): { jobs: DriftJob[]; externalRefs: ExternalSourceRef[]; root: string; repoRoot: string } {
  if (register) {
    const estate = loadEstate(inputPath, register);
    return { jobs: collectEstateDriftJobs(estate), externalRefs: [], root: estate.root, repoRoot: estate.root };
  }
  const bundle = loadBundle(inputPath);
  const bundleRoot = bundle.bundleRel === "" ? bundle.repoRoot : resolve(bundle.repoRoot, bundle.bundleRel);
  return { jobs: collectBundleDriftJobs(bundle, { memory }), externalRefs: collectBundleExternalSourceRefs(bundle), root: bundleRoot, repoRoot: bundle.repoRoot };
}

async function fetchExternalSource(url: string, repoRoot: string, bundleRoot: string, opts: DriftReviewOptions, now: Date): Promise<DriftSource> {
  const cacheDir = opts.fetchCacheDir ?? ".kernel-keeper/drift-cache";
  if (opts.fetchCacheMaxAgeHours !== undefined) {
    const cached = readFetchedSourceCache({
      repoRoot,
      bundleRoot,
      cacheDir,
      url,
      now,
      maxAgeHours: opts.fetchCacheMaxAgeHours,
    });
    if (cached) {
      opts.log?.(`drift-reviewer: reusing cached fetched source ${url} (${cached.path})`);
      return { path: cached.path, content: cached.content };
    }
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(url);
  const status = res.status;
  if (!res.ok) throw new Error(`fetch ${url} failed with HTTP ${status}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/^(text\/|application\/(json|yaml|x-yaml))/i.test(contentType)) {
    throw new Error(`fetch ${url} returned unsupported content-type ${contentType}`);
  }
  const content = await res.text();
  const maxBytes = opts.maxFetchBytes ?? 200_000;
  if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error(`fetch ${url} exceeded ${maxBytes} bytes`);
  const cached = writeFetchedSourceCache({
    repoRoot,
    bundleRoot,
    cacheDir,
    url,
    status,
    contentType,
    fetchedAt: now,
    content,
  });
  return { path: cached.path, content };
}

async function augmentWithFetchedSources(surface: { jobs: DriftJob[]; externalRefs: ExternalSourceRef[]; root: string; repoRoot: string }, opts: DriftReviewOptions, now: Date, log: (msg: string) => void): Promise<DriftJob[]> {
  if (!opts.fetchSources) return surface.jobs;
  if (opts.register) throw new Error("--fetch-sources only applies to bundle mode");
  const byTarget = new Map(surface.jobs.map((j) => [j.target.path, { target: j.target, sources: [...j.sources] }]));
  if (opts.dryRun) {
    for (const ref of surface.externalRefs) {
      const job = byTarget.get(ref.target.path) ?? { target: ref.target, sources: [] };
      for (const url of ref.urls) {
        let reused = false;
        if (opts.fetchCacheMaxAgeHours !== undefined) {
          const cached = readFetchedSourceCache({
            repoRoot: surface.repoRoot,
            bundleRoot: surface.root,
            cacheDir: opts.fetchCacheDir ?? ".kernel-keeper/drift-cache",
            url,
            now,
            maxAgeHours: opts.fetchCacheMaxAgeHours,
          });
          if (cached) {
            log(`drift-reviewer --dry-run: would reuse cached fetched source ${url} (${cached.path}) for ${ref.target.path}`);
            job.sources.push({ path: cached.path, content: cached.content });
            reused = true;
          }
        }
        if (!reused) log(`drift-reviewer --dry-run: would fetch ${url} for ${ref.target.path}`);
      }
      byTarget.set(ref.target.path, job);
    }
    return [...byTarget.values()].filter((j) => j.sources.length > 0).sort((a, b) => a.target.path.localeCompare(b.target.path));
  }
  for (const ref of surface.externalRefs) {
    const job = byTarget.get(ref.target.path) ?? { target: ref.target, sources: [] };
    for (const url of ref.urls) job.sources.push(await fetchExternalSource(url, surface.repoRoot, surface.root, opts, now));
    byTarget.set(ref.target.path, job);
  }
  return [...byTarget.values()].filter((j) => j.sources.length > 0).sort((a, b) => a.target.path.localeCompare(b.target.path));
}

export async function runDriftReview(inputPath: string, opts: DriftReviewOptions): Promise<AgentRunResult> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? new Date();
  const surface = loadDriftSurface(inputPath, opts.register, opts.memory ?? false);
  assertOutDirSafe(opts.outDir, surface.root, surface.repoRoot, opts.allowInRepo ?? false, log);
  const jobs = await augmentWithFetchedSources(surface, opts, now, log);

  const result: AgentRunResult = { written: [], skippedExisting: [], failed: [], usageTotals: { input: 0, output: 0 } };
  if (jobs.length === 0) {
    log("drift-reviewer: nothing to compare - no resolved outbound text references.");
    return result;
  }

  const prepared = jobs.map((job) => {
    const prompt = assembleDriftPrompt(job.target, job.sources);
    const id = proposalIdFor("drift-reviewer", [job.target.path, ...job.sources.map((s) => s.path)]);
    return { job, prompt, id };
  });

  const pending = prepared.filter((p) => {
    if (opts.force) return true;
    if (proposalExists(opts.outDir, p.id)) {
      result.skippedExisting.push(proposalPath(opts.outDir, p.id));
      return false;
    }
    return true;
  });

  if (opts.dryRun) {
    for (const p of prepared) {
      log(`--- drift-reviewer job ${p.id} (${p.job.target.path}) - est ~${estimate(p.prompt.system + p.prompt.user)} input tokens`);
      log(`[system]\n${p.prompt.system}\n[user]\n${p.prompt.user}`);
    }
    log(`drift-reviewer --dry-run: ${prepared.length} job(s), zero API calls made.`);
    return result;
  }

  if (pending.length === 0) {
    log(`drift-reviewer: all ${prepared.length} job(s) already have pending proposals - nothing to draft, zero API calls.`);
    return result;
  }
  log(`drift-reviewer: ${pending.length} job(s) to draft (est ~${pending.reduce((n, p) => n + estimate(p.prompt.system + p.prompt.user), 0)} input tokens total).`);

  const settled = await runWithConcurrency(opts.concurrency ?? 3, pending.map((p) => async () => {
    const res = await createMessage(
      { system: p.prompt.system, user: p.prompt.user, schema: DRIFT_SCHEMA, maxTokens: opts.maxTokens ?? 8192 },
      { apiKey: opts.apiKey, model: opts.model, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}), ...(opts.sleepFn ? { sleepFn: opts.sleepFn } : {}) },
    );
    assertShape(res.json, DRIFT_RESPONSE_SPEC, `drift:${p.id}`);
    const r = res.json as {
      summary: string; rationale: string;
      frontmatterPatch: { key: string; value: string }[] | null; bodyDraft: string | null;
      journalLine: string; confidence: Confidence;
      evidenceQuotes: { file: string; quote: string }[];
    };
    const draft: ProposalDraft = {
      id: p.id,
      kind: "amend",
      target: p.job.target.path,
      summary: r.summary,
      rationale: r.rationale,
      frontmatterPatch: r.frontmatterPatch
        ? Object.fromEntries(r.frontmatterPatch.map((kv) => [kv.key, kv.value]))
        : null,
      bodyDraft: r.bodyDraft,
      journalLine: stampJournalLine(r.journalLine, p.id),
      indexEntry: null,
      confidence: r.confidence,
      evidenceQuotes: r.evidenceQuotes,
      needsHuman: true,
      checks: ["semantic-drift"],
    };
    const prov = buildProvenance({
      agent: "drift-reviewer", model: opts.model, system: p.prompt.system, user: p.prompt.user,
      evidenceFiles: [p.job.target.path, ...p.job.sources.map((s) => s.path)],
      reviewedSurfaceFiles: [p.job.target, ...p.job.sources],
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens }, now,
    });
    result.usageTotals.input += res.usage.input_tokens;
    result.usageTotals.output += res.usage.output_tokens;
    return writeProposal(opts.outDir, draft, prov, opts.force ?? false, { repoRoot: surface.repoRoot, surfaceRoot: surface.root });
  }));

  settled.forEach((s, i) => {
    const p = pending[i] as (typeof pending)[number];
    if (s.status === "fulfilled") {
      if (s.value.skipped) result.skippedExisting.push(s.value.path);
      else result.written.push(s.value.path);
    } else {
      result.failed.push({ cluster: p.id, error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
    }
  });
  log(`drift-reviewer: ${result.written.length} written, ${result.skippedExisting.length} skipped (existing), ${result.failed.length} failed. Usage: ${result.usageTotals.input}+${result.usageTotals.output} tokens.`);
  return result;
}

function estimate(s: string): number {
  return Math.ceil(s.length / 3.2);
}
