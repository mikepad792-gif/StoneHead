#!/usr/bin/env python3
"""
run_eval.py — runs the cultivation-check retrieval cases against cultivation.issues.json.

Lightweight, dependency-free matcher that mimics Phase-1 retrieval: score each issue
against the query by token/phrase overlap, weighting user_phrases highest (they are the
primary match surface for messy input), then symptoms, then name/causes. This tests
whether the DATA's match surface is adequate — not a production ranker.

Pass rules:
  expect_issue   -> id in top_k (rank 1 noted separately)
  expect_cluster -> >=2 distinct cluster ids appear in top_k (cluster surfaced -> ask)
Exits non-zero on any failure.
"""

import json, re, sys
from collections import defaultdict

import os
def _find(name, subdirs=("", "..", "data", "../data", "eval", "../eval")):
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.path.join(here, d, name) for d in subdirs] + [name]
    for c in cands:
        if os.path.exists(c):
            return c
    return os.path.join(here, name)  # default (for writes)
ISSUES = json.load(open(_find("cultivation.issues.json")))["issues"]
EVAL = json.load(open(_find("cultivation-check.json")))
TOP_K = EVAL.get("top_k", 3)
CLUSTER_K = EVAL.get("cluster_top_k", 4)

STOP = set("""a an the is are was were be been being of to in on at for and or with without
from into out up down over under this that these those it its my your you i we they them he she
if then so as but not no yes do does did doing done have has had am me our their his her can could
should would will just really about like looks look looking got get getting some any all lots lot
even though still keeps kept than then near right thing things stuff bit couple really sure why what
whats when how know worry worried okay ok going go went been""".split())

def stem(t):
    # Conservative suffix normalization, applied identically to queries and docs.
    if len(t) > 5 and t.endswith("ing"):
        return t[:-3]
    if len(t) > 4 and t.endswith("ed"):
        return t[:-2]
    if len(t) > 3 and t.endswith("es") and not t.endswith("sses"):
        return t[:-2]
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
        return t[:-1]
    return t

def toks(s):
    raw = [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t and t not in STOP and len(t) > 1]
    return [stem(t) for t in raw]

# Build per-issue weighted token indexes.
W_PHRASE, W_SYMPTOM, W_NAME, W_CAUSE = 3.0, 2.0, 1.5, 1.0
docs = []
for it in ISSUES:
    fields = {
        "phrase": " ".join(it.get("user_phrases", [])),
        "symptom": " ".join(it.get("symptoms", [])),
        "name": it.get("name", ""),
        "cause": " ".join(it.get("likely_causes", [])),
    }
    tokw = defaultdict(float)
    for tok in toks(fields["phrase"]):   tokw[tok] = max(tokw[tok], W_PHRASE)
    for tok in toks(fields["symptom"]):  tokw[tok] = max(tokw[tok], W_SYMPTOM)
    for tok in toks(fields["name"]):     tokw[tok] = max(tokw[tok], W_NAME)
    for tok in toks(fields["cause"]):    tokw[tok] = max(tokw[tok], W_CAUSE)
    docs.append({"id": it["id"], "tokw": tokw,
                 "phrase_tokens": set(toks(fields["phrase"])),
                 "phrase_raw": fields["phrase"].lower()})

def rank(query):
    q = toks(query)
    qset = set(q)
    scored = []
    for d in docs:
        s = sum(d["tokw"].get(t, 0.0) for t in qset)
        # phrase-overlap bonus: reward multiple query tokens co-occurring in user_phrases
        overlap = len(qset & d["phrase_tokens"])
        if overlap >= 2:
            s += 1.5 * (overlap - 1)
        scored.append((s, d["id"]))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return scored

# cluster membership for reporting
CLUSTERS = json.load(open(_find("cultivation.issues.json"))).get("priority_confusable_clusters", {})

passed, failed = 0, 0
rank1 = 0
lines = []
for c in EVAL["retrieval_cases"]:
    scored = rank(c["query"])
    if "expect_cluster" in c:
        k = CLUSTER_K
        topk_ids = [i for _, i in scored[:k]]
        want = set(c["expect_cluster"])
        hit = want & set(topk_ids)
        ok = len(hit) >= 2
        detail = f"cluster hits {sorted(hit)} in top{k}={topk_ids}"
    else:
        k = TOP_K
        topk = scored[:k]
        topk_ids = [i for _, i in topk]
        want_id = c["expect_issue"]
        ok = want_id in topk_ids
        if ok and topk_ids and topk_ids[0] == want_id:
            rank1 += 1
        detail = f"want {want_id!r}; top{k}={topk_ids}"
    if ok:
        passed += 1
        lines.append(f"  PASS [{c['id']}] {detail}")
    else:
        failed += 1
        lines.append(f"  FAIL [{c['id']}] {c['query']!r}\n         -> {detail}")

print(f"cultivation-check retrieval: {len(EVAL['retrieval_cases'])} cases\n")
for l in lines:
    print(l)
single = [c for c in EVAL["retrieval_cases"] if "expect_issue" in c]
print(f"\n  passed={passed} failed={failed}  (rank-1 on single-issue cases: {rank1}/{len(single)})")
print(f"  behavioral cases (runtime, need model): {len(EVAL['behavioral_cases'])}")

if failed:
    print("\nEVAL FAILED")
    sys.exit(1)
print("\nAll retrieval cases passed. \u2713")
