import type { EstateResult, Finding, PatrolResult, RegisterKind, Severity } from "../types.js";

const SEV_ORDER: Record<Severity, number> = { HIGH: 0, MED: 1, LOW: 2 };
const REGISTER_ORDER: RegisterKind[] = ["skill", "agent", "command", "plugin"];
const REGISTER_TITLES: Record<RegisterKind, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  plugin: "Plugins (third-party, shape checks only)",
};

function healthLine(bySev: Record<Severity, number>): string {
  if (bySev.HIGH > 0) return "Needs attention: HIGH findings mean agents are being misled today.";
  if (bySev.MED > 0) return "Mostly healthy: a round of affirm-or-amend would clear it.";
  if (bySev.LOW > 0) return "Healthy: only hygiene items remain.";
  return "Clean patrol. The register is healthy.";
}

/** Render the affirm-or-amend digest, grouped by owner. */
export function renderMarkdown(result: PatrolResult, bundleLabel: string, when: Date): string {
  const { findings, stats } = result;
  const byOwner = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.owner ?? "Needs an owner";
    const list = byOwner.get(key) ?? [];
    list.push(f);
    byOwner.set(key, list);
  }
  // Named owners first (alphabetical), "Needs an owner" last.
  const owners = [...byOwner.keys()].sort((a, b) =>
    a === "Needs an owner" ? 1 : b === "Needs an owner" ? -1 : a.localeCompare(b),
  );

  const lines: string[] = [];
  lines.push(`# Patrol report: ${bundleLabel}`);
  lines.push("");
  lines.push(`*kernel-keeper · ${when.toISOString().slice(0, 10)} · ${stats.concepts} concepts · ${stats.definitions} definitions*`);
  lines.push("");
  lines.push(
    `**${findings.length} finding${findings.length === 1 ? "" : "s"}**: ` +
      `${stats.findingsBySeverity.HIGH} high · ${stats.findingsBySeverity.MED} medium · ${stats.findingsBySeverity.LOW} low. ` +
      healthLine(stats.findingsBySeverity),
  );
  lines.push("");
  if (findings.length === 0) return lines.join("\n");

  for (const owner of owners) {
    const items = (byOwner.get(owner) as Finding[]).sort(
      (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.file ?? "").localeCompare(b.file ?? ""),
    );
    lines.push(`## ${owner} (${items.length} item${items.length === 1 ? "" : "s"})`);
    lines.push("");
    for (const f of items) {
      const loc = f.file ? ` \`${f.file}\`` : "";
      lines.push(`- **[${f.severity}]**${loc} ${f.message} *(${f.check})*`);
      if (f.hint) lines.push(`  - ${f.hint}`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("*The keeper reports and proposes; it never edits. Owners affirm or amend; the judgment stays human.*");
  lines.push("");
  return lines.join("\n");
}

/** Render the procedure-register digest, grouped by register then severity. */
export function renderEstateMarkdown(result: EstateResult, label: string, when: Date): string {
  const { findings, stats } = result;
  const lines: string[] = [];
  const counts = REGISTER_ORDER.filter((r) => stats.byRegister[r] > 0)
    .map((r) => `${stats.byRegister[r]} ${r}${stats.byRegister[r] === 1 ? "" : "s"}`)
    .join(" · ");
  lines.push(`# Patrol report: ${label} (procedure registers)`);
  lines.push("");
  lines.push(`*kernel-keeper · ${when.toISOString().slice(0, 10)} · ${counts || "0 items"}*`);
  lines.push("");
  lines.push(
    `**${findings.length} finding${findings.length === 1 ? "" : "s"}**: ` +
      `${stats.findingsBySeverity.HIGH} high · ${stats.findingsBySeverity.MED} medium · ${stats.findingsBySeverity.LOW} low. ` +
      healthLine(stats.findingsBySeverity),
  );
  lines.push("");
  if (findings.length === 0) return lines.join("\n");

  const byRegister = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.register ?? "keeper";
    const list = byRegister.get(key) ?? [];
    list.push(f);
    byRegister.set(key, list);
  }
  const keys: string[] = [...REGISTER_ORDER.filter((r) => byRegister.has(r))];
  if (byRegister.has("keeper")) keys.push("keeper");

  for (const key of keys) {
    const items = (byRegister.get(key) as Finding[]).sort(
      (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.file ?? "").localeCompare(b.file ?? ""),
    );
    const title = key === "keeper" ? "Keeper internal" : REGISTER_TITLES[key as RegisterKind];
    lines.push(`## ${title} (${items.length} item${items.length === 1 ? "" : "s"})`);
    lines.push("");
    for (const f of items) {
      const loc = f.file ? ` \`${f.file}\`` : "";
      const own = f.owner ? `, owner: ${f.owner}` : "";
      lines.push(`- **[${f.severity}]**${loc} ${f.message}${own} *(${f.check})*`);
      if (f.hint) lines.push(`  - ${f.hint}`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push(
    "*The registrar patrols what you authored; the marketplace notary vouches for what you rented. Neither edits; owners decide.*",
  );
  lines.push("");
  return lines.join("\n");
}
