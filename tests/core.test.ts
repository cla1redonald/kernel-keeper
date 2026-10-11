import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { extractLinks, extractOwner, parseDefinition, parseFrontmatter, resolveLink } from "../src/core/bundle.js";

const requireOptional = createRequire(import.meta.url);

function hasOptionalYaml(): boolean {
  try {
    requireOptional.resolve("yaml");
    return true;
  } catch {
    return false;
  }
}

describe("parseFrontmatter", () => {
  it("parses flat keys and arrays", () => {
    const fm = parseFrontmatter(`---\ntype: Metric\ntitle: CSR\ntags: [metric, north-star]\n---\n# Body`);
    expect(fm).toEqual({ type: "Metric", title: "CSR", tags: ["metric", "north-star"] });
  });
  it("returns null when there is no block", () => {
    expect(parseFrontmatter("# Just a heading")).toBeNull();
  });
  it("keeps the simple parser as the default YAML subset", () => {
    const fm = parseFrontmatter("---\ndescription: |\n  multi-line text\ntags:\n  - memory\n---\n# Body");
    expect(fm).toEqual({ description: "|", tags: "" });
  });
  it("supports an opt-in YAML parser when the optional package is present", () => {
    const content = "---\ndescription: |\n  multi-line text\ntags: [memory, recall]\nnested:\n  owner: Claire\n---\n# Body";
    if (!hasOptionalYaml()) {
      expect(() => parseFrontmatter(content, { parser: "yaml" })).toThrow(
        /optional YAML frontmatter parser is not installed/,
      );
    } else {
      expect(parseFrontmatter(content, { parser: "yaml" })).toEqual({
        description: "multi-line text\n",
        tags: ["memory", "recall"],
        nested: JSON.stringify({ owner: "Claire" }),
      });
    }
  });
});

describe("extractLinks", () => {
  it("keeps internal links, drops external/anchors, strips fragments", () => {
    const links = extractLinks(
      "[a](/metrics/x.md) [b](../defs/y.yml) [c](https://example.com) [d](#local) [e](/g/z.md#part)",
    );
    expect(links).toEqual(["/metrics/x.md", "../defs/y.yml", "/g/z.md"]);
  });
});

describe("resolveLink", () => {
  it("resolves root-style against the bundle root", () => {
    expect(resolveLink("/metrics/x.md", "bundle/runbooks/r.md", "bundle")).toBe("bundle/metrics/x.md");
  });
  it("resolves relative against the linking file", () => {
    expect(resolveLink("../definitions/x.yml", "bundle/metrics/m.md", "bundle")).toBe("bundle/definitions/x.yml");
    expect(resolveLink("../../synthetic-data/d.csv", "bundle/metrics/m.md", "bundle")).toBe("synthetic-data/d.csv");
  });
  it("returns null when a link escapes the repo", () => {
    expect(resolveLink("../../../outside.md", "bundle/metrics/m.md", "bundle")).toBeNull();
  });
  it("handles a standalone bundle (empty bundleRel)", () => {
    expect(resolveLink("/glossary/g.md", "index.md", "")).toBe("glossary/g.md");
  });
});

describe("extractOwner", () => {
  it("prefers frontmatter owner", () => {
    expect(extractOwner("**Owner.** Bob.", { owner: "platform-team" })).toBe("platform-team");
  });
  it("reads a linked **Owner.** line", () => {
    expect(extractOwner("**Owner.** [Connections team](/ownership/c.md).", null)).toBe("Connections team");
  });
  it("reads the Owner / on-call variant", () => {
    expect(extractOwner("**Owner / on-call.** [Connections team](/ownership/c.md), 24/7.", null)).toBe(
      "Connections team",
    );
  });
  it("reads a plain-text owner", () => {
    expect(extractOwner("**Owner.** Payments team.", null)).toBe("Payments team");
  });
  it("returns null when absent", () => {
    expect(extractOwner("No owner here.", null)).toBeNull();
  });
});

describe("parseDefinition", () => {
  it("extracts owner and concept back-reference", () => {
    const d = parseDefinition("metric:\n  meta:\n    owner: connections-team\n    concept: /metrics/csr.md\n");
    expect(d).toEqual({ owner: "connections-team", conceptRef: "/metrics/csr.md" });
  });
  it("returns nulls when absent", () => {
    expect(parseDefinition("metric:\n  name: x\n")).toEqual({ owner: null, conceptRef: null });
  });
});
