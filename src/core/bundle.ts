import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, relative, dirname, posix, sep } from "node:path";
import type {
  Bundle,
  BundleLink,
  ConceptFile,
  DefinitionFile,
  EvidenceFile,
  Frontmatter,
  FrontmatterParser,
} from "../types.js";

const IGNORED_DIRS = new Set([".git", "node_modules", "demo-views", ".obsidian", "dist"]);
const EVIDENCE_DIRS = new Set(["sources", "raw"]);
const TEXT_LIKE_EXTENSIONS = [".md", ".txt", ".csv", ".json", ".yml", ".yaml"] as const;
const requireOptional = createRequire(import.meta.url);

export interface ParseFrontmatterOptions {
  parser?: FrontmatterParser;
}

export interface LoadBundleOptions {
  frontmatterParser?: FrontmatterParser;
}

/** Convert an OS path to normalised posix form with no leading "./". */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** Recursively list every file under root, repo-relative, posix-normalised. */
function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    // lstat, not stat: symlinks are SKIPPED entirely. A symlink inside an authored
    // bundle could point outside the repo (secrets, other checkouts) or create a
    // cycle - the keeper never follows them. Documented in README Boundaries.
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) walk(root, abs, out);
    } else if (st.isFile()) {
      out.push(toPosix(relative(root, abs)));
    }
  }
  return out;
}

export function isTextLikePath(p: string): boolean {
  const lower = p.toLowerCase();
  return TEXT_LIKE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function isEvidencePath(bundlePath: string): boolean {
  const [first] = bundlePath.split("/");
  return first !== undefined && EVIDENCE_DIRS.has(first);
}

/** Strip surrounding quotes. A double-quoted value with JSON-style escapes (as the proposal writer emits) is unescaped. */
function unquoteScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* not a valid escaped string: fall through to plain stripping */
    }
  }
  return raw.replace(/^["']|["']$/g, "");
}

function parseSimpleFrontmatterBlock(block: string): Frontmatter {
  const fm: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1] as string;
    const raw = (kv[2] ?? "").trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      fm[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      fm[key] = unquoteScalar(raw);
    }
  }
  return fm;
}

function coerceYamlFrontmatter(value: unknown): Frontmatter {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const fm: Frontmatter = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") fm[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") fm[key] = String(raw);
    else if (Array.isArray(raw)) fm[key] = raw.map((item) => String(item)).filter(Boolean);
    else {
      try {
        fm[key] = JSON.stringify(raw);
      } catch {
        fm[key] = String(raw);
      }
    }
  }
  return fm;
}

function parseYamlFrontmatterBlock(block: string): Frontmatter {
  let yaml: { parse: (source: string) => unknown };
  try {
    yaml = requireOptional("yaml") as { parse: (source: string) => unknown };
  } catch {
    throw new Error("optional YAML frontmatter parser is not installed; install `yaml` to use --frontmatter-parser yaml");
  }
  return coerceYamlFrontmatter(yaml.parse(block));
}

/** Parse a `--- ... ---` frontmatter block. Default mode is the flat zero-dependency parser. */
export function parseFrontmatter(content: string, options: ParseFrontmatterOptions = {}): Frontmatter | null {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // strip UTF-8 BOM
  // Fence tolerates trailing spaces/tabs: iOS predictive text appends an invisible
  // trailing space to typed lines, and Jekyll/Obsidian-style parsers accept this.
  const m = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m || m[1] === undefined) return null;
  return options.parser === "yaml" ? parseYamlFrontmatterBlock(m[1]) : parseSimpleFrontmatterBlock(m[1]);
}

/** Extract internal markdown links: [text](target), skipping http(s)/mailto/anchors/images-of-remote. */
export function extractLinks(content: string): string[] {
  const targets: string[] = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+["\'][^)]*)?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const t = m[1] as string;
    if (/^(https?:|mailto:|#)/i.test(t)) continue;
    targets.push(t.split("#")[0] as string);
  }
  return targets.filter(Boolean);
}

function withoutFencedCode(content: string): string {
  return content.replace(/^```[\s\S]*?^```[ \t]*$/gm, "");
}

/** Extract explicit local-source receipts (`[source: path]`) from prose, skipping fenced code. */
export function extractSourceReceipts(content: string): string[] {
  const receipts: string[] = [];
  const re = /\[source:\s*([^\]]+?)\s*\]/gi;
  let m: RegExpExecArray | null;
  const prose = withoutFencedCode(content);
  while ((m = re.exec(prose)) !== null) {
    const raw = (m[1] ?? "").trim();
    if (raw) receipts.push(raw);
  }
  return receipts;
}

/** Strip receipt-only suffixes before path resolution. */
export function receiptPath(raw: string): string {
  return raw.split("#")[0]?.split("@")[0]?.trim() ?? raw.trim();
}

/** Resolve a source receipt, including bundle-root shortcuts for sources/ and raw/. */
export function resolveSourceReceipt(raw: string, fromRepoRel: string, bundleRel: string): string | null {
  if (/^https?:\/\//i.test(raw)) return null;
  const target = receiptPath(raw);
  const receiptTarget = /^(sources|raw)\//.test(target) ? `/${target}` : target;
  return resolveLink(receiptTarget, fromRepoRel, bundleRel);
}

/**
 * Resolve a link target to a repo-relative path.
 * Root-style targets ("/metrics/foo.md") resolve against the BUNDLE root - the OKF convention.
 * Relative targets resolve against the linking file's directory.
 */
export function resolveLink(target: string, fromRepoRel: string, bundleRel: string): string | null {
  try {
    target = decodeURIComponent(target);
  } catch {
    /* malformed escape - use as written */
  }
  let resolved: string;
  if (target.startsWith("/")) {
    resolved = posix.join(bundleRel, target.slice(1));
  } else {
    resolved = posix.join(posix.dirname(fromRepoRel), target);
  }
  resolved = posix.normalize(resolved);
  if (resolved.startsWith("..")) return null; // escapes the repo - cannot verify
  return resolved;
}

/** Extract an owner display name from an "**Owner.**" / "**Owner / on-call.**" line or frontmatter. */
export function extractOwner(content: string, fm: Frontmatter | null): string | null {
  if (fm && typeof fm["owner"] === "string" && fm["owner"]) return fm["owner"];
  const line = content.match(/^\*\*Owner[^*]*\.?\*\*\s*(.+)$/m);
  if (!line || !line[1]) return null;
  const rest = line[1].trim();
  const linkText = rest.match(/\[([^\]]+)\]/);
  if (linkText && linkText[1]) return linkText[1];
  const plain = rest.split(/[(.]/)[0]?.trim();
  if (!plain || plain.length <= 1) return null;
  if (/^(tbd|n\/a|na|todo|unassigned|none|\?+)$/i.test(plain)) return null; // placeholders are not owners
  return plain;
}

/** Pull meta.owner / concept back-reference out of a definitions YAML without a YAML dependency. */
export function parseDefinition(content: string): { owner: string | null; conceptRef: string | null } {
  const owner = content.match(/^\s*owner:\s*["']?([^"'\n]+)["']?\s*$/m);
  const concept = content.match(/^\s*concept:\s*["']?([^"'\n]+)["']?\s*$/m);
  return {
    owner: owner && owner[1] ? owner[1].trim() : null,
    conceptRef: concept && concept[1] ? concept[1].trim() : null,
  };
}

/**
 * Load a bundle. `inputPath` may be the bundle folder itself (contains index.md)
 * or a repo root containing a `bundle/` folder.
 */
export function loadBundle(inputPath: string, options: LoadBundleOptions = {}): Bundle {
  const abs = resolve(inputPath);
  let bundleAbs: string;
  if (existsSync(join(abs, "index.md"))) {
    bundleAbs = abs;
  } else if (existsSync(join(abs, "bundle", "index.md"))) {
    bundleAbs = join(abs, "bundle");
  } else {
    throw new Error(`No bundle found at ${abs} - expected index.md or bundle/index.md`);
  }
  // Repo root is the bundle's parent when the bundle is a subfolder, so sibling
  // folders (synthetic-data/, docs/) stay resolvable; otherwise the bundle stands alone.
  const repoRoot = bundleAbs === abs ? abs : resolve(bundleAbs, "..");
  const bundleRel = toPosix(relative(repoRoot, bundleAbs)); // "" when equal

  const repoFiles = new Set(walk(repoRoot));

  const concepts: ConceptFile[] = [];
  const definitions: DefinitionFile[] = [];
  const evidenceFiles: EvidenceFile[] = [];
  const inBundle = (p: string) => (bundleRel === "" ? true : p.startsWith(bundleRel + "/"));

  for (const p of repoFiles) {
    if (!inBundle(p)) continue;
    const isMd = p.endsWith(".md");
    const bundlePath = bundleRel === "" ? p : p.slice(bundleRel.length + 1);
    // Only YAML under a definitions/ folder is treated as a governed definition -
    // stray linter/editor configs elsewhere in the bundle are not definitions.
    const isDef = (p.endsWith(".yml") || p.endsWith(".yaml")) && /(^|\/)definitions\//.test(bundlePath);
    const isEvidence = isEvidencePath(bundlePath) && isTextLikePath(bundlePath);
    if (!isMd && !isDef && !isEvidence) continue;
    let content: string;
    try {
      content = readFileSync(join(repoRoot, p), "utf8");
    } catch {
      continue; // unreadable file - skip rather than kill the patrol
    }
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    if (isEvidence) {
      evidenceFiles.push({ path: p, bundlePath, content });
      continue;
    }
    if (isMd) {
      const frontmatter = parseFrontmatter(
        content,
        options.frontmatterParser ? { parser: options.frontmatterParser } : {},
      );
      const links: BundleLink[] = extractLinks(content).map((target) => ({
        target,
        resolved: resolveLink(target, p, bundleRel),
      }));
      concepts.push({ path: p, bundlePath, content, frontmatter, links, owner: extractOwner(content, frontmatter) });
    } else {
      const { owner, conceptRef } = parseDefinition(content);
      definitions.push({ path: p, bundlePath, content, owner, conceptRef });
    }
  }

  return { repoRoot, bundleRel, concepts, definitions, evidenceFiles, repoFiles };
}
