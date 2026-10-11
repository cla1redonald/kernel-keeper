import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { patrolEstate, loadEstate, renderEstateMarkdown, exitCode } from "../src/index.js";
import { estateOwnerless, estateStaleness, runEstateChecks } from "../src/checks/estate.js";
import { discoverEstateRoots, extractPathRefs } from "../src/core/estate.js";
import type { Finding } from "../src/types.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "estate");
const NOW = new Date("2026-07-13");
// homeDir is pinned to the fixture root so `~/present.md` / `~/missing/thing.md`
// resolve deterministically - tests never depend on the real ~/.claude.
const CFG = { now: NOW, homeDir: FIXTURE, denylist: ["mcp__gamma__generate_gamma"] };
const requireOptional = createRequire(import.meta.url);

function hasOptionalYaml(): boolean {
  try {
    requireOptional.resolve("yaml");
    return true;
  } catch {
    return false;
  }
}

function ofCheck(findings: Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

describe("loadEstate", () => {
  it("loads all four registers from an estate root", () => {
    const estate = loadEstate(FIXTURE, "estate", { homeDir: FIXTURE });
    const by = (r: string) => estate.items.filter((i) => i.register === r);
    expect(by("skill").length).toBe(8); // 7 user skills (incl. empty-skill) + 1 plugin skill
    expect(by("agent").length).toBe(3);
    expect(by("command").length).toBe(1);
    expect(by("plugin").length).toBe(2); // the two plugin containers
  });

  it("marks plugin-hosted items as third-party", () => {
    const estate = loadEstate(FIXTURE, "estate", { homeDir: FIXTURE });
    const pluginSkill = estate.items.find((i) => i.path.startsWith("plugins/pluga"));
    const userSkill = estate.items.find((i) => i.name === "good-deploy");
    expect(pluginSkill?.thirdParty).toBe(true);
    expect(userSkill?.thirdParty).toBe(false);
  });

  it("single-register mode loads just that folder", () => {
    const estate = loadEstate(join(FIXTURE, "agents"), "agents", { homeDir: FIXTURE });
    expect(estate.items.length).toBe(3);
    expect(estate.items.every((i) => i.register === "agent")).toBe(true);
  });

  it("throws on a root with no registers (CLI maps this to exit 66)", () => {
    expect(() => loadEstate(join(FIXTURE, "skills", "good-deploy"), "estate")).toThrow(/No estate found/);
  });

  it("threads the opt-in YAML parser policy through estate loading", () => {
    if (!hasOptionalYaml()) {
      expect(() => loadEstate(FIXTURE, "estate", { homeDir: FIXTURE, frontmatterParser: "yaml" })).toThrow(
        /optional YAML frontmatter parser is not installed/,
      );
    } else {
      expect(loadEstate(FIXTURE, "estate", { homeDir: FIXTURE, frontmatterParser: "yaml" }).items.length).toBe(14);
    }
  });
});

describe("extractPathRefs", () => {
  it("resolves ~ refs against the injected home and checks existence", () => {
    const refs = extractPathRefs("see ~/present.md and ~/missing/thing.md.", FIXTURE, FIXTURE);
    expect(refs).toEqual([
      { raw: "~/present.md", exists: true },
      { raw: "~/missing/thing.md", exists: false },
    ]);
  });

  it("skips globs, template placeholders and URLs", () => {
    const refs = extractPathRefs(
      "run ~/bin/*.sh with $HOME/{env}/x and see https://example.com/a.md",
      FIXTURE,
      FIXTURE,
    );
    expect(refs).toEqual([]);
  });

  it("resolves relative markdown links against the item dir", () => {
    const dir = join(FIXTURE, "skills", "good-deploy");
    const refs = extractPathRefs("[checklist](checklist.md) [gone](nope.md)", dir, FIXTURE);
    expect(refs).toEqual([
      { raw: "checklist.md", exists: true },
      { raw: "nope.md", exists: false },
    ]);
  });
});

describe("estate checks - the sweep findings, reproduced", () => {
  const result = patrolEstate(FIXTURE, "estate", CFG);

  it("skill-shape: missing SKILL.md is HIGH; missing description is MED", () => {
    const shape = ofCheck(result.findings, "skill-shape");
    expect(shape.find((f) => f.file?.includes("empty-skill"))?.severity).toBe("HIGH");
    expect(shape.find((f) => f.file?.includes("no-desc"))?.severity).toBe("MED");
    // healthy control skill raises nothing
    expect(shape.some((f) => f.file?.includes("good-deploy"))).toBe(false);
  });

  it("agent-visibility: no frontmatter = HIGH invisible; name mismatch = MED", () => {
    const vis = ofCheck(result.findings, "agent-visibility");
    const invisible = vis.find((f) => f.file?.includes("invisible"));
    expect(invisible?.severity).toBe("HIGH");
    expect(invisible?.message).toContain("invisible to the agent registry");
    expect(vis.find((f) => f.file?.includes("mismatch"))?.severity).toBe("MED");
    expect(vis.some((f) => f.file === "agents/visible.md")).toBe(false); // exact - "invisible.md" contains "visible.md"
  });

  it("deprecated-tools: denylisted endpoint mention is HIGH", () => {
    const dep = ofCheck(result.findings, "deprecated-tools");
    expect(dep.length).toBe(1);
    expect(dep[0]?.file).toContain("dead-tool");
    expect(dep[0]?.severity).toBe("HIGH");
    expect(dep[0]?.message).toContain("mcp__gamma__generate_gamma");
  });

  it("deprecated-tools: silently skipped when no denylist given", () => {
    const bare = patrolEstate(FIXTURE, "estate", { now: NOW, homeDir: FIXTURE });
    expect(ofCheck(bare.findings, "deprecated-tools")).toEqual([]);
  });

  it("dangling-refs: flags only the dead path, MED, authored items only", () => {
    const refs = ofCheck(result.findings, "dangling-refs");
    const dead = refs.filter((f) => f.file?.includes("dangling"));
    expect(dead.length).toBe(1);
    expect(dead[0]?.message).toContain("~/missing/thing.md");
    expect(dead[0]?.severity).toBe("MED"); // could be a runtime artefact - owner judges
    expect(refs.some((f) => f.file?.startsWith("plugins/"))).toBe(false);
  });

  it("dangling-refs: refs inside code fences and inline code are examples, not deps", () => {
    const refs = extractPathRefs(
      "Real dep ~/missing/thing.md here.\n```\n~/missing/fenced.md\n```\nAnd `~/missing/inline.md` too.",
      FIXTURE,
      FIXTURE,
    );
    expect(refs.map((r) => r.raw)).toEqual(["~/missing/thing.md"]);
  });

  it("staleness: last-affirmed in January vs a July clock is MED; fresh mtimes are quiet", () => {
    const stale = ofCheck(result.findings, "staleness");
    expect(stale.find((f) => f.file?.includes("stale-skill"))?.severity).toBe("MED");
    // fixture files were just written - mtime-based staleness must not fire
    expect(stale.length).toBe(1);
  });

  it("staleness flags invalid and future last-affirmed values", () => {
    const result = {
      root: "/x",
      mode: "skills" as const,
      items: [
        { path: "skills/bad/SKILL.md", register: "skill" as const, name: "bad", content: "x",
          frontmatter: { description: "bad", "last-affirmed": "2026-02-31" }, mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
        { path: "skills/future/SKILL.md", register: "skill" as const, name: "future", content: "x",
          frontmatter: { description: "future", "last-affirmed": "2026-07-14" }, mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
      ],
    };
    const stale = ofCheck(patrolEstate(FIXTURE, "agents", { now: NOW, homeDir: FIXTURE }).findings, "staleness");
    expect(stale).toEqual([]);
    const findings = runEstateChecks(result, { policyDays: 90, now: NOW, denylist: [] });
    expect(ofCheck(findings, "staleness").map((f) => f.message)).toEqual([
      "`last-affirmed` is not a valid YYYY-MM-DD date",
      "`last-affirmed` is in the future (2026-07-14)",
    ]);
  });

  it("name-collisions: user skill vs plugin skill sharing a name is MED", () => {
    const col = ofCheck(result.findings, "name-collisions");
    expect(col.length).toBe(1);
    expect(col[0]?.message).toContain("deploy");
    expect(col[0]?.message).toContain("plugins/pluga");
    expect(col[0]?.severity).toBe("MED");
  });

  it("plugin-shape: a plugin with nothing recognisable is LOW", () => {
    const plug = ofCheck(result.findings, "plugin-shape");
    expect(plug.length).toBe(1);
    expect(plug[0]?.file).toContain("emptyplug");
    expect(plug[0]?.severity).toBe("LOW");
  });

  it("third-party items get no staleness/ownerless findings", () => {
    const thirdPartyNoise = result.findings.filter(
      (f) => f.file?.startsWith("plugins/") && (f.check === "staleness" || f.check === "ownerless"),
    );
    expect(thirdPartyNoise).toEqual([]);
  });

  it("ownerless is LOW and skips owned items", () => {
    const own = ofCheck(result.findings, "ownerless");
    expect(own.every((f) => f.severity === "LOW")).toBe(true);
    expect(own.some((f) => f.file?.includes("good-deploy"))).toBe(false);
    expect(own.some((f) => f.file === "agents/visible.md")).toBe(false);
  });

  it("command-shape: bare command gets a LOW description nudge", () => {
    const cmd = ofCheck(result.findings, "command-shape");
    expect(cmd.length).toBe(1);
    expect(cmd[0]?.file).toContain("hello");
    expect(cmd[0]?.severity).toBe("LOW");
  });

  it("stats count items per register and exitCode reflects the HIGHs", () => {
    expect(result.stats.byRegister.skill).toBe(8);
    expect(result.stats.byRegister.agent).toBe(3);
    expect(exitCode(result, "med")).toBe(2);
  });
});

describe("estate governance checks", () => {
  it("validates optional IDs without requiring missing IDs", () => {
    const estate = {
      root: "/x", mode: "estate" as const,
      items: [
        { path: "agents/a.md", register: "agent" as const, name: "a", content: "", frontmatter: { description: "A" },
          mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
        { path: "agents/b.md", register: "agent" as const, name: "b", content: "", frontmatter: { description: "B", id: "agent:b" },
          mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
      ],
    };
    expect(runEstateChecks(estate, CFG).filter((f) => f.check === "stable-ids")).toEqual([]);
  });

  it("flags malformed and duplicate IDs across authored estate items", () => {
    const estate = {
      root: "/x", mode: "estate" as const,
      items: [
        { path: "agents/a.md", register: "agent" as const, name: "a", content: "", frontmatter: { description: "A", id: "bad id" },
          mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
        { path: "skills/one/SKILL.md", register: "skill" as const, name: "one", content: "", frontmatter: { description: "One", id: "dup" },
          mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
        { path: "commands/two.md", register: "command" as const, name: "two", content: "", frontmatter: { description: "Two", id: "dup" },
          mtime: NOW, pathRefs: [], owner: null, thirdParty: false },
      ],
    };
    const f = runEstateChecks(estate, CFG).filter((x) => x.check === "stable-ids");
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["HIGH", "skills/one/SKILL.md", "Duplicate `id: dup` also used by `commands/two.md`"],
      ["HIGH", "commands/two.md", "Duplicate `id: dup` also used by `skills/one/SKILL.md`"],
      ["MED", "agents/a.md", "Frontmatter `id` is not a valid stable token"],
    ]);
  });

  it("checks estate supersession by ID or path and suppresses inactive ownership/staleness noise", () => {
    const estate = {
      root: "/x", mode: "estate" as const,
      items: [
        { path: "agents/old.md", register: "agent" as const, name: "old", content: "", frontmatter: { description: "Old", id: "old", status: "superseded" },
          mtime: NOW, pathRefs: [], owner: "Claire", thirdParty: false },
        { path: "agents/new.md", register: "agent" as const, name: "new", content: "[old](old.md)", frontmatter: { description: "New", id: "new", supersedes: "old" },
          mtime: NOW, pathRefs: [{ raw: "old.md", exists: true }], owner: "Claire", thirdParty: false },
        { path: "agents/retired.md", register: "agent" as const, name: "retired", content: "", frontmatter: { description: "Retired", status: "retired", "last-affirmed": "2020-01-01" },
          mtime: new Date("2020-01-01"), pathRefs: [], owner: null, thirdParty: false },
        { path: "agents/archived.md", register: "agent" as const, name: "archived", content: "", frontmatter: { description: "Archived", status: "archived", "last-affirmed": "2020-01-01" },
          mtime: new Date("2020-01-01"), pathRefs: [], owner: null, thirdParty: false },
      ],
    };
    const f = runEstateChecks(estate, CFG).filter((x) => x.check === "supersession-integrity");
    expect(f.map((x) => [x.severity, x.file, x.message])).toEqual([
      ["HIGH", "agents/old.md", "`status: superseded` requires `superseded-by:`"],
      ["MED", "agents/new.md", "Active item references superseded `agents/old.md` without `supersession-note:`"],
    ]);
    expect(estateOwnerless(estate, CFG).some((x) => x.file === "agents/retired.md")).toBe(false);
    expect(estateOwnerless(estate, CFG).some((x) => x.file === "agents/archived.md")).toBe(false);
    expect(estateStaleness(estate, CFG).some((x) => x.file === "agents/retired.md")).toBe(false);
    expect(estateStaleness(estate, CFG).some((x) => x.file === "agents/archived.md")).toBe(false);

    (estate.items[0] as { frontmatter: Record<string, string> }).frontmatter["superseded-by"] = "agents/new.md";
    (estate.items[1] as { frontmatter: Record<string, string> }).frontmatter["supersession-note"] = "Intentional compatibility note.";
    expect(runEstateChecks(estate, CFG).filter((x) => x.check === "supersession-integrity")).toEqual([]);
  });
});

describe("renderEstateMarkdown", () => {
  it("groups by register with the registrar/notary footer", () => {
    const result = patrolEstate(FIXTURE, "estate", CFG);
    const md = renderEstateMarkdown(result, "estate-fixture", NOW);
    expect(md).toContain("# Patrol report: estate-fixture (procedure registers)");
    expect(md).toContain("## Skills (");
    expect(md).toContain("## Agents (");
    expect(md).toContain("## Plugins (third-party, shape checks only) (");
    expect(md.indexOf("## Skills")).toBeLessThan(md.indexOf("## Agents"));
    expect(md).toContain("marketplace notary");
  });

  it("renders clean when a register has no findings", () => {
    const result = patrolEstate(join(FIXTURE, "agents"), "agents", { now: NOW, homeDir: FIXTURE });
    const md = renderEstateMarkdown(result, "agents-only", NOW);
    expect(md).not.toContain("## Skills");
  });
});

describe("estate walker safety - symlinks and depth", () => {
  // Built at runtime in a temp dir: committed symlink fixtures are unreliable across
  // platforms/checkouts, and these tests are precisely about not trusting layout.
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");

  function tmpEstate(build: (root: string) => void): string {
    const root = mkdtempSync(join(tmpdir(), "kk-estate-"));
    build(root);
    return root;
  }

  it("a symlinked SKILL.md is treated as missing, never read through", () => {
    const root = tmpEstate((r) => {
      writeFileSync(join(r, "outside.md"), "---\nname: outside\ndescription: secret target\n---\nmcp__gamma__generate_gamma");
      mkdirSync(join(r, "skills", "linked"), { recursive: true });
      symlinkSync(join(r, "outside.md"), join(r, "skills", "linked", "SKILL.md"));
    });
    try {
      const result = patrolEstate(root, "estate", { now: NOW, homeDir: root, denylist: ["mcp__gamma__generate_gamma"] });
      // Not read: no deprecated-tools hit from the target; reported as shapeless instead.
      expect(result.findings.some((f) => f.check === "deprecated-tools")).toBe(false);
      const shape = result.findings.find((f) => f.check === "skill-shape");
      expect(shape?.severity).toBe("HIGH");
      expect(shape?.message).toContain("no SKILL.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a symlinked directory inside plugins/ is never descended", () => {
    const root = tmpEstate((r) => {
      mkdirSync(join(r, "real-target", "skills", "smuggled"), { recursive: true });
      writeFileSync(join(r, "real-target", "skills", "smuggled", "SKILL.md"), "---\nname: smuggled\ndescription: x\n---\n");
      mkdirSync(join(r, "plugins"), { recursive: true });
      symlinkSync(join(r, "real-target"), join(r, "plugins", "linkplug"));
    });
    try {
      const result = patrolEstate(root, "estate", { now: NOW, homeDir: root });
      expect(result.stats.byRegister.skill).toBe(0); // nothing smuggled in through the link
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plugin content deeper than the walk bound is not found (reported as shapeless plugin)", () => {
    const root = tmpEstate((r) => {
      const deep = join(r, "plugins", "deepplug", "a", "b", "c", "d", "e", "f", "g");
      mkdirSync(join(deep, "skills", "buried"), { recursive: true });
      writeFileSync(join(deep, "skills", "buried", "SKILL.md"), "---\nname: buried\ndescription: x\n---\n");
    });
    try {
      const result = patrolEstate(root, "estate", { now: NOW, homeDir: root });
      expect(result.stats.byRegister.skill).toBe(0);
      expect(result.findings.some((f) => f.check === "plugin-shape" && f.file?.includes("deepplug"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("trailing ! and ? are stripped from prose refs", () => {
    const refs = extractPathRefs("check ~/present.md! or maybe ~/present.md?", FIXTURE, FIXTURE);
    expect(refs).toEqual([{ raw: "~/present.md", exists: true }]);
  });
});

describe("estate discovery", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");

  function tmpWorkspace(build: (root: string) => void): string {
    const root = mkdtempSync(join(tmpdir(), "kk-discover-"));
    build(root);
    return root;
  }

  it("finds nested authored estate roots in a repo container", () => {
    const root = tmpWorkspace((r) => {
      mkdirSync(join(r, "plain-project"), { recursive: true });
      writeFileSync(join(r, "plain-project", "README.md"), "# Not an estate\n");

      mkdirSync(join(r, "tooling", "pipeline", "agents"), { recursive: true });
      writeFileSync(join(r, "tooling", "pipeline", "agents", "reader.md"), "# Reader\n");
    });
    try {
      expect(discoverEstateRoots(root, { maxDepth: 3 })).toEqual([join(root, "tooling", "pipeline")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat an Obsidian project folder with INDEX and synthesis notes as an estate", () => {
    const root = tmpWorkspace((r) => {
      const project = join(r, "01_Projects", "CTOCRAFTCON");
      mkdirSync(join(project, "Talk A"), { recursive: true });
      writeFileSync(join(project, "INDEX.md"), "# CTO Craft Con\n");
      writeFileSync(join(project, "Synthesis.md"), "# Synthesis\n");
      writeFileSync(join(project, "Talk A", "Notes.md"), "# Notes\n");
    });
    try {
      expect(discoverEstateRoots(root, { maxDepth: 3 })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores generic implementation plugins folders with no procedure items", () => {
    const root = tmpWorkspace((r) => {
      mkdirSync(join(r, "site", "plugins", "syntax-highlighter"), { recursive: true });
      writeFileSync(join(r, "site", "plugins", "syntax-highlighter", "index.ts"), "export {};\n");
    });
    try {
      expect(discoverEstateRoots(root, { maxDepth: 2 })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips hidden archive folders but still allows intentional hidden estate roots", () => {
    const root = tmpWorkspace((r) => {
      mkdirSync(join(r, ".backup", "old", "agents"), { recursive: true });
      writeFileSync(join(r, ".backup", "old", "agents", "stale.md"), "# Stale\n");

      mkdirSync(join(r, ".claude", "commands"), { recursive: true });
      writeFileSync(join(r, ".claude", "commands", "ship.md"), "# Ship\n");
    });
    try {
      expect(discoverEstateRoots(root, { maxDepth: 3 })).toEqual([join(root, ".claude")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
