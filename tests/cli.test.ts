import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// CLI contract tests run against the built artefact - CI builds before testing;
// locally run `npm run build` first (skipped, not failed, when dist/ is absent).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const FIXTURE = join(ROOT, "tests", "fixtures", "mini-repo");

function run(args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: e.status ?? -1 };
  }
}

function runWithEnv(args: string[], env: NodeJS.ProcessEnv): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", env });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: e.status ?? -1 };
  }
}

describe.skipIf(!existsSync(CLI))("cli contract", () => {
  it("exits 2 on HIGH findings (mini fixture has dangling link) regardless of --fail-on", () => {
    expect(run([FIXTURE, "--quiet"]).code).toBe(2);
    expect(run([FIXTURE, "--quiet", "--fail-on", "high"]).code).toBe(2);
  });

  it("--json --quiet prints only the one-line summary, JSON suppressed", () => {
    const { stdout } = run([FIXTURE, "--json", "--quiet"]);
    expect(stdout.trim().startsWith("patrol:")).toBe(true);
    expect(stdout).not.toContain("{");
  });

  it("--json without --quiet emits parseable JSON", () => {
    const { stdout } = run([FIXTURE, "--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.stats.concepts).toBeGreaterThan(0);
  });

  it("--memory is accepted in bundle mode", () => {
    expect(run([FIXTURE, "--memory", "--quiet"]).code).toBe(2);
  });

  it("--out with a missing value exits 64", () => {
    expect(run([FIXTURE, "--out"]).code).toBe(64);
    expect(run([FIXTURE, "--out", "--json"]).code).toBe(64);
  });

  it("--out to an unwritable path exits 66, not a fake gate code", () => {
    expect(run([FIXTURE, "--out", "/nonexistent-dir/deep/report.md"]).code).toBe(66);
  });

  it("bad --fail-on exits 64; unloadable bundle exits 66", () => {
    expect(run([FIXTURE, "--fail-on", "sometimes"]).code).toBe(64);
    expect(run(["/tmp", "--quiet"]).code).toBe(66);
  });

  it("invalid --frontmatter-parser exits 64", () => {
    expect(run([FIXTURE, "--frontmatter-parser", "magic"]).code).toBe(64);
  });

  it("rejects extra positional arguments instead of silently using the last one", () => {
    expect(run([FIXTURE, ESTATE_FIXTURE, "--quiet"]).code).toBe(64);
  });
});

describe("percent-decoding assumption (documented boundary)", () => {
  // resolveLink decodes %XX sequences: `my%20file.md` → `my file.md` (intended).
  // Known limitation: a file literally named with %XX-shaped text (e.g. `50%25-off.md`
  // on disk written as-is in a link) is also decoded - documented in README Boundaries.
  it("decodes valid sequences even when possibly literal", async () => {
    const { resolveLink } = await import("../src/core/bundle.js");
    expect(resolveLink("50%25-off.md", "bundle/a.md", "bundle")).toBe("bundle/50%-off.md");
  });
});

// v0.2 - register-mode CLI contract (same built-artefact convention as above).
const ESTATE_FIXTURE = join(ROOT, "tests", "fixtures", "estate");

describe.skipIf(!existsSync(CLI))("cli contract - --register modes", () => {
  it("--register estate runs and exits 2 (fixture has HIGH findings)", () => {
    const r = run([ESTATE_FIXTURE, "--register", "estate", "--quiet"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("items");
  });

  it("--denylist raises the dead-endpoint HIGH through the real argv path", () => {
    const r = run([
      ESTATE_FIXTURE, "--register", "estate",
      "--denylist", join(ESTATE_FIXTURE, "denylist.txt"),
    ]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("deprecated-tools");
  });

  it("invalid --register value exits 64", () => {
    expect(run([ESTATE_FIXTURE, "--register", "everything"]).code).toBe(64);
  });

  it("--journal-days is bundle-mode-only: exits 64 with --register", () => {
    expect(run([ESTATE_FIXTURE, "--register", "estate", "--journal-days", "10"]).code).toBe(64);
  });

  it("--memory is bundle-mode-only: exits 64 with --register", () => {
    expect(run([ESTATE_FIXTURE, "--register", "estate", "--memory"]).code).toBe(64);
  });

  it("--denylist is register-mode-only: exits 64 in bundle mode", () => {
    expect(run([FIXTURE, "--denylist", join(ESTATE_FIXTURE, "denylist.txt")]).code).toBe(64);
  });
});

describe.skipIf(!existsSync(CLI))("cli contract - discover-estates", () => {
  it("emits parseable JSON roots", () => {
    const r = run(["discover-estates", join(ROOT, "tests", "fixtures"), "--max-depth", "1", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.roots).toEqual([ESTATE_FIXTURE]);
  });

  it("invalid --max-depth exits 64", () => {
    expect(run(["discover-estates", join(ROOT, "tests", "fixtures"), "--max-depth", "deep"]).code).toBe(64);
  });
});

describe.skipIf(!existsSync(CLI))("cli contract - verify", () => {
  it("writes a baseline and exits 1 when later damage exceeds the threshold", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-cli-verify-"));
    try {
      const repo = join(root, "repo");
      cpSync(FIXTURE, repo, { recursive: true });
      const baseline = join(root, "baseline.json");
      expect(run(["verify", repo, "--write-baseline", baseline]).code).toBe(0);
      expect(run(["verify", repo, "--baseline", baseline]).code).toBe(0);

      appendFileSync(join(repo, "bundle", "metrics", "good-metric.md"), "\nChanged after baseline.\n");
      const damaged = run(["verify", repo, "--baseline", baseline]);
      expect(damaged.code).toBe(1);
      expect(damaged.stdout).toContain("verify: damage");
      expect(damaged.stdout).toContain("bundle/metrics/good-metric.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!existsSync(CLI))("cli contract - glass", () => {
  it("prints local console help", () => {
    const r = run(["glass", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("kernel-keeper glass");
    expect(r.stdout).toContain("local Kernel Keeper Glass review console");
    expect(r.stdout).toContain("--proposals <dir>");
  });

  it("prints seeded demo help", () => {
    const r = run(["glass-demo", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("kernel-keeper glass-demo");
    expect(r.stdout).toContain("Northwind memory lab fixture");
  });
});

describe.skipIf(!existsSync(CLI))("cli contract - notion", () => {
  const northwind = join(ROOT, "tests", "fixtures", "northwind-memory-lab");
  const northwindEstate = join(northwind, "estate");
  const proposals = join(northwind, "proposals");

  it("prints Notion approval-surface help", () => {
    const r = run(["notion", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("kernel-keeper notion");
    expect(r.stdout).toContain("sync <root> --proposals DIR [--dry-run | --notion-database DB]");
    expect(r.stdout).toContain("decisions <root> --proposals DIR --notion-database DB");
    expect(r.stdout).toContain("audit <root> --proposals DIR --notion-database DB");
  });

  it("dry-run prints deterministic Notion payload JSON", () => {
    const r = run(["notion", "sync", northwindEstate, "--register", "commands", "--proposals", proposals, "--dry-run", "--now", "2026-07-21T12:00:00.000Z"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.renderedAt).toBe("2026-07-21T12:00:00.000Z");
    expect(parsed.proposals[0].proposalId).toBe("P-northwind-promote-command");
    expect(parsed.proposals[0].properties.Checks).toEqual({ type: "multi_select", value: ["procedure-gap"] });
    expect(parsed.proposals[0].properties["Reviewed Hash"].value).toBe("ef35b729b335464afbd8e4167a1231837fee7098553f4bc424a6f5cf3ec1030c");
    expect(parsed.refused).toEqual([]);
  });

  it("requires --notion-database for live sync", () => {
    expect(run(["notion", "sync", northwindEstate, "--register", "commands", "--proposals", proposals]).code).toBe(64);
  });

  it("requires NOTION_TOKEN for live sync", () => {
    const env = { ...process.env, NOTION_TOKEN: "" };
    expect(runWithEnv(["notion", "sync", northwindEstate, "--register", "commands", "--proposals", proposals, "--notion-database", "db-1"], env).code).toBe(64);
  });

  it("does not allow --dry-run and --notion-database together", () => {
    expect(run(["notion", "sync", northwindEstate, "--register", "commands", "--proposals", proposals, "--dry-run", "--notion-database", "db-1"]).code).toBe(64);
  });

  it("requires a proposals directory", () => {
    expect(run(["notion", "sync", northwindEstate, "--dry-run"]).code).toBe(64);
  });

  it("reports invalid proposals instead of dropping them", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-notion-cli-"));
    const props = join(root, "props");
    cpSync(proposals, props, { recursive: true });
    appendFileSync(join(props, "bad.md"), "\nnot a proposal\n");

    const r = run(["notion", "sync", northwindEstate, "--register", "commands", "--proposals", props, "--dry-run", "--now", "2026-07-21T12:00:00.000Z"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.proposals.map((p: { proposalId: string }) => p.proposalId)).toContain("P-northwind-promote-command");
    expect(parsed.refused[0].proposal).toBe("bad");
    expect(parsed.refused[0].technicalReason).toContain("not a Proposal file");
  });

  it("requires NOTION_TOKEN for decision sync", () => {
    const env = { ...process.env, NOTION_TOKEN: "" };
    expect(runWithEnv(["notion", "decisions", northwindEstate, "--register", "commands", "--proposals", proposals, "--notion-database", "db-1"], env).code).toBe(64);
  });

  it("requires --notion-database for decision sync", () => {
    expect(run(["notion", "decisions", northwindEstate, "--register", "commands", "--proposals", proposals]).code).toBe(64);
  });

  it("requires NOTION_TOKEN for audit sync", () => {
    const env = { ...process.env, NOTION_TOKEN: "" };
    expect(runWithEnv(["notion", "audit", northwindEstate, "--register", "commands", "--proposals", proposals, "--notion-database", "db-1"], env).code).toBe(64);
  });

  it("requires --notion-database for audit sync", () => {
    expect(run(["notion", "audit", northwindEstate, "--register", "commands", "--proposals", proposals]).code).toBe(64);
  });
});

// v0.4 - AI verb dispatch (no API key in env for any of these).
describe.skipIf(!existsSync(CLI))("cli contract - AI verbs", () => {
  const env = { ...process.env, ANTHROPIC_API_KEY: "" };
  function runEnv(args: string[]): number {
    try {
      execFileSync("node", [CLI, ...args], { encoding: "utf8", env, stdio: "pipe" });
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  }
  it("propose without --out-dir exits 64", () => {
    expect(runEnv(["propose", FIXTURE])).toBe(64);
  });
  it("propose --out-dir inside the bundle exits 64 (dry-run, no key needed)", () => {
    expect(runEnv(["propose", FIXTURE, "--out-dir", join(FIXTURE, "bundle", "props"), "--dry-run"])).toBe(64);
  });
  it("propose without ANTHROPIC_API_KEY (not dry-run) exits 64", () => {
    expect(runEnv(["propose", FIXTURE, "--out-dir", "/tmp/kk-nowhere"])).toBe(64);
  });
  it("propose rejects extra positional arguments", () => {
    expect(runEnv(["propose", FIXTURE, ESTATE_FIXTURE, "--out-dir", "/tmp/kk-nowhere", "--dry-run"])).toBe(64);
  });
  it("mine without --bundle exits 64", () => {
    expect(runEnv(["mine", FIXTURE, "--out-dir", "/tmp/kk-nowhere"])).toBe(64);
  });
  it("mine rejects extra positional arguments", () => {
    expect(runEnv(["mine", FIXTURE, ESTATE_FIXTURE, "--bundle", FIXTURE, "--out-dir", "/tmp/kk-nowhere", "--dry-run"])).toBe(64);
  });
  it("bare path (no verb) still runs the legacy patrol - back-compat", () => {
    expect(run([FIXTURE, "--quiet"]).code).toBe(2); // mini fixture has HIGH findings
  });
  it("explicit patrol verb behaves identically", () => {
    expect(run(["patrol", FIXTURE, "--quiet"]).code).toBe(2);
  });
});
