#!/usr/bin/env node
import { loadDotEnv } from "./cli/env.js";
import { patrolMain } from "./cli/patrol.js";
import { proposeMain } from "./cli/propose.js";
import { mineMain } from "./cli/mine.js";
import { discoverEstatesMain } from "./cli/discover-estates.js";
import { driftMain } from "./cli/drift.js";
import { applyMain } from "./cli/apply.js";
import { verifyMain } from "./cli/verify.js";
import { glassMain } from "./cli/glass.js";
import { glassDemoMain } from "./cli/glass-demo.js";
import { notionMain } from "./cli/notion.js";

loadDotEnv();

/**
 * Verb dispatcher. Back-compat is sacred: `kernel-keeper <bundle-path> [...]`
 * (no verb) is the original CLI and falls through to the patrol verbatim -
 * a bundle directory literally named `propose`/`mine`/`patrol` can be
 * addressed as `./propose`.
 */
const argv = process.argv.slice(2);
const [verb, ...rest] = argv;

switch (verb) {
  case "propose":
    await proposeMain(rest);
    break;
  case "mine":
    await mineMain(rest);
    break;
  case "drift":
    await driftMain(rest);
    break;
  case "apply":
    applyMain(rest);
    break;
  case "verify":
    verifyMain(rest);
    break;
  case "glass":
    await glassMain(rest);
    break;
  case "glass-demo":
    await glassDemoMain(rest);
    break;
  case "notion":
    await notionMain(rest);
    break;
  case "discover-estates":
    discoverEstatesMain(rest);
    break;
  case "patrol":
    patrolMain(rest);
    break;
  default:
    patrolMain(argv); // legacy shape, byte-identical behaviour
}
