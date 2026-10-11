import type { GlassProposalDetail } from "./types.js";

export type ProcedurePromotionKind = "command" | "skill" | "agent" | "plugin" | "unknown";

export interface ProcedurePromotionView {
  kind: ProcedurePromotionKind;
  label: string;
  headline: string;
  explanation: string;
  target: string;
  validTarget: boolean;
}

export function procedurePromotionKind(target: string | null): ProcedurePromotionKind {
  if (!target) return "unknown";
  if (target.includes("/plugins/") || target.startsWith("plugins/")) return "plugin";
  if (target.includes("/skills/") || target.startsWith("skills/") || target.endsWith("/SKILL.md")) return "skill";
  if (target.includes("/agents/") || target.startsWith("agents/")) return "agent";
  if (target.includes("/commands/") || target.startsWith("commands/") || target.endsWith(".md")) return "command";
  return "unknown";
}

export function procedurePromotionView(proposal: GlassProposalDetail): ProcedurePromotionView | null {
  if (proposal.kind !== "new-procedure") return null;
  const kind = procedurePromotionKind(proposal.target);
  const label = kind === "unknown" ? "procedure" : kind;
  return {
    kind,
    label,
    headline: "This pattern looks reusable",
    explanation: "Promotion turns a repeated lesson into governed behavior: the truth register says what the team believes, and the procedure estate says what agents are allowed to do next.",
    target: proposal.target ?? "New procedure",
    validTarget: kind === "command" || kind === "skill" || kind === "agent",
  };
}
