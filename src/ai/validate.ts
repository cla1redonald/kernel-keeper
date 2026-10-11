/**
 * Hand-rolled shape assertion - defence-in-depth behind the API's structured
 * outputs (and the thing that catches mocked-fetch drift in tests). Not a
 * schema library: required keys, primitive types, enum membership only.
 */

export class ShapeError extends Error {}

type FieldSpec =
  | { kind: "string"; nullable?: boolean; enum?: readonly string[] }
  | { kind: "boolean" }
  | { kind: "flat-record"; nullable?: boolean }
  | { kind: "kv-array"; nullable?: boolean }
  | { kind: "quote-array" };

export function assertShape(obj: unknown, spec: Record<string, FieldSpec>, label: string): void {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new ShapeError(`${label}: expected an object`);
  }
  const rec = obj as Record<string, unknown>;
  for (const [key, field] of Object.entries(spec)) {
    const v = rec[key];
    if (v === null || v === undefined) {
      if ("nullable" in field && field.nullable) continue;
      throw new ShapeError(`${label}: missing required field \`${key}\``);
    }
    switch (field.kind) {
      case "string":
        if (typeof v !== "string") throw new ShapeError(`${label}: \`${key}\` must be a string`);
        if (field.enum && !field.enum.includes(v)) {
          throw new ShapeError(`${label}: \`${key}\` must be one of ${field.enum.join("|")}, got: ${v}`);
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") throw new ShapeError(`${label}: \`${key}\` must be a boolean`);
        break;
      case "flat-record":
        if (typeof v !== "object" || Array.isArray(v)) throw new ShapeError(`${label}: \`${key}\` must be an object`);
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          if (typeof pv !== "string") throw new ShapeError(`${label}: \`${key}.${pk}\` must be a string`);
        }
        break;
      case "kv-array": {
        if (!Array.isArray(v)) throw new ShapeError(`${label}: \`${key}\` must be an array`);
        const seen = new Set<string>();
        for (const item of v) {
          const kv = item as { key?: unknown; value?: unknown };
          if (typeof kv?.key !== "string" || typeof kv?.value !== "string") {
            throw new ShapeError(`${label}: \`${key}\` items need string key+value`);
          }
          // Silent last-wins on duplicates would hide a conflicting draft from the judge.
          if (seen.has(kv.key)) throw new ShapeError(`${label}: duplicate frontmatter key \`${kv.key}\` in ${key}`);
          seen.add(kv.key);
        }
        break;
      }
      case "quote-array":
        if (!Array.isArray(v)) throw new ShapeError(`${label}: \`${key}\` must be an array`);
        for (const item of v) {
          const q = item as { file?: unknown; quote?: unknown };
          if (typeof q?.file !== "string" || typeof q?.quote !== "string") {
            throw new ShapeError(`${label}: \`${key}\` items need string file+quote`);
          }
        }
        break;
    }
  }
}

export const SCRIBE_RESPONSE_SPEC: Record<string, FieldSpec> = {
  kind: { kind: "string", enum: ["amend", "new-concept"] },
  summary: { kind: "string" },
  rationale: { kind: "string" },
  frontmatterPatch: { kind: "kv-array", nullable: true },
  bodyDraft: { kind: "string", nullable: true },
  journalLine: { kind: "string" },
  indexEntry: { kind: "string", nullable: true },
  confidence: { kind: "string", enum: ["low", "medium", "high"] },
  evidenceQuotes: { kind: "quote-array" },
  needsHuman: { kind: "boolean" },
};

export const DRIFT_RESPONSE_SPEC: Record<string, FieldSpec> = {
  summary: { kind: "string" },
  rationale: { kind: "string" },
  frontmatterPatch: { kind: "kv-array", nullable: true },
  bodyDraft: { kind: "string", nullable: true },
  journalLine: { kind: "string" },
  confidence: { kind: "string", enum: ["low", "medium", "high"] },
  evidenceQuotes: { kind: "quote-array" },
};
