import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnvFile } from "../src/cli/env.js";

const touched = new Set<string>();

function setEnv(key: string, value: string | undefined): void {
  touched.add(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const key of touched) delete process.env[key];
  touched.clear();
});

describe("dotenv loader", () => {
  it("loads local values without overwriting existing environment variables", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-env-"));
    try {
      setEnv("NOTION_TOKEN", undefined);
      setEnv("ANTHROPIC_API_KEY", "already-set");
      writeFileSync(
        join(root, ".env"),
        [
          "# comments are ignored",
          "NOTION_TOKEN=ntn_local",
          "ANTHROPIC_API_KEY=from-file",
          "export KERNEL_KEEPER_DEMO='yes'",
          "IGNORED_LINE",
        ].join("\n"),
      );

      loadDotEnvFile(join(root, ".env"));

      expect(process.env.NOTION_TOKEN).toBe("ntn_local");
      expect(process.env.ANTHROPIC_API_KEY).toBe("already-set");
      expect(process.env.KERNEL_KEEPER_DEMO).toBe("yes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports quoted values and strips unquoted inline comments", () => {
    const root = mkdtempSync(join(tmpdir(), "kk-env-"));
    try {
      setEnv("NOTION_TOKEN", undefined);
      setEnv("KERNEL_KEEPER_DEMO", undefined);
      writeFileSync(join(root, ".env"), 'NOTION_TOKEN="ntn_quoted"\nKERNEL_KEEPER_DEMO=value # comment\n');

      loadDotEnvFile(join(root, ".env"));

      expect(process.env.NOTION_TOKEN).toBe("ntn_quoted");
      expect(process.env.KERNEL_KEEPER_DEMO).toBe("value");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
