/** Severity of a patrol finding. */
export type Severity = "HIGH" | "MED" | "LOW";

/** A single item in the patrol report. Checks never throw - they return these. */
export interface Finding {
  /** The check that produced this finding, e.g. "dangling-links". */
  check: string;
  severity: Severity;
  /** Repo-relative path of the file the finding is about, when applicable. */
  file?: string;
  /** Resolved owner display name; findings without one group under "Needs an owner". */
  owner?: string;
  /** One-sentence statement of the problem. */
  message: string;
  /** One-line fix hint for the owner. */
  hint?: string;
  /** Procedure-register kind the finding belongs to (estate modes only). */
  register?: RegisterKind;
}

/** Frontmatter parser policy. `simple` is zero-dependency and remains the default. */
export type FrontmatterParser = "simple" | "yaml";

/** Parsed frontmatter - flat string values plus string arrays for `[a, b]` lists. */
export type Frontmatter = Record<string, string | string[]>;

/** An internal link extracted from a markdown file. */
export interface BundleLink {
  /** The raw link target as written, e.g. "/metrics/csr.md" or "../definitions/x.yml". */
  target: string;
  /** Repo-relative resolved path (normalised, no leading slash), or null if unresolvable. */
  resolved: string | null;
}

/** A markdown concept file inside the bundle. */
export interface ConceptFile {
  /** Repo-relative path, e.g. "bundle/metrics/connection-success-rate.md". */
  path: string;
  /** Path relative to the bundle root, e.g. "metrics/connection-success-rate.md". */
  bundlePath: string;
  content: string;
  frontmatter: Frontmatter | null;
  links: BundleLink[];
  /** Owner display name resolved from an **Owner.** line or frontmatter, if any. */
  owner: string | null;
}

/** A YAML definition file inside the bundle (e.g. definitions/*.yml). */
export interface DefinitionFile {
  path: string;
  bundlePath: string;
  content: string;
  /** meta.owner value, if present. */
  owner: string | null;
  /** meta.concept / concept back-reference, if present (raw as written). */
  conceptRef: string | null;
}

/** A text-like evidence file inside source/raw layers. Not a governed concept. */
export interface EvidenceFile {
  path: string;
  bundlePath: string;
  content: string;
}

/** The loaded bundle plus enough of the surrounding repo to resolve links. */
export interface Bundle {
  /** Absolute path of the repo root (parent of the bundle, or the bundle itself). */
  repoRoot: string;
  /** Bundle root path relative to repoRoot ("" when they coincide). */
  bundleRel: string;
  concepts: ConceptFile[];
  definitions: DefinitionFile[];
  evidenceFiles: EvidenceFile[];
  /** Every file in the repo (repo-relative, normalised) for link resolution. */
  repoFiles: Set<string>;
}

export interface PatrolOptions {
  /** Concepts older than this many days get an affirm-or-amend item. */
  policyDays: number;
  /** log.md entries older than this many days flag the journal as stale. */
  journalDays: number;
  /** Date to measure staleness against (injectable for tests). */
  now: Date;
  /** Opt into wiki-memory checks and source/receipt policies. */
  memory: boolean;
}

export interface PatrolResult {
  findings: Finding[];
  stats: {
    concepts: number;
    definitions: number;
    findingsBySeverity: Record<Severity, number>;
  };
}

/** A check: pure function from bundle to findings. Never throws. */
export type Check = (bundle: Bundle, opts: PatrolOptions) => Finding[];

/* ── v0.2 · the procedure registers (skills, agents, commands, plugins) ── */

/** Which procedure register an estate item belongs to. */
export type RegisterKind = "skill" | "agent" | "command" | "plugin";

/** CLI register modes: one register, or the whole estate root. */
export type RegisterMode = "skills" | "agents" | "commands" | "estate";

/** A path referenced inside an item's body, resolved and existence-checked at load time. */
export interface PathRef {
  /** The reference as written, e.g. "~/.claude/reference/shipit.md". */
  raw: string;
  /** Whether the resolved path exists on disk (resolved at load - checks stay pure). */
  exists: boolean;
}

/** One item in a procedure register: a skill, agent, command, or plugin container. */
export interface EstateItem {
  /** Estate-root-relative posix path of the item's file (or dir for shapeless items). */
  path: string;
  register: RegisterKind;
  /** Skill directory name, agent/command file stem, or plugin directory name. */
  name: string;
  /** File content; null when the expected file is missing (skill dir without SKILL.md). */
  content: string | null;
  frontmatter: Frontmatter | null;
  /** File mtime - the staleness fallback when no `last-affirmed` frontmatter exists. */
  mtime: Date | null;
  pathRefs: PathRef[];
  owner: string | null;
  /**
   * True for items under plugins/ - rented, not authored. Third-party items get
   * shape/collision/deprecated checks only; staleness and ownership are the
   * marketplace notary's job, not the org registrar's.
   */
  thirdParty: boolean;
}

/** The loaded procedure estate. */
export interface Estate {
  /** Absolute path of the estate root. */
  root: string;
  mode: RegisterMode;
  items: EstateItem[];
}

export interface EstateOptions {
  /** Items unaffirmed/untouched for more than this many days get an affirm-or-amend item. */
  policyDays: number;
  /** Tool names whose mention is a HIGH finding (e.g. deprecated MCP endpoints). */
  denylist: string[];
  /** Date to measure staleness against (injectable for tests). */
  now: Date;
}

export interface EstateResult {
  findings: Finding[];
  stats: {
    items: number;
    byRegister: Record<RegisterKind, number>;
    findingsBySeverity: Record<Severity, number>;
  };
}

/** An estate check: pure function from estate to findings. Never throws. */
export type EstateCheck = (estate: Estate, opts: EstateOptions) => Finding[];
