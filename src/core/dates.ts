export interface DateCheck {
  date: Date | null;
  yyyyMmDd: string | null;
  reason: "missing" | "format" | "invalid" | null;
}

/** Strict YYYY-MM-DD parser with round-trip validation. */
export function parseYyyyMmDd(raw: unknown): DateCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { date: null, yyyyMmDd: null, reason: "missing" };
  }
  const m = raw.match(/^\s*(\d{4})-(\d{2})-(\d{2})(?:T.*|\s*)$/);
  if (!m) return { date: null, yyyyMmDd: null, reason: "format" };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const s = `${m[1]}-${m[2]}-${m[3]}`;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return { date: null, yyyyMmDd: s, reason: "invalid" };
  }
  return { date, yyyyMmDd: s, reason: null };
}

export function daysBetween(later: Date, earlier: Date): number {
  const laterUtc = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  const earlierUtc = Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate());
  return Math.floor((laterUtc - earlierUtc) / 86_400_000);
}
