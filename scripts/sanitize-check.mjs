// Stage-direction net in lib/sanitize.js: strips lines like "[Pause]" or
// "*takes a hit*", never an italic strain name, a link, or the word in a sentence.
import { stripModelTags, stripLongDashes } from "../lib/sanitize.js";
import { readFileSync } from "node:fs";
const cases = [
 ["...yeah, that's fair. don't gotta say anything.\n\n[Pause]\n\nactually, there's this thing", "...yeah, that's fair. don't gotta say anything.\n\nactually, there's this thing", "the real reply"],
 ["hey\n*takes a hit*\nso anyway", "hey\n\nso anyway", "asterisk action"],
 ["ok\n(long exhale)\nyeah", "ok\n\nyeah", "paren beat"],
 ["[silence]", "", "only a beat"],
 ["try this one:\n\n*Grandaddy Purp*\n\nheavy body", "try this one:\n\n*Grandaddy Purp*\n\nheavy body", "italic strain name kept"],
 ["check [the pH] first", "check [the pH] first", "inline brackets kept"],
 ["a pause is fine sometimes", "a pause is fine sometimes", "the word pause in a sentence kept"],
 ["**Northern Lights**", "**Northern Lights**", "bold strain kept"],
 ["see [link](https://x.y)", "see [link](https://x.y)", "markdown link kept"],
 ["(optional) add cal-mag", "(optional) add cal-mag", "leading paren kept"],
];
let bad=0;
for (const [inp, want, name] of cases) { const got = stripModelTags(inp).replace(/\n{3,}/g,"\n\n"); const ok = got === want.trim(); if(!ok) bad++; console.log(ok?"PASS":"FAIL", name, ok?"":JSON.stringify(got)); }
// Long dashes: the full chat cleanup (tags + stage directions, then dashes)
// on the reply from the screenshot, and the wiring that makes it run at all.
// The dash filter existed but only the Discord bot called it; app replies
// went out with every em dash intact.
const clean = (t) => stripLongDashes(stripModelTags(t));
const dashCases = [
 ["...yeah, that's fair.\n\n[Pause]\n\nhe said something like \u2014 \"I want you\" and that's it \u2014 you showed up.", "...yeah, that's fair.\n\nhe said something like, \"I want you\" and that's it, you showed up.", "screenshot reply: beat and dashes gone"],
 ["water every 4\u20136 days", "water every 4-6 days", "number range kept as a hyphen"],
 ["so yeah \u2014", "so yeah...", "trailing dash becomes a trail-off"],
];
for (const [inp, want, name] of dashCases) { const got = clean(inp); const ok = got === want && !/[\u2014\u2013]/.test(got); if(!ok) bad++; console.log(ok?"PASS":"FAIL", name, ok?"":JSON.stringify(got)); }
{
  const src = readFileSync(new URL("../api/chat-send.js", import.meta.url), "utf8");
  const ok = /reply = stripLongDashes\(reply\);\s*return \{ ok: true, reply/.test(src);
  if (!ok) bad++; console.log(ok?"PASS":"FAIL", "chat-send runs stripLongDashes last on every reply");
}
console.log(bad? "sanitize check: "+bad+" failed":"sanitize check: all passed");
if (bad) process.exit(1);
