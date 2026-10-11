import type { Frontmatter } from "../types.js";

const STABLE_ID_RE = /^[A-Za-z0-9._:-]+$/;

export function scalar(fm: Frontmatter | null | undefined, key: string): string | null {
  const v = fm?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function stringList(fm: Frontmatter | null | undefined, key: string): string[] {
  const v = fm?.[key];
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (Array.isArray(v)) return v.map((x) => x.trim()).filter(Boolean);
  return [];
}

export type LifecycleStatus = "active" | "superseded" | "retired" | "archived";

export function lifecycleStatus(fm: Frontmatter | null | undefined): LifecycleStatus {
  const s = scalar(fm, "status")?.toLowerCase();
  if (s === "superseded" || s === "retired" || s === "archived") return s;
  return "active";
}

export function isRetired(fm: Frontmatter | null | undefined): boolean {
  const status = lifecycleStatus(fm);
  return status === "retired" || status === "archived";
}

export function isActive(fm: Frontmatter | null | undefined): boolean {
  return lifecycleStatus(fm) === "active";
}

export function validStableId(id: string): boolean {
  return STABLE_ID_RE.test(id);
}
