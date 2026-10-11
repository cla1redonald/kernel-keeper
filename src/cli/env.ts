import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function stripInlineComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === `"` || char === "'") && value[i - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
    }
    if (char === "#" && quote === null && /\s/.test(value[i - 1] ?? " ")) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function unquote(value: string): string {
  const trimmed = stripInlineComment(value).trim();
  if (trimmed.length >= 2 && trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, `"`);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function loadDotEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const data = readFileSync(path, "utf8");
  for (const rawLine of data.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (key === undefined || rawValue === undefined) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(rawValue);
  }
}

export function loadDotEnv(): void {
  const explicit = process.env.KERNEL_KEEPER_ENV_FILE;
  loadDotEnvFile(explicit ? resolve(explicit) : join(process.cwd(), ".env"));
}
