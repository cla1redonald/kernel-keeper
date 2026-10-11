import { NotionServiceUnavailableError, NotionUsageError, redactNotionSecret } from "./errors.js";

export const NOTION_VERSION = "2026-03-11";

export interface NotionHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type NotionFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<NotionHttpResponse>;

export interface NotionClientOptions {
  token: string;
  fetchImpl?: NotionFetch;
  baseUrl?: string;
}

export interface NotionPageRef {
  id: string;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readPageRefs(value: unknown): NotionPageRef[] {
  const results = jsonObject(value).results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => jsonObject(item).id)
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => ({ id }));
}

function queryFilter(property: string, type: "title" | "rich_text", value: string): Record<string, unknown> {
  if (type === "title") return { property, title: { equals: value } };
  return { property, rich_text: { equals: value } };
}

export class NotionClient {
  private readonly token: string;
  private readonly fetchImpl: NotionFetch;
  private readonly baseUrl: string;

  constructor(opts: NotionClientOptions) {
    if (!opts.token.trim()) throw new NotionUsageError("NOTION_TOKEN is required for live Notion sync.");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://api.notion.com";
  }

  async retrieveDataSource(dataSourceId: string): Promise<Record<string, unknown>> {
    return jsonObject(await this.request("GET", `/v1/data_sources/${encodeURIComponent(dataSourceId)}`));
  }

  async retrieveDatabase(databaseId: string): Promise<Record<string, unknown>> {
    return this.retrieveDataSource(databaseId);
  }

  async queryByProposalId(dataSourceId: string, proposalIdPropertyType: "title" | "rich_text", proposalId: string): Promise<NotionPageRef[]> {
    const body = {
      filter: queryFilter("Proposal ID", proposalIdPropertyType, proposalId),
      page_size: 3,
    };
    return readPageRefs(await this.request("POST", `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`, body));
  }

  async createPage(dataSourceId: string, properties: Record<string, unknown>, children: Record<string, unknown>[]): Promise<NotionPageRef> {
    const response = jsonObject(
      await this.request("POST", "/v1/pages", {
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties,
        children,
      }),
    );
    const id = response.id;
    if (typeof id !== "string" || !id.trim()) throw new NotionServiceUnavailableError("notion create page response missing page id");
    return { id };
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    await this.request("PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, { properties });
  }

  async retrievePage(pageId: string): Promise<Record<string, unknown>> {
    return jsonObject(await this.request("GET", `/v1/pages/${encodeURIComponent(pageId)}`));
  }

  async appendBlockChildren(blockId: string, children: Record<string, unknown>[]): Promise<void> {
    if (children.length === 0) return;
    await this.request("PATCH", `/v1/blocks/${encodeURIComponent(blockId)}/children`, { children });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: NotionHttpResponse;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new NotionServiceUnavailableError(`notion API unavailable: ${redactNotionSecret(err instanceof Error ? err.message : String(err))}`);
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        detail = response.statusText;
      }
      const safe = redactNotionSecret(detail || response.statusText);
      if (response.status >= 500 || response.status === 429) {
        throw new NotionServiceUnavailableError(`notion API unavailable (${response.status}): ${safe}`);
      }
      throw new NotionUsageError(`notion API rejected request (${response.status}): ${safe}`);
    }
    return response.json();
  }
}
