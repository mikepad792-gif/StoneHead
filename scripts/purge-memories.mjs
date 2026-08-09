// scripts/purge-memories.mjs
// One-off cleanup for memories written before the exclusion filter existed
// (Addendum C1 part 2).
//
//   node scripts/purge-memories.mjs           # dry run — prints, changes nothing
//   node scripts/purge-memories.mjs --apply   # actually deletes
//   node scripts/purge-memories.mjs --user <uuid>   # scope to one account
//
// DRY RUN BY DEFAULT, and that is not politeness. This deletes rows a person
// can see in their memory bank, and the exclusion patterns were written
// against model prose that nobody has audited at scale. Read the output first.
//
// WHY DELETE RATHER THAN SUPERSEDE: a superseded core memory is still a stored
// sentence saying somebody is 14. The whole point of C1 is that the fact
// should not exist in this table in any state.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment —
// the same pair the functions use. Run it from a machine that already has
// them; do not paste a service-role key onto a command line.

import { createClient } from "@supabase/supabase-js";
import { memoryExclusionReasons } from "../lib/memoryFilter.js";

const APPLY = process.argv.includes("--apply");
const userIdx = process.argv.indexOf("--user");
const ONLY_USER = userIdx !== -1 ? process.argv[userIdx + 1] : null;

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/**
 * Scan one table and report (or delete) every row whose text trips a rule.
 * @param {string} table
 * @param {string[]} textCols - columns concatenated for the check
 */
async function sweep(table, textCols) {
  let query = db.from(table).select(["id", "user_id", ...textCols].join(", "));
  if (ONLY_USER) query = query.eq("user_id", ONLY_USER);

  const { data, error } = await query;
  if (error) {
    console.error(`  ${table}: read failed — ${error.message}`);
    return { scanned: 0, hits: 0, deleted: 0 };
  }

  const rows = data || [];
  const doomed = [];
  for (const row of rows) {
    const text = textCols.map((c) => row[c] || "").join(" ");
    const reasons = memoryExclusionReasons(text);
    if (reasons.length > 0) doomed.push({ row, reasons });
  }

  console.log(`\n  ${table}: ${rows.length} scanned, ${doomed.length} match`);
  for (const { row, reasons } of doomed) {
    const preview = textCols
      .map((c) => row[c] || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    console.log(`    [${reasons.join("+")}] ${row.id}  ${preview}`);
  }

  let deleted = 0;
  if (APPLY && doomed.length > 0) {
    const ids = doomed.map((d) => d.row.id);
    // Chunked: a delete with a few hundred ids in the URL is a 414 waiting
    // to happen, and this runs once against a table nobody has sized.
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const { error: delErr } = await db.from(table).delete().in("id", chunk);
      if (delErr) {
        console.error(`    delete failed for ${chunk.length} rows — ${delErr.message}`);
      } else {
        deleted += chunk.length;
      }
    }
    console.log(`    deleted ${deleted}`);
  }

  return { scanned: rows.length, hits: doomed.length, deleted };
}

console.log(
  APPLY
    ? "PURGING memories that match the exclusion filter."
    : "DRY RUN — nothing will be deleted. Re-run with --apply once the list below looks right."
);
if (ONLY_USER) console.log(`Scoped to user ${ONLY_USER}`);

const a = await sweep("session_memories", ["summary"]);
const b = await sweep("core_memories", ["text", "why_it_carries"]);

const hits = a.hits + b.hits;
console.log(
  `\n${a.scanned + b.scanned} rows scanned, ${hits} matched, ${a.deleted + b.deleted} deleted.`
);
if (!APPLY && hits > 0) {
  console.log("Re-run with --apply to delete them.");
}
