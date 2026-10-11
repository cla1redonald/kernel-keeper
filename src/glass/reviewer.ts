import { execFileSync } from "node:child_process";

const MAX_REVIEWER_LENGTH = 80;

function clean(value: string | undefined): string | null {
  const cleaned = value?.replace(/[\r\n\t[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REVIEWER_LENGTH);
  return cleaned ? cleaned : null;
}

function gitUserName(): string | undefined {
  try {
    return execFileSync("git", ["config", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
  } catch {
    return undefined;
  }
}

/**
 * Who signs elections made in this Glass session. Resolved once at startup:
 * the explicit value (`--by`), else KERNEL_KEEPER_REVIEWER, else `git config
 * user.name`, else the literal "reviewer". Requests never choose it.
 */
export function resolveReviewer(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return clean(explicit) ?? clean(env.KERNEL_KEEPER_REVIEWER) ?? clean(gitUserName()) ?? "reviewer";
}
