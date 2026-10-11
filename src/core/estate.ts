import { readdirSync, lstatSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative, dirname, sep, posix } from "node:path";
import { parseFrontmatter } from "./bundle.js";
import type {
  Estate,
  EstateItem,
  Frontmatter,
  FrontmatterParser,
  PathRef,
  RegisterKind,
  RegisterMode,
} from "../types.js";

const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".obsidian"]);
/** How deep to look inside a plugin for skills/commands before giving up. */
const PLUGIN_WALK_DEPTH = 6;
const DISCOVERY_IGNORED_DIRS = new Set([...IGNORED_DIRS, "coverage"]);
const DISCOVERY_ALLOWED_HIDDEN_DIRS = new Set([".agents", ".claude", ".claude-plugin", ".codex"]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Extract path references from an item body: `~/…` and `$HOME/…` tokens plus
 * relative markdown links. Existence is resolved HERE, at load time, so the
 * checks stay pure. Placeholder-looking refs (globs, template vars) are skipped.
 */
export function extractPathRefs(content: string, itemDirAbs: string, home: string): PathRef[] {
  // Prose only: fenced blocks and inline code spans are overwhelmingly *examples*
  // ("point it at ~/vaults/my-project") - extracting refs from them is pure noise.
  content = content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const refs: PathRef[] = [];
  const seen = new Set<string>();
  const push = (raw: string, abs: string): void => {
    if (seen.has(raw)) return;
    seen.add(raw);
    refs.push({ raw, exists: existsSync(abs) });
  };

  const HOMEY = /(?:~|\$HOME)\/[A-Za-z0-9_@][A-Za-z0-9_@./+-]*/g;
  let m: RegExpExecArray | null;
  while ((m = HOMEY.exec(content)) !== null) {
    let raw = m[0] as string;
    raw = raw.replace(/[).,;:!?'"”’]+$/, ""); // strip trailing prose punctuation
    if (/[*{<>]|\.{3}/.test(raw)) continue; // globs / template placeholders - not real paths
    // A ref the regex had to stop mid-token on (glob/placeholder char follows) is not a real path.
    const next = content[m.index + (m[0] as string).length];
    if (raw.endsWith("/") || next === "*" || next === "{") continue;
    const rel = raw.replace(/^(?:~|\$HOME)\//, "");
    push(raw, join(home, rel));
  }

  // Relative markdown links resolve against the item's own directory.
  const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
  while ((m = LINK.exec(content)) !== null) {
    const t = m[1] as string;
    if (/^(https?:|mailto:|#|\/|~|\$)/i.test(t)) continue; // homey/absolute handled above; anchors/URLs never
    const clean = (t.split("#")[0] as string).trim();
    if (!clean || /[*{<>]/.test(clean)) continue;
    push(clean, join(itemDirAbs, clean));
  }
  return refs;
}

function readItemFile(
  abs: string,
  frontmatterParser?: FrontmatterParser,
): { content: string; frontmatter: Frontmatter | null; mtime: Date } | null {
  let content: string;
  let mtime: Date;
  try {
    content = readFileSync(abs, "utf8");
    mtime = lstatSync(abs).mtime;
  } catch {
    return null; // unreadable - treated as missing rather than killing the patrol
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  return {
    content,
    frontmatter: parseFrontmatter(content, frontmatterParser ? { parser: frontmatterParser } : {}),
    mtime,
  };
}

function ownerOf(fm: Frontmatter | null): string | null {
  const o = fm?.["owner"];
  return typeof o === "string" && o ? o : null;
}

function listDirs(root: string): string[] {
  return readdirSync(root).filter((e) => {
    if (e.startsWith(".") || IGNORED_DIRS.has(e)) return false;
    const st = lstatSync(join(root, e));
    return st.isDirectory() && !st.isSymbolicLink();
  });
}

function listMd(root: string): string[] {
  return readdirSync(root).filter((e) => {
    if (e.startsWith(".") || !e.endsWith(".md")) return false;
    const st = lstatSync(join(root, e));
    return st.isFile();
  });
}

/** Load one skills folder (dirs each expected to hold SKILL.md). */
function loadSkills(
  skillsAbs: string,
  estateRoot: string,
  home: string,
  thirdParty: boolean,
  frontmatterParser?: FrontmatterParser,
): EstateItem[] {
  const items: EstateItem[] = [];
  for (const dir of listDirs(skillsAbs)) {
    const skillAbs = join(skillsAbs, dir);
    const fileAbs = join(skillAbs, "SKILL.md");
    // lstat, not existsSync: a symlinked SKILL.md (plausible in a third-party plugin
    // cache) must be treated as missing, never read through - same invariant as the
    // bundle walker. Real files only.
    let isRealFile = false;
    try {
      isRealFile = lstatSync(fileAbs).isFile();
    } catch {
      /* missing */
    }
    const relPath = toPosix(relative(estateRoot, isRealFile ? fileAbs : skillAbs));
    const read = isRealFile ? readItemFile(fileAbs, frontmatterParser) : null;
    items.push({
      path: relPath,
      register: "skill",
      name: dir,
      content: read?.content ?? null,
      frontmatter: read?.frontmatter ?? null,
      mtime: read?.mtime ?? null,
      pathRefs: read ? extractPathRefs(read.content, skillAbs, home) : [],
      owner: ownerOf(read?.frontmatter ?? null),
      thirdParty,
    });
  }
  return items;
}

/** Load a flat folder of markdown items (agents/ or commands/). */
function loadMdRegister(
  dirAbs: string,
  estateRoot: string,
  register: RegisterKind,
  home: string,
  thirdParty: boolean,
  frontmatterParser?: FrontmatterParser,
): EstateItem[] {
  const items: EstateItem[] = [];
  for (const f of listMd(dirAbs)) {
    const abs = join(dirAbs, f);
    const read = readItemFile(abs, frontmatterParser);
    items.push({
      path: toPosix(relative(estateRoot, abs)),
      register,
      name: f.replace(/\.md$/, ""),
      content: read?.content ?? null,
      frontmatter: read?.frontmatter ?? null,
      mtime: read?.mtime ?? null,
      pathRefs: read ? extractPathRefs(read.content, dirAbs, home) : [],
      owner: ownerOf(read?.frontmatter ?? null),
      thirdParty,
    });
  }
  return items;
}

/** Find skills/commands/agents nested anywhere inside a plugin, bounded depth. */
function walkPlugin(pluginAbs: string, estateRoot: string, home: string, frontmatterParser?: FrontmatterParser): EstateItem[] {
  const items: EstateItem[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > PLUGIN_WALK_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") || IGNORED_DIRS.has(e)) continue;
      const abs = join(dir, e);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (!st.isDirectory()) continue;
      if (e === "skills") items.push(...loadSkills(abs, estateRoot, home, true, frontmatterParser));
      else if (e === "commands") items.push(...loadMdRegister(abs, estateRoot, "command", home, true, frontmatterParser));
      else if (e === "agents") items.push(...loadMdRegister(abs, estateRoot, "agent", home, true, frontmatterParser));
      else visit(abs, depth + 1);
    }
  };
  visit(pluginAbs, 0);
  return items;
}

/** Load a plugins folder: each top-level dir is a plugin container plus its nested items. */
function loadPlugins(
  pluginsAbs: string,
  estateRoot: string,
  home: string,
  frontmatterParser?: FrontmatterParser,
): EstateItem[] {
  const items: EstateItem[] = [];
  for (const dir of listDirs(pluginsAbs)) {
    const pluginAbs = join(pluginsAbs, dir);
    const nested = walkPlugin(pluginAbs, estateRoot, home, frontmatterParser);
    // The container item itself: `content === null` + zero nested items ⇒ plugin-shape finding.
    items.push({
      path: toPosix(relative(estateRoot, pluginAbs)),
      register: "plugin",
      name: dir,
      content: nested.length > 0 ? "" : null,
      frontmatter: null,
      mtime: null,
      pathRefs: [],
      owner: null,
      thirdParty: true,
    });
    items.push(...nested);
  }
  return items;
}

export interface LoadEstateOptions {
  /** Home directory used to resolve `~/…` refs (injectable for tests). */
  homeDir?: string;
  frontmatterParser?: FrontmatterParser;
}

export interface DiscoverEstateOptions extends LoadEstateOptions {
  /** Maximum directory depth below `searchRoot` to inspect. Default: 3. */
  maxDepth?: number;
}

/**
 * Load a procedure estate. For single-register modes `inputPath` IS that register's
 * folder; for `estate` mode it is a root containing skills/ agents/ commands/ plugins/.
 */
export function loadEstate(inputPath: string, mode: RegisterMode, options: LoadEstateOptions = {}): Estate {
  const root = resolve(inputPath);
  const home = options.homeDir ?? homedir();
  const frontmatterParser = options.frontmatterParser;
  if (!existsSync(root)) throw new Error(`No such path: ${root}`);

  const items: EstateItem[] = [];
  if (mode === "skills") items.push(...loadSkills(root, root, home, false, frontmatterParser));
  else if (mode === "agents") items.push(...loadMdRegister(root, root, "agent", home, false, frontmatterParser));
  else if (mode === "commands") items.push(...loadMdRegister(root, root, "command", home, false, frontmatterParser));
  else {
    let found = false;
    for (const [dir, load] of [
      ["skills", () => loadSkills(join(root, "skills"), root, home, false, frontmatterParser)],
      ["agents", () => loadMdRegister(join(root, "agents"), root, "agent", home, false, frontmatterParser)],
      ["commands", () => loadMdRegister(join(root, "commands"), root, "command", home, false, frontmatterParser)],
      ["plugins", () => loadPlugins(join(root, "plugins"), root, home, frontmatterParser)],
    ] as const) {
      if (existsSync(join(root, dir))) {
        found = true;
        items.push(...load());
      }
    }
    if (!found) {
      throw new Error(`No estate found at ${root} - expected at least one of skills/ agents/ commands/ plugins/`);
    }
  }
  return { root, mode, items };
}

function hasDir(root: string, dir: string): boolean {
  try {
    const st = lstatSync(join(root, dir));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function hasEstateDiscoverySignal(root: string, options: LoadEstateOptions): boolean {
  if (
    hasDir(root, "skills") &&
    loadSkills(join(root, "skills"), root, options.homeDir ?? homedir(), false, options.frontmatterParser).length > 0
  ) {
    return true;
  }
  if (
    hasDir(root, "agents") &&
    loadMdRegister(join(root, "agents"), root, "agent", options.homeDir ?? homedir(), false, options.frontmatterParser).length > 0
  ) {
    return true;
  }
  if (
    hasDir(root, "commands") &&
    loadMdRegister(join(root, "commands"), root, "command", options.homeDir ?? homedir(), false, options.frontmatterParser).length > 0
  ) {
    return true;
  }
  if (!hasDir(root, "plugins")) return false;

  // Generic software projects often have a `plugins/` implementation directory.
  // Only count it as a procedure estate when it contains nested procedure items,
  // not merely arbitrary plugin containers.
  return loadPlugins(join(root, "plugins"), root, options.homeDir ?? homedir(), options.frontmatterParser).some(
    (i) => i.register !== "plugin",
  );
}

function shouldSkipDiscoveryDir(name: string): boolean {
  if (DISCOVERY_IGNORED_DIRS.has(name)) return true;
  return name.startsWith(".") && !DISCOVERY_ALLOWED_HIDDEN_DIRS.has(name);
}

/**
 * Discover likely procedure estate roots below a parent directory. This is the
 * safe wrapper for repo/vault dogfooding: it avoids treating ordinary project
 * folders, documentation indexes, or generic implementation `plugins/` folders
 * as registries unless they contain loadable authored items.
 */
export function discoverEstateRoots(searchRoot: string, options: DiscoverEstateOptions = {}): string[] {
  const root = resolve(searchRoot);
  if (!existsSync(root)) throw new Error(`No such path: ${root}`);
  const maxDepth = options.maxDepth ?? 3;
  const found: string[] = [];
  const seen = new Set<string>();

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return;

    if (hasEstateDiscoverySignal(dir, options)) {
      if (!seen.has(dir)) {
        seen.add(dir);
        found.push(dir);
      }
      return; // do not also report nested register folders inside the estate
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (shouldSkipDiscoveryDir(e)) continue;
      const abs = join(dir, e);
      visit(abs, depth + 1);
    }
  };

  visit(root, 0);
  return found.sort();
}

/** Posix dirname helper exposed for checks that need an item's directory. */
export function itemDir(path: string): string {
  return posix.dirname(path);
}

export { dirname };
