import type { Finding } from "../types.js";

interface CheckCopy {
  title: string;
  whyItMatters: string;
  recommendedAction: string;
}

const CHECK_COPY: Record<string, CheckCopy> = {
  "agent-visibility": {
    title: "Agent may be invisible",
    whyItMatters: "If an agent is not visible to the registry, users may think it exists while the assistant cannot actually call it.",
    recommendedAction: "Add the missing frontmatter or fix the agent name so it can be discovered.",
  },
  "claim-receipts": {
    title: "Claim needs evidence",
    whyItMatters: "Important memory claims need receipts so reviewers and agents can see what the claim is based on.",
    recommendedAction: "Add or repair a local source receipt for the claim.",
  },
  "archive-lifecycle": {
    title: "Archived item needs context",
    whyItMatters: "Archived knowledge should stay traceable so agents understand whether it is old, replaced, or deliberately retained.",
    recommendedAction: "Add archive metadata or a note explaining why the item is archived.",
  },
  "command-shape": {
    title: "Command is hard to discover",
    whyItMatters: "Commands without descriptions are harder for users and agents to understand safely.",
    recommendedAction: "Add a short description frontmatter value.",
  },
  "compartment-boundaries": {
    title: "Access boundary may be unclear",
    whyItMatters: "Restricted or redacted knowledge needs clear boundaries so generated views do not leak sensitive context.",
    recommendedAction: "Repair compartment metadata, generated exports, or the redacted view link.",
  },
  "dangling-refs": {
    title: "Referenced file is missing",
    whyItMatters: "Agents may follow this reference during work and hit a dead end or use stale assumptions.",
    recommendedAction: "Fix the path, restore the missing file, or record why it is intentionally runtime-only.",
  },
  "dangling-links": {
    title: "Linked file is missing",
    whyItMatters: "Broken links make the memory graph unreliable and can send agents to dead ends.",
    recommendedAction: "Fix the link, restore the missing file, or replace the reference.",
  },
  "dated-overview": {
    title: "Overview date needs repair",
    whyItMatters: "Bad overview dates make it hard to tell how fresh a summary is.",
    recommendedAction: "Fix the `As of YYYY-MM-DD` marker or remove the invalid date.",
  },
  "deprecated-tools": {
    title: "Procedure references a retired tool",
    whyItMatters: "A skill or command may fail during execution if it reaches a tool that no longer exists.",
    recommendedAction: "Replace the retired tool reference with the current one.",
  },
  "derived-artifacts": {
    title: "Generated artifact needs provenance",
    whyItMatters: "Generated summaries and caches should not become accidental source of truth.",
    recommendedAction: "Link the artifact back to its source and regeneration path.",
  },
  "frontmatter": {
    title: "Metadata needs attention",
    whyItMatters: "Missing or malformed metadata makes ownership, review, and automation less reliable.",
    recommendedAction: "Add or repair the required frontmatter.",
  },
  "index-coverage": {
    title: "Register item is missing from the index",
    whyItMatters: "If important memory is not indexed, agents and reviewers may not find it when they need it.",
    recommendedAction: "Add the item to the index or decide it should not be governed.",
  },
  "index-context": {
    title: "Index link needs useful context",
    whyItMatters: "An index should help agents choose the right memory without opening every file.",
    recommendedAction: "Add enough nearby context for a reviewer to know why the item is linked.",
  },
  "index-line-quality": {
    title: "Index entry is too thin",
    whyItMatters: "Bare links make agents open files blindly instead of choosing the right memory from the index.",
    recommendedAction: "Add a short description beside the indexed link.",
  },
  "journal": {
    title: "Change journal needs attention",
    whyItMatters: "The journal is the human-readable audit trail for why governed truth changed.",
    recommendedAction: "Add or refresh the journal entry for this change.",
  },
  "keeper-internal": {
    title: "Keeper internal file needs attention",
    whyItMatters: "Kernel Keeper support files can affect scans, proposals, or verification.",
    recommendedAction: "Review the internal file and repair the reported issue.",
  },
  "name-collisions": {
    title: "Two procedures share a name",
    whyItMatters: "When names collide, the procedure that actually runs may depend on resolver order.",
    recommendedAction: "Rename or retire one item so the intended procedure is unambiguous.",
  },
  "ownerless": {
    title: "No owner assigned",
    whyItMatters: "Unowned knowledge is harder to review, amend, and retire when it changes.",
    recommendedAction: "Assign an owner when the register is shared or the item matters operationally.",
  },
  "plugin-shape": {
    title: "Plugin has no visible procedures",
    whyItMatters: "A plugin container without recognizable skills, agents, or commands may not provide anything invokable.",
    recommendedAction: "Check whether the plugin is installed correctly or should be removed.",
  },
  "orphans": {
    title: "Item is not connected",
    whyItMatters: "Unlinked knowledge is easy for agents to miss even when it is technically present.",
    recommendedAction: "Link it from the relevant index or parent concept, or archive it.",
  },
  "pointer-integrity": {
    title: "Pointer needs repair",
    whyItMatters: "Thin register entries need valid pointers so evidence and source material remain inspectable.",
    recommendedAction: "Repair the pointer, restore the referenced source, or amend the entry.",
  },
  "recall-evidence": {
    title: "Recall evidence needs attention",
    whyItMatters: "If important memory is never retrieved, the index may not be helping agents find it.",
    recommendedAction: "Review retrieval evidence and improve the index or source routing.",
  },
  "semantic-drift": {
    title: "Source and register may disagree",
    whyItMatters: "When registered knowledge drifts from its evidence, agents may answer or act on stale information.",
    recommendedAction: "Review the compared sources and elect an amendment if the register is stale.",
  },
  "skill-shape": {
    title: "Skill may not be invokable",
    whyItMatters: "A skill folder without the expected shape may not load when an agent tries to use it.",
    recommendedAction: "Add or repair the skill file and its description.",
  },
  "stable-ids": {
    title: "Stable ID needs repair",
    whyItMatters: "Duplicate or malformed IDs make references, supersession, and audit trails ambiguous.",
    recommendedAction: "Use a unique stable token, or remove the optional ID until it is ready.",
  },
  "staleness": {
    title: "Item is due for review",
    whyItMatters: "Old operating knowledge can quietly become wrong agent behavior.",
    recommendedAction: "Affirm that it is still true or amend it, then update the review date.",
  },
  "supersession-integrity": {
    title: "Supersession trail is broken",
    whyItMatters: "Retired or superseded guidance needs a clear replacement so agents do not follow the wrong thing.",
    recommendedAction: "Add a replacement, repair the target, or add an explicit supersession note.",
  },
  "unjournalled-change": {
    title: "Change may be missing from the journal",
    whyItMatters: "A governed item changed without a visible human-readable reason.",
    recommendedAction: "Add the missing journal entry or verify the change was already recorded elsewhere.",
  },
};

export function findingCopy(finding: Finding): CheckCopy {
  return CHECK_COPY[finding.check] ?? {
    title: humanizeCheck(finding.check),
    whyItMatters: "This item may make the governed knowledge or procedure estate less reliable.",
    recommendedAction: finding.hint ?? "Review the item and decide whether to affirm, amend, or retire it.",
  };
}

export function humanizeCheck(check: string): string {
  return check
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function refusalSummary(reason: string): string {
  if (reason === "not elected") return "Waiting for human approval.";
  if (reason === "already applied") return "This approved change has already been applied.";
  if (reason.includes("missing needs-human")) return "This proposal is missing the required human-review marker.";
  if (reason.includes("missing prompt-sha256")) return "This proposal is missing provenance from the drafting prompt.";
  if (reason.includes("missing reviewed-surface")) return "This proposal cannot prove what content it reviewed.";
  if (reason.includes("reviewed surface changed")) return "The source changed since this proposal was drafted.";
  if (reason.includes("missing evidence file")) return "One or more evidence files are missing.";
  if (reason.includes("multiple proposals target")) return "More than one proposal wants to change the same item.";
  if (reason.includes("escapes")) return "The proposed change points outside the governed source.";
  if (reason.includes("not text-like")) return "The target is not a supported text document.";
  if (reason.includes("third-party plugin")) return "This targets third-party plugin content, which Glass will not edit.";
  if (reason.includes("new-procedure")) return "This procedure proposal does not meet the safe promotion rules.";
  if (reason.includes("non-simple YAML")) return "The target uses metadata that cannot be safely edited automatically.";
  if (reason.includes("target already exists")) return "The proposed new item already exists.";
  return reason;
}
