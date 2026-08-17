"""Shadow-mode transcription comparison tool.

Reads paired primary/shadow transcripts from the `transcription_shadow` collection
(populated while TRANSCRIPTION_SHADOW is set) and reports divergence: word-level edit
operations, length drift, and latency. Regression tool for the Speechmatics migration -
run it after a week of shadow traffic, before flipping the default provider.

Usage:
    MONGO_URI="mongodb+srv://..." python plan/transcription_eval.py [--db nueco] [--verbose]

Never prints full transcripts unless --verbose is passed; summaries by default.
"""
import argparse
import difflib
import os
import statistics
import sys

from pymongo import MongoClient

COLLECTION = "transcription_shadow"


def word_diff_ops(a: str, b: str):
    """Count insertions/deletions/substitutions needed to turn transcript a into b."""
    wa, wb = a.split(), b.split()
    matcher = difflib.SequenceMatcher(None, wa, wb, autojunk=False)
    insertions = deletions = substitutions = 0
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "insert":
            insertions += j2 - j1
        elif tag == "delete":
            deletions += i2 - i1
        elif tag == "replace":
            substitutions += max(i2 - i1, j2 - j1)
    return insertions, deletions, substitutions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default=os.getenv("MONGO_DB", "nueco"))
    parser.add_argument("--verbose", action="store_true", help="print each transcript pair")
    args = parser.parse_args()

    uri = os.getenv("MONGO_URI")
    if not uri:
        print("Set MONGO_URI to the database connection string.", file=sys.stderr)
        return 1

    records = list(MongoClient(uri)[args.db][COLLECTION].find().sort("created_at", 1))
    if not records:
        print(f"No shadow records in '{args.db}.{COLLECTION}'.")
        return 0

    print(f"{len(records)} shadow record(s)\n")

    errors = [r for r in records if r.get("shadow_error")]
    ok = [r for r in records if not r.get("shadow_error")]

    if errors:
        print(f"shadow provider failures: {len(errors)}")
        by_kind = {}
        for r in errors:
            kind = r["shadow_error"].split(":", 1)[0]
            by_kind[kind] = by_kind.get(kind, 0) + 1
        for kind, count in sorted(by_kind.items()):
            print(f"  {kind}: {count}")
        print()

    if not ok:
        return 0

    total_ins = total_del = total_sub = total_words = 0
    exact_matches = 0
    primary_latencies, shadow_latencies = [], []
    for r in ok:
        p, s = r["primary_text"] or "", r["shadow_text"] or ""
        ins, dele, sub = word_diff_ops(p, s)
        n_words = len(p.split())
        total_ins += ins
        total_del += dele
        total_sub += sub
        total_words += n_words
        exact_matches += (p.strip() == s.strip())
        if r.get("primary_latency_ms") is not None:
            primary_latencies.append(r["primary_latency_ms"])
        if r.get("shadow_latency_ms") is not None:
            shadow_latencies.append(r["shadow_latency_ms"])
        if args.verbose and (ins or dele or sub):
            print(f"--- record {r['_id']} (ins={ins} del={dele} sub={sub})")
            print(f"primary: {p}")
            print(f"shadow:  {s}")
            print()

    divergent = len(ok) - exact_matches
    print(f"exact matches: {exact_matches}/{len(ok)} ({100 * exact_matches / len(ok):.0f}%)")
    if total_words:
        edit_rate = 100 * (total_ins + total_del + total_sub) / total_words
        print(
            f"word edits vs primary: {total_ins} insertions, {total_del} deletions, "
            f"{total_sub} substitutions ({edit_rate:.1f}% of {total_words} words)"
        )
    for label, lat in (("primary", primary_latencies), ("shadow", shadow_latencies)):
        if lat:
            print(
                f"{label} latency ms: mean={statistics.mean(lat):.0f} "
                f"median={statistics.median(lat):.0f} p95={sorted(lat)[int(0.95 * (len(lat) - 1))]:.0f}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
