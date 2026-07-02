// lib/cultivationSearch.js
// StoneHead — Cultivation retrieval (Phase 1).
//
// Matches a growing/diagnosing message against data/cultivation.issues.json to
// find the PRIMARY issue, then builds the clarifying cluster from THAT issue's
// hand-authored `confused_with` / `differentiators` — never a keyword matcher's
// noisy top-N. Voice-neutral facts only; prompts/cultivation.js voices them.
//
// The scoring mirrors the validated retrieval eval (scripts/cultivation-eval/
// run_eval.py) so runtime agrees with the 36-case check.

import fs from "fs";
import path from "path";

let issueCache = null;
let docCache = null;
let issueById = null;
let clustersCache = null;

const STOP = new Set(
  `a an the is are was were be been being of to in on at for and or with without
from into out up down over under this that these those it its my your you i we they them he she
if then so as but not no yes do does did doing done have has had am me our their his her can could
should would will just really about like looks look looking got get getting some any all lots lot
even though still keeps kept than then near right thing things stuff bit couple really sure why what
whats when how know worry worried okay ok going go went been`.split(/\s+/)
);

function stem(t) {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("es") && !t.endsWith("sses")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

function toks(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length > 1 && !STOP.has(t))
    .map(stem);
}

const W_PHRASE = 3.0, W_SYMPTOM = 2.0, W_NAME = 1.5, W_CAUSE = 1.0;

function loadIssues() {
  if (issueCache) return issueCache;
  const filePath = path.join(__dirname, "../data/cultivation.issues.json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  issueCache = raw.issues || [];
  issueById = new Map(issueCache.map((it) => [it.id, it]));
  clustersCache = raw.priority_confusable_clusters || {};

  docCache = issueCache.map((it) => {
    const tokw = new Map();
    const bump = (text, w) => {
      for (const t of toks(text)) if ((tokw.get(t) || 0) < w) tokw.set(t, w);
    };
    bump((it.user_phrases || []).join(" "), W_PHRASE);
    bump((it.symptoms || []).join(" "), W_SYMPTOM);
    bump(it.name || "", W_NAME);
    bump((it.likely_causes || []).join(" "), W_CAUSE);
    return {
      id: it.id,
      tokw,
      phraseTokens: new Set(toks((it.user_phrases || []).join(" "))),
    };
  });
  return issueCache;
}

/** Score every issue against a query; return [{id, score}] sorted desc, score>0. */
function rank(message) {
  loadIssues();
  const q = new Set(toks(message));
  const out = [];
  if (q.size === 0) return out;
  for (const d of docCache) {
    let s = 0;
    for (const t of q) s += d.tokw.get(t) || 0;
    let overlap = 0;
    for (const t of q) if (d.phraseTokens.has(t)) overlap++;
    if (overlap >= 2) s += 1.5 * (overlap - 1);
    if (s > 0) out.push({ id: d.id, score: s });
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Resolve a cultivation query to its confusable CLUSTER and a lead hunch.
 *
 * The raw token matcher's top-1 is noisy on terse messages ("white stuff on
 * buds" mis-hits light-burn), so we identify the cluster the query lands in —
 * whichever `priority_confusable_clusters` group has the most members among the
 * top matches — and pick the lead from that clean, curated group. When no
 * cluster is clearly implicated, we fall back to the top issue's own hand-
 * authored `confused_with` (still curated, never the matcher's noisy neighbors).
 *
 * @returns {{ lead: object, members: object[] } | null}
 */
export function retrieveCultivation(message) {
  const ranked = rank(message);
  if (ranked.length === 0) return null;

  const score = new Map(ranked.map((r) => [r.id, r.score]));
  const topId = ranked[0].id;
  const topScore = ranked[0].score;
  const top6 = new Set(ranked.slice(0, 6).map((r) => r.id));

  // A cluster is ELIGIBLE to own the retrieval only if it contains the
  // top-ranked issue (disambiguating AROUND the top match) OR one of its
  // members ties/beats the top score (the flat, terse-message rescue —
  // "white stuff on buds" where everything scores 7.5). A cluster of weak
  // stragglers can no longer outvote a dominant outsider like fungus-gnats
  // or when-to-harvest. Among eligible clusters: most members in the top-6
  // wins, score-sum breaks ties (never JSON key order).
  let best = null; // { members, count, sum }
  for (const members of Object.values(clustersCache)) {
    const present = members.filter((m) => top6.has(m));
    if (present.length < 2) continue;
    const bestMemberScore = Math.max(...present.map((m) => score.get(m) || 0));
    if (!members.includes(topId) && bestMemberScore < topScore) continue;
    const sum = present.reduce((a, m) => a + (score.get(m) || 0), 0);
    if (!best || present.length > best.count || (present.length === best.count && sum > best.sum)) {
      best = { members, count: present.length, sum };
    }
  }

  let memberIds, leadId;
  if (best) {
    memberIds = best.members;
    // Lead = the cluster's best-RANKED member (the matcher's opinion within
    // the curated group). Reassurance-first still applies — a normal/healthy
    // explanation that is an EARLY (top-2) cluster member takes the lead —
    // but only when its score is COMPETITIVE (within 1.5x of the cluster's
    // best). That keeps "white stuff on buds" → trichome-frost, without
    // waving off a dominant "powdery, looks like flour, wipes off" hit
    // (clearly mildew) as "just trichomes."
    const inCluster = memberIds
      .filter((m) => score.has(m))
      .sort((a, b) => score.get(b) - score.get(a));
    const bestMember = inCluster[0];
    const earlyNormal = memberIds.slice(0, 2).find((m) => issueById.get(m)?.is_normal);
    leadId =
      earlyNormal && (score.get(earlyNormal) || 0) * 1.5 >= (score.get(bestMember) || 0)
        ? earlyNormal
        : bestMember;
  } else {
    const prim = issueById.get(topId);
    memberIds = [topId, ...(prim.confused_with || [])];
    leadId = topId;
  }

  const lead = issueById.get(leadId);
  if (!lead) return null;
  const members = memberIds.map((id) => issueById.get(id)).filter(Boolean);
  return { lead, members };
}

/**
 * Build the [CULTIVATION REFERENCE] block from a retrieveCultivation() result:
 * the lead hunch, the "could be X or Y" tells over the cluster, the ONE
 * clarifying question, and severity/reassurance/escalate flags — voice-neutral
 * facts for the model to voice into the four-beat answer.
 *
 * @param {{ lead: object, members: object[] } | null} retrieval
 * @returns {string} injection block, or ""
 */
export function buildCultivationContext(retrieval) {
  if (!retrieval || !retrieval.lead) return "";
  const { lead, members } = retrieval;
  const memberIds = new Set(members.map((m) => m.id));

  const lines = [];
  lines.push(`Most likely: ${lead.name} (severity: ${lead.severity}${lead.is_normal ? "; THIS IS NORMAL/HEALTHY — reassure, don't invent a problem" : ""}).`);

  if (Array.isArray(lead.likely_causes) && lead.likely_causes.length) {
    lines.push(`Lead hunch to commit to out loud: ${lead.likely_causes[0]}`);
  }

  // "Could be X or Y" — the lead's tells against the OTHER cluster members.
  const diffs = (lead.differentiators || [])
    .filter((d) => memberIds.has(d.vs) && d.vs !== lead.id)
    .slice(0, 3);
  if (diffs.length) {
    lines.push('Could be confused with (say "could be X or Y" and give the deciding tell):');
    for (const d of diffs) {
      const other = issueById.get(d.vs);
      lines.push(`  - ${other ? other.name : d.vs}: ${d.tell}`);
    }
  }

  if (Array.isArray(lead.clarifying_questions) && lead.clarifying_questions.length) {
    lines.push(`The ONE deciding question to ask (embed it mid-thought, don't end on it): ${lead.clarifying_questions[0]}`);
  }

  if (lead.is_normal && lead.reassurance) {
    lines.push(`Reassure first: ${lead.reassurance}`);
  }

  if (lead.escalate) {
    let esc = "THIS IS SERIOUS — flag it plainly while staying warm, not clinical.";
    if (lead.category === "disease") {
      esc += " Consumption safety: say plainly that moldy/rotten cannabis must NOT be smoked.";
    }
    lines.push(esc);
  }

  if (lead.fix) lines.push(`Fix once confirmed: ${lead.fix}`);

  return `\n\n[CULTIVATION REFERENCE — facts to voice into the four-beat answer (react warm → commit to the hunch → ask the ONE question mid-thought → close warm). Do not read this out as a list.]\n${lines.join("\n")}`;
}
