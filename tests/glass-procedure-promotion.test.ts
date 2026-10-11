import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { procedurePromotionKind, procedurePromotionView } from "../src/glass/procedure-promotion.js";
import { renderProposalInbox } from "../src/glass/server.js";
import { prepareGlassDemo } from "../src/cli/glass-demo.js";
import { glassGetProposalDetail } from "../src/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NORTHWIND = join(ROOT, "tests", "fixtures", "northwind-memory-lab");

describe("Glass procedure promotion", () => {
  it("classifies authored procedure targets", () => {
    expect(procedurePromotionKind("commands/reconcile.md")).toBe("command");
    expect(procedurePromotionKind("skills/reconcile/SKILL.md")).toBe("skill");
    expect(procedurePromotionKind("agents/researcher.md")).toBe("agent");
  });

  it("refuses plugin targets as authored promotion targets", () => {
    expect(procedurePromotionKind("plugins/vendor/skills/helper/SKILL.md")).toBe("plugin");
    const detail = glassGetProposalDetail(join(NORTHWIND, "proposals"), "P-northwind-promote-command");
    const view = detail ? procedurePromotionView({
      ...detail,
      target: "plugins/vendor/skills/helper/SKILL.md",
    }) : null;

    expect(view?.validTarget).toBe(false);
  });

  it("renders the Northwind command promotion fixture as reusable governed behavior", () => {
    const detail = glassGetProposalDetail(join(NORTHWIND, "proposals"), "P-northwind-promote-command");
    const view = detail ? procedurePromotionView(detail) : null;
    const html = detail ? renderProposalInbox(
      { root: join(NORTHWIND, "estate", "commands"), kind: "estate", register: "commands" },
      join(NORTHWIND, "proposals"),
      [detail],
      detail,
    ) : "";

    expect(detail?.kind).toBe("new-procedure");
    expect(view).toEqual(expect.objectContaining({
      kind: "command",
      headline: "This pattern looks reusable",
      target: "customer-reconnection-insight.md",
      validTarget: true,
    }));
    expect(view?.explanation).toContain("truth register");
    expect(view?.explanation).toContain("procedure estate");
    expect(html).toContain("This pattern looks reusable");
    expect(html).toContain("Promotion Type");
  });

  it("prepares a temp demo fixture without mutating the repository fixture", () => {
    const fixture = prepareGlassDemo(ROOT);

    expect(fixture.demoRoot).not.toBe(NORTHWIND);
    expect(fixture.commandsRoot).toContain("estate/commands");
    expect(fixture.proposalsDir).toContain("proposals");
    expect(glassGetProposalDetail(fixture.proposalsDir, "P-northwind-promote-command")?.kind).toBe("new-procedure");
  });
});
