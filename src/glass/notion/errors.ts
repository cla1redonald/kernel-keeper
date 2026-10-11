export class NotionUsageError extends Error {}
export class NotionServiceUnavailableError extends Error {}
export class NotionConflictError extends Error {}

export function redactNotionSecret(value: string): string {
  return value.replace(/secret_[A-Za-z0-9_-]+/g, "secret_[redacted]").replace(/ntn_[A-Za-z0-9_-]+/g, "ntn_[redacted]");
}
