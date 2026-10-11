import { NotionUsageError } from "./errors.js";

export type NotionPropertyType = "title" | "rich_text" | "select" | "status" | "multi_select" | "number" | "date" | "people";

export interface NotionDatabaseProperty {
  id?: string;
  type?: string;
}

export interface NotionDatabaseSchema {
  properties?: Record<string, NotionDatabaseProperty>;
}

export const REQUIRED_NOTION_PROPERTIES: Record<string, NotionPropertyType[]> = {
  "Proposal ID": ["title", "rich_text"],
  Status: ["select", "status"],
  Decision: ["select", "status"],
  Owner: ["rich_text", "people"],
  Severity: ["select", "status"],
  Checks: ["multi_select"],
  Source: ["rich_text"],
  Target: ["rich_text"],
  "Evidence Count": ["number"],
  "Reviewed Hash": ["rich_text"],
  "Last Synced": ["date"],
  "Applied At": ["date"],
};

export type ValidatedNotionSchema = Record<string, NotionPropertyType>;

export function validateNotionDatabaseContract(schema: NotionDatabaseSchema): ValidatedNotionSchema {
  const properties = schema.properties ?? {};
  const out: ValidatedNotionSchema = {};
  for (const [name, allowed] of Object.entries(REQUIRED_NOTION_PROPERTIES)) {
    const actual = properties[name]?.type;
    if (!actual) throw new NotionUsageError(`notion database missing required property: ${name}`);
    if (!allowed.includes(actual as NotionPropertyType)) {
      throw new NotionUsageError(`notion database property ${name} must be ${allowed.join("|")}, got: ${actual}`);
    }
    out[name] = actual as NotionPropertyType;
  }
  return out;
}
