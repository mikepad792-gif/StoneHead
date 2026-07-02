// scripts/cultivation-runtime-check.mjs
// Cultivation RUNTIME cross-check — run: node scripts/cultivation-runtime-check.mjs
//
// THE GAP THIS CLOSES: scripts/cultivation-eval/run_eval.py re-implements the
// token matcher and validates rank() — but the production path in
// lib/cultivationSearch.js layers a cluster-selection step ON TOP of rank(),
// and that layer is what actually decides the [CULTIVATION REFERENCE] block
// the model receives. The Python eval was green (36/36) while the runtime
// cluster layer disagreed on 14/36 of the same cases (a score-blind cluster
// vote let two weak stragglers outvote a dominant top hit — "white powdery
// stuff... wipes off" injected nitrogen-deficiency as the lead hunch).
//
// This script runs the SAME 36 retrieval cases through the real
// retrieveCultivation() and asserts on what would actually be injected:
//   expect_issue   -> must be the LEAD (rank-1 of the injected block)
//   expect_cluster -> >=2 expected cluster ids present among injected members
//
// Run BOTH checks before deploy: run_eval.py validates the data's match
// surface; this validates the production selection logic.
//
// Note: lib/cultivationSearch.js reads data via `__dirname` (provided by
// esbuild in the Netlify bundle). Under plain Node ESM that global is absent,
// so we shim it to the lib directory before importing — same pattern as
// retrieval-check.mjs.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
globalThis.__dirname = path.join(scriptsDir, "..", "lib");

const { retrieveCultivation } = await import("../lib/cultivationSearch.js");

const check = JSON.parse(
  fs.readFileSync(path.join(scriptsDir, "cultivation-eval", "cultivation-check.json"), "utf8")
);

let pass = 0;
let fail = 0;
let leadExact = 0;
let leadTotal = 0;
const failures = [];

for (const c of check.retrieval_cases) {
  const r = retrieveCultivation(c.query);
  const lead = r ? r.lead.id : null;
  const memberIds = r ? r.members.map((m) => m.id) : [];

  let ok;
  if (c.expect_issue) {
    leadTotal++;
    // Runtime bar is STRICTER than the Python eval's top-3: the expected issue
    // must be the LEAD, because the lead is what the prompt tells the model to
    // "commit to out loud." An expected issue buried in members while a wrong
    // lead gets voiced is exactly the failure this script exists to catch.
    ok = lead === c.expect_issue;
    if (ok) leadExact++;
  } else if (c.expect_cluster) {
    const hits = c.expect_cluster.filter((id) => id === lead || memberIds.includes(id));
    ok = hits.length >= 2;
  } else {
    ok = true;
  }

  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(
      `  FAIL [${c.id}] "${c.query.slice(0, 60)}"\n` +
        `       want=${c.expect_issue || JSON.stringify(c.expect_cluster)}` +
        ` got lead=${lead} members=${JSON.stringify(memberIds)}`
    );
  }
}

if (failures.length) console.log(failures.join("\n"));
console.log(
  `\nruntime check: passed=${pass} failed=${fail}` +
    ` (lead exact on expect_issue: ${leadExact}/${leadTotal})`
);

if (fail > 0) {
  console.error("\nRuntime cultivation retrieval DISAGREES with the eval. Do not deploy.");
  process.exit(1);
}
console.log("\nAll runtime cultivation checks passed. ✓");
