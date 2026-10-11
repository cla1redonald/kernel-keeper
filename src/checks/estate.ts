import { posix } from "node:path";
import { extractLinks } from "../core/bundle.js";
import { daysBetween, parseYyyyMmDd } from "../core/dates.js";
import { isActive, isRetired, lifecycleStatus, scalar, stringList, validStableId } from "../core/governance.js";
import type { EstateCheck, EstateItem, Finding, Severity } from "../types.js";

/**
 * The procedure-register checks (v0.2). Same constitution as the bundle checks:
 * deterministic, never throw, report-and-propose only.
 *
 * Third-party items (plugins/) get shape, collision and deprecated-tool checks
 * only - they are RENTED. Staleness and ownership on a marketplace plugin are
 * the notary's problem; the registrar patrols what the org authored.
 */

function authored(items: EstateItem[]): EstateItem[] {
  return items.filter((i) => !i.thirdParty);
}

function resolveEstateLink(target: string, fromPath: string): string | null {
  if (/^(https?:|mailto:|#|~|\$HOME\/)/i.test(target)) return null;
  const clean = target.split("#")[0]?.trim();
  if (!clean) return null;
  return posix.normalize(posix.join(posix.dirname(fromPath), clean));
}

/** 1 · Skill shape - a skill folder without SKILL.md cannot load at all. */
export const skillShape: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  for (const i of estate.items) {
    if (i.register !== "skill") continue;
    if (i.content === null) {
      findings.push({
        check: "skill-shape",
        severity: i.thirdParty ? "LOW" : "HIGH",
        file: i.path,
        register: "skill",
        message: `Skill \`${i.name}\` has no SKILL.md - it cannot be invoked`,
        hint: "Add SKILL.md with frontmatter (name, description) or delete the folder.",
      });
      continue;
    }
    if (i.thirdParty) continue; // rented: shape-exists is all the registrar checks
    if (!i.frontmatter) {
      findings.push({
        check: "skill-shape",
        severity: "MED",
        file: i.path,
        register: "skill",
        message: `Skill \`${i.name}\` has no frontmatter - undiscoverable metadata`,
        hint: "Add `---` frontmatter with name and description.",
      });
      continue;
    }
    if (!i.frontmatter["description"]) {
      findings.push({
        check: "skill-shape",
        severity: "MED",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: "skill",
        message: `Skill \`${i.name}\` has no description - agents can't judge when to use it`,
        hint: "Add `description:` to the frontmatter.",
      });
    }
  }
  return findings;
};

/** 2 · Agent visibility - no frontmatter means the agent registry cannot see it. */
export const agentVisibility: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  for (const i of authored(estate.items)) {
    if (i.register !== "agent" || i.content === null) continue;
    if (!i.frontmatter) {
      findings.push({
        check: "agent-visibility",
        severity: "HIGH",
        file: i.path,
        register: "agent",
        message: `Agent \`${i.name}\` has no frontmatter - invisible to the agent registry`,
        hint: "Add frontmatter with `description:` (and tools) - without it the agent never surfaces.",
      });
      continue;
    }
    if (!i.frontmatter["description"]) {
      findings.push({
        check: "agent-visibility",
        severity: "MED",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: "agent",
        message: `Agent \`${i.name}\` has frontmatter but no description`,
        hint: "Add `description:` - it's what the dispatcher matches against.",
      });
    }
    const declared = i.frontmatter["name"];
    if (typeof declared === "string" && declared && declared !== i.name) {
      findings.push({
        check: "agent-visibility",
        severity: "MED",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: "agent",
        message: `Agent file \`${i.name}.md\` declares \`name: ${declared}\` - filename and name disagree`,
        hint: "Make the frontmatter name match the filename; mismatches confuse invocation.",
      });
    }
  }
  return findings;
};

/** 3 · Command shape - frontmatter optional for commands, description recommended. */
export const commandShape: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  for (const i of authored(estate.items)) {
    if (i.register !== "command" || i.content === null) continue;
    if (!i.frontmatter?.["description"]) {
      findings.push({
        check: "command-shape",
        severity: "LOW",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: "command",
        message: `Command \`${i.name}\` has no description frontmatter`,
        hint: "Optional but recommended - descriptions make /help and discovery useful.",
      });
    }
  }
  return findings;
};

/**
 * 4 · Dangling refs - a path the item points at that no longer exists. Authored only
 * (a rented plugin's internal refs are the notary's problem). MED, not HIGH: a missing
 * path can be a runtime artefact the item legitimately describes - flag it, owner judges.
 */
export const danglingRefs: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  for (const i of authored(estate.items)) {
    if (i.content === null) continue;
    for (const r of i.pathRefs) {
      if (r.exists) continue;
      findings.push({
        check: "dangling-refs",
        severity: "MED",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: i.register,
        message: `References \`${r.raw}\` - nothing exists at that path`,
        hint: "Fix the path, remove the reference, or affirm it's a runtime artefact created on use.",
      });
    }
  }
  return findings;
};

/** 5 · Deprecated tools - mentions of denylisted tool names (dead endpoints, retired MCP tools). */
export const deprecatedTools: EstateCheck = (estate, opts) => {
  if (opts.denylist.length === 0) return [];
  const findings: Finding[] = [];
  for (const i of estate.items) {
    if (i.content === null) continue;
    for (const tool of opts.denylist) {
      if (!i.content.includes(tool)) continue;
      findings.push({
        check: "deprecated-tools",
        severity: "HIGH",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: i.register,
        message: `References denylisted tool \`${tool}\` - the ${i.register} fails when it reaches that call`,
        hint: "Rewrite against the current tool, or mark the item superseded.",
      });
    }
  }
  return findings;
};

/** 6 · Staleness - authored items past the affirm-or-amend window (last-affirmed, else mtime). */
export const estateStaleness: EstateCheck = (estate, opts) => {
  const findings: Finding[] = [];
  for (const i of authored(estate.items)) {
    if (i.content === null) continue;
    if (isRetired(i.frontmatter)) continue;
    const affirmed = i.frontmatter?.["last-affirmed"];
    let basis: Date | null = null;
    let basisLabel = "";
    if (typeof affirmed === "string") {
      const parsed = parseYyyyMmDd(affirmed);
      if (!parsed.date) {
        findings.push({
          check: "staleness",
          severity: "MED",
          file: i.path,
          ...(i.owner ? { owner: i.owner } : {}),
          register: i.register,
          message: "`last-affirmed` is not a valid YYYY-MM-DD date",
          hint: "Use a real calendar date so the staleness check cannot silently skip it.",
        });
        continue;
      }
      if (daysBetween(opts.now, parsed.date) < 0) {
        findings.push({
          check: "staleness",
          severity: "MED",
          file: i.path,
          ...(i.owner ? { owner: i.owner } : {}),
          register: i.register,
          message: `\`last-affirmed\` is in the future (${parsed.yyyyMmDd})`,
          hint: "Correct the date; future affirmations make stale items look fresh.",
        });
        continue;
      }
      basis = parsed.date;
      basisLabel = "last affirmed";
    } else if (i.mtime) {
      basis = i.mtime;
      basisLabel = "last modified";
    }
    if (!basis) continue;
    const ageDays = daysBetween(opts.now, basis);
    if (ageDays > opts.policyDays) {
      findings.push({
        check: "staleness",
        severity: "MED",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: i.register,
        message: `${basisLabel[0]?.toUpperCase()}${basisLabel.slice(1)} ${ageDays} days ago (policy: ${opts.policyDays})`,
        hint: "Affirm or amend: re-read it, fix what moved, add/update `last-affirmed:` in the frontmatter.",
      });
    }
  }
  return findings;
};

/** 7 · Ownerless - LOW everywhere: solo estates are valid, but ownership scales. */
export const estateOwnerless: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  for (const i of authored(estate.items)) {
    if (i.content === null || i.owner) continue;
    if (isRetired(i.frontmatter)) continue;
    findings.push({
      check: "ownerless",
      severity: "LOW",
      file: i.path,
      register: i.register,
      message: `No \`owner:\` in frontmatter`,
      hint: "Optional for a solo estate; name an owner the day a second person shares this register.",
    });
  }
  return findings;
};

/** Optional stable IDs - validate when present, do not force a migration. */
export const estateStableIds: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  const byId = new Map<string, EstateItem[]>();
  for (const i of authored(estate.items)) {
    if (i.content === null) continue;
    const id = scalar(i.frontmatter, "id");
    if (!id) continue;
    if (!validStableId(id)) {
      findings.push({
        check: "stable-ids",
        severity: "MED",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: i.register,
        message: "Frontmatter `id` is not a valid stable token",
        hint: "Use only letters, numbers, `.`, `_`, `-`, and `:`.",
      });
      continue;
    }
    const items = byId.get(id) ?? [];
    items.push(i);
    byId.set(id, items);
  }
  for (const [id, items] of byId) {
    if (items.length < 2) continue;
    for (const i of items) {
      const other = items.find((x) => x.path !== i.path) as EstateItem;
      findings.push({
        check: "stable-ids",
        severity: "HIGH",
        file: i.path,
        ...(i.owner ? { owner: i.owner } : {}),
        register: i.register,
        message: `Duplicate \`id: ${id}\` also used by \`${other.path}\``,
        hint: "IDs make references rename-proof only when each active identity is unique.",
      });
    }
  }
  return findings;
};

/** Supersession lifecycle integrity for authored procedure items. */
export const estateSupersessionIntegrity: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  const items = authored(estate.items).filter((i) => i.content !== null);
  const byPath = new Map(items.map((i) => [i.path, i]));
  const byId = new Map<string, string>();
  for (const i of items) {
    const id = scalar(i.frontmatter, "id");
    if (id) byId.set(id, i.path);
  }
  const resolvesTarget = (raw: string, fromPath: string): string | null => {
    if (byId.has(raw)) return byId.get(raw) as string;
    if (byPath.has(raw)) return raw;
    const resolved = resolveEstateLink(raw, fromPath);
    return resolved && byPath.has(resolved) ? resolved : null;
  };
  const inactivePaths = new Set(items.filter((i) => lifecycleStatus(i.frontmatter) !== "active").map((i) => i.path));

  for (const i of items) {
    const status = lifecycleStatus(i.frontmatter);
    if (status === "superseded") {
      const raw = scalar(i.frontmatter, "superseded-by");
      if (!raw) {
        findings.push({
          check: "supersession-integrity",
          severity: "HIGH",
          file: i.path,
          ...(i.owner ? { owner: i.owner } : {}),
          register: i.register,
          message: "`status: superseded` requires `superseded-by:`",
          hint: "Point to the replacement by stable `id:` or path.",
        });
      } else if (!resolvesTarget(raw, i.path)) {
        findings.push({
          check: "supersession-integrity",
          severity: "HIGH",
          file: i.path,
          ...(i.owner ? { owner: i.owner } : {}),
          register: i.register,
          message: `\`superseded-by: ${raw}\` points at no known item`,
          hint: "Use a known stable `id:` or resolvable path.",
        });
      }
    }
    if (isActive(i.frontmatter) && i.content && !scalar(i.frontmatter, "supersession-note")) {
      for (const raw of extractLinks(i.content)) {
        const resolved = resolveEstateLink(raw, i.path);
        if (!resolved || !inactivePaths.has(resolved)) continue;
        findings.push({
          check: "supersession-integrity",
          severity: "MED",
          file: i.path,
          ...(i.owner ? { owner: i.owner } : {}),
          register: i.register,
          message: `Active item references ${lifecycleStatus(byPath.get(resolved)?.frontmatter)} \`${resolved}\` without \`supersession-note:\``,
          hint: "Either reference the replacement, or add `supersession-note:` explaining why the historical reference remains.",
        });
      }
    }
  }

  const superseders = new Map<string, EstateItem[]>();
  for (const i of items) {
    if (!isActive(i.frontmatter)) continue;
    for (const raw of stringList(i.frontmatter, "supersedes")) {
      const target = resolvesTarget(raw, i.path) ?? raw;
      const list = superseders.get(target) ?? [];
      list.push(i);
      superseders.set(target, list);
    }
  }
  for (const [target, list] of superseders) {
    if (list.length < 2) continue;
    const first = list[0] as EstateItem;
    findings.push({
      check: "supersession-integrity",
      severity: "MED",
      file: first.path,
      ...(first.owner ? { owner: first.owner } : {}),
      register: first.register,
      message: `\`${target}\` is superseded by multiple active items: ${list.map((i) => `\`${i.path}\``).join(" · ")}`,
      hint: "Keep one active replacement claim, or split the superseded item into separate identities.",
    });
  }
  return findings;
};

/** 8 · Name collisions - the same name claimable from more than one scope. */
export const nameCollisions: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  const byName = new Map<string, EstateItem[]>();
  for (const i of estate.items) {
    if (i.register === "plugin") continue; // containers aren't invocable names
    const key = `${i.register}:${i.name}`;
    const list = byName.get(key) ?? [];
    list.push(i);
    byName.set(key, list);
  }
  for (const [key, list] of byName) {
    if (list.length < 2) continue;
    // Third-party↔third-party collisions are the marketplace cache's business
    // (multiple installed versions are normal); the registrar cares when an
    // AUTHORED name can be shadowed.
    if (!list.some((i) => !i.thirdParty)) continue;
    const register = list[0]?.register as EstateItem["register"];
    const paths = list.map((i) => `\`${i.path}\``).join(" · ");
    findings.push({
      check: "name-collisions",
      severity: "MED",
      file: (list.find((i) => !i.thirdParty) ?? (list[0] as EstateItem)).path,
      register,
      message: `\`${key.split(":")[1]}\` exists in ${list.length} scopes: ${paths}`,
      hint: "Two claimants to one name - which wins is resolver luck. Rename or supersede one.",
    });
  }
  return findings;
};

/** 9 · Plugin shape - a plugin that contains nothing recognisable. */
export const pluginShape: EstateCheck = (estate) => {
  const findings: Finding[] = [];
  for (const i of estate.items) {
    if (i.register !== "plugin" || i.content !== null) continue;
    findings.push({
      check: "plugin-shape",
      severity: "LOW",
      file: i.path,
      register: "plugin",
      message: `Plugin \`${i.name}\` contains no recognisable skills, agents or commands`,
      hint: "Dead weight or unrecognised layout - remove it, or check the plugin's structure.",
    });
  }
  return findings;
};

export const ALL_ESTATE_CHECKS: EstateCheck[] = [
  skillShape,
  agentVisibility,
  commandShape,
  danglingRefs,
  deprecatedTools,
  estateStaleness,
  estateOwnerless,
  estateStableIds,
  estateSupersessionIntegrity,
  nameCollisions,
  pluginShape,
];

export function runEstateChecks(
  estate: Parameters<EstateCheck>[0],
  opts: Parameters<EstateCheck>[1],
): Finding[] {
  const findings: Finding[] = [];
  for (const check of ALL_ESTATE_CHECKS) {
    try {
      findings.push(...check(estate, opts));
    } catch (err) {
      findings.push({
        check: "keeper-internal",
        severity: "LOW",
        message: `A check crashed and was skipped: ${err instanceof Error ? err.message : String(err)}`,
        hint: "Report this to kernel-keeper - checks should never throw.",
      });
    }
  }
  const order: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check));
}
