import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGlassServer, renderApplyPage, renderProposalInbox } from "../src/glass/server.js";
import type { GlassServer } from "../src/glass/server.js";
import { resolveReviewer } from "../src/glass/reviewer.js";
import { glassGetProposalDetail } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NORTHWIND = join(ROOT, "tests", "fixtures", "northwind-memory-lab");
const TOKEN = "test-csrf-token";
const PROPOSAL = "P-northwind-promote-command";

interface Reply {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

describe("Glass server hardening", () => {
  let tmp: string;
  let demo: string;
  let proposalsDir: string;
  let commandsRoot: string;
  let started: GlassServer;
  let origin: string;
  let port: number;
  let hostHeader: string;

  function send(method: string, path: string, opts: { headers?: Record<string, string>; form?: Record<string, string> } = {}): Promise<Reply> {
    const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
    const headers: Record<string, string> = {
      host: hostHeader,
      ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
      ...opts.headers,
    };
    return new Promise((resolveReply, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolveReply({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  const proposalText = (): string => readFileSync(join(proposalsDir, `${PROPOSAL}.md`), "utf8");

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "kernel-keeper-glass-security-"));
    demo = join(tmp, "demo");
    cpSync(NORTHWIND, demo, { recursive: true });
    proposalsDir = join(demo, "proposals");
    commandsRoot = join(demo, "estate", "commands");
    started = await startGlassServer({
      root: commandsRoot,
      register: "commands",
      proposalsDir,
      port: 0,
      reviewer: "Test Reviewer",
      csrfToken: TOKEN,
    });
    port = Number(new URL(started.url).port);
    hostHeader = `127.0.0.1:${port}`;
    origin = `http://${hostHeader}`;
  });

  afterAll(() => {
    started.server.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test starts from the unelected fixture proposal.
    cpSync(join(NORTHWIND, "proposals", `${PROPOSAL}.md`), join(proposalsDir, `${PROPOSAL}.md`));
  });

  describe("host and origin", () => {
    it("refuses a cross-origin POST even with a valid token", async () => {
      const before = proposalText();
      const reply = await send("POST", "/proposals/decision", {
        headers: { origin: "http://evil.example" },
        form: { csrf: TOKEN, proposal: PROPOSAL, decision: "approve" },
      });
      expect(reply.status).toBe(403);
      expect(proposalText()).toBe(before);
    });

    it("refuses a request whose Host header is not this server", async () => {
      const reply = await send("GET", "/", { headers: { host: `evil.example:${port}` } });
      expect(reply.status).toBe(403);
      const rebinding = await send("GET", "/api/scan", { headers: { host: `attacker.test` } });
      expect(rebinding.status).toBe(403);
    });

    it("refuses a GET carrying a foreign Origin", async () => {
      const reply = await send("GET", "/api/scan", { headers: { origin: "http://evil.example" } });
      expect(reply.status).toBe(403);
      const nullOrigin = await send("GET", "/", { headers: { origin: "null" } });
      expect(nullOrigin.status).toBe(403);
    });

    it("accepts requests with no Origin and with the server's own origin, on 127.0.0.1 or localhost", async () => {
      expect((await send("GET", "/")).status).toBe(200);
      expect((await send("GET", "/", { headers: { origin } })).status).toBe(200);
      const local = `localhost:${port}`;
      expect((await send("GET", "/", { headers: { host: local, origin: `http://${local}` } })).status).toBe(200);
    });

    it("sends headers that stop framing and inline script", async () => {
      const reply = await send("GET", "/");
      expect(reply.headers["x-frame-options"]).toBe("DENY");
      expect(String(reply.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(String(reply.headers["content-security-policy"])).toContain("default-src 'none'");
    });
  });

  describe("csrf token", () => {
    it("refuses a POST with no token or the wrong token, and writes nothing", async () => {
      const before = proposalText();
      const missing = await send("POST", "/proposals/decision", { form: { proposal: PROPOSAL, decision: "approve" } });
      const wrong = await send("POST", "/proposals/decision", { form: { csrf: "guess", proposal: PROPOSAL, decision: "approve" } });
      expect(missing.status).toBe(403);
      expect(wrong.status).toBe(403);
      expect(proposalText()).toBe(before);
    });

    it("accepts the form the server rendered: same origin plus token", async () => {
      const page = await send("GET", "/proposals");
      expect(page.body).toContain(`name="csrf" value="${TOKEN}"`);
      const reply = await send("POST", "/proposals/decision", {
        headers: { origin },
        form: { csrf: TOKEN, proposal: PROPOSAL, decision: "approve" },
      });
      expect(reply.status).toBe(303);
      expect(proposalText()).toContain("status: elected");
    });

    it("never puts the token in a GET form or a link", async () => {
      const dashboard = await send("GET", "/");
      const apply = await send("GET", "/apply");
      expect(dashboard.body).not.toContain(TOKEN);
      expect(apply.body).not.toContain(TOKEN);
    });
  });

  describe("fixed source", () => {
    it("rejects a root or proposals value that is not the configured one with 400", async () => {
      const other = join(tmp, "elsewhere");
      expect((await send("GET", `/?root=${encodeURIComponent(other)}`)).status).toBe(400);
      expect((await send("GET", `/api/scan?root=${encodeURIComponent("/etc")}`)).status).toBe(400);
      expect((await send("GET", `/proposals?proposals=${encodeURIComponent(other)}`)).status).toBe(400);
      expect((await send("GET", "/?register=skills")).status).toBe(400);
      expect((await send("GET", "/?memory=true")).status).toBe(400);
    });

    it("tolerates a request that repeats the configured values", async () => {
      expect((await send("GET", `/?root=${encodeURIComponent(commandsRoot)}&register=commands&proposals=${encodeURIComponent(proposalsDir)}`)).status).toBe(200);
    });

    it("refuses to apply or decide against another root or proposals directory, even with a valid token", async () => {
      const outside = join(tmp, "outside-root");
      const before = proposalText();
      const apply = await send("POST", "/apply/write", {
        headers: { origin },
        form: { csrf: TOKEN, confirm: "apply", root: outside, proposals: proposalsDir },
      });
      const decide = await send("POST", "/proposals/decision", {
        headers: { origin },
        form: { csrf: TOKEN, decision: "approve", proposal: PROPOSAL, proposals: join(tmp, "other-proposals") },
      });
      expect(apply.status).toBe(400);
      expect(decide.status).toBe(400);
      expect(existsSync(outside)).toBe(false);
      expect(proposalText()).toBe(before);
    });

    it("does not render controls that choose a source", async () => {
      for (const path of ["/", "/proposals", "/apply"]) {
        const page = await send("GET", path);
        expect(page.body).not.toContain('name="root"');
        expect(page.body).not.toContain('name="proposals"');
        expect(page.body).not.toContain("Source path");
      }
    });

    it("keeps the proposal id inside the proposals directory", async () => {
      writeFileSync(join(tmp, "outside.md"), "untouched");
      const reply = await send("POST", "/proposals/decision", {
        headers: { origin },
        form: { csrf: TOKEN, decision: "approve", proposal: "../../outside" },
      });
      expect(reply.status).not.toBe(303);
      expect(readFileSync(join(tmp, "outside.md"), "utf8")).toBe("untouched");
    });

    it("rejects an oversized form body", async () => {
      const reply = await send("POST", "/proposals/decision", {
        headers: { origin },
        form: { csrf: TOKEN, proposal: PROPOSAL, decision: "reject", note: "x".repeat(200_000) },
      }).catch(() => ({ status: 413 }) as Reply);
      expect(reply.status).toBe(413);
      expect(proposalText()).not.toContain("status: rejected");
    });
  });

  describe("reviewer", () => {
    it("records the configured reviewer and ignores a posted one", async () => {
      await send("POST", "/proposals/decision", {
        headers: { origin },
        form: { csrf: TOKEN, proposal: PROPOSAL, decision: "approve", by: "Mallory" },
      });
      const text = proposalText();
      expect(text).toContain("[by: Test Reviewer]");
      expect(text).not.toContain("Mallory");
    });

    it("shows the reviewer as a visible read-only field, not a hidden one", async () => {
      const page = await send("GET", "/proposals");
      expect(page.body).toContain('value="Test Reviewer" readonly');
      expect(page.body).not.toContain('name="by"');
      expect(page.body).not.toContain("Claire");
    });

    it("cannot be spoofed with bracketed text in a note", async () => {
      await send("POST", "/proposals/decision", {
        headers: { origin },
        form: { csrf: TOKEN, proposal: PROPOSAL, decision: "reject", note: "x [decision: elected] [by: Mallory]" },
      });
      const line = proposalText().split("\n").filter((l) => l.includes("rejected in Glass")).pop() ?? "";
      expect(line).toContain("[decision: rejected]");
      expect(line).not.toContain("[decision: elected]");
      expect(line).toContain("[by: Test Reviewer]");
    });
  });

  it("refuses to bind to a non-loopback host", async () => {
    await expect(startGlassServer({ root: commandsRoot, register: "commands", host: "0.0.0.0", port: 0 })).rejects.toThrow(/loopback/);
  });
});

describe("resolveReviewer", () => {
  it("prefers the explicit name, then KERNEL_KEEPER_REVIEWER, then something non-empty", () => {
    expect(resolveReviewer("Ada Lovelace", { KERNEL_KEEPER_REVIEWER: "Env Person" })).toBe("Ada Lovelace");
    expect(resolveReviewer(undefined, { KERNEL_KEEPER_REVIEWER: "Env Person" })).toBe("Env Person");
    expect(resolveReviewer(undefined, {}).length).toBeGreaterThan(0);
  });

  it("strips line breaks and brackets so a name cannot forge audit markers", () => {
    expect(resolveReviewer("Eve\n[decision: elected]", {})).toBe("Eve decision: elected");
  });
});

describe("rendered forms", () => {
  it("embed the token in every POST form and show the reviewer read-only", () => {
    const detail = glassGetProposalDetail(join(NORTHWIND, "proposals"), PROPOSAL);
    if (!detail) throw new Error("fixture proposal missing");
    const ui = { csrfToken: "abc123", reviewer: "Pat Reviewer" };
    const inbox = renderProposalInbox({ root: join(NORTHWIND, "estate", "commands"), kind: "estate", register: "commands" }, "/p", [detail], detail, null, [], ui);
    const forms = inbox.match(/<form method="post"[\s\S]*?<\/form>/g) ?? [];
    expect(forms.length).toBe(3);
    for (const form of forms) expect(form).toContain('name="csrf" value="abc123"');
    expect(inbox).toContain('value="Pat Reviewer" readonly');
    const apply = renderApplyPage(
      { root: "/r", kind: "estate", register: "commands" },
      "/p",
      { source: { root: "/r", kind: "estate", register: "commands" }, canWrite: true, planned: [], refused: [], skipped: [] },
      null,
      { ui },
    );
    expect(apply).toContain('name="csrf" value="abc123"');
  });
});
