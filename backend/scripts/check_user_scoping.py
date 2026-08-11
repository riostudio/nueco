#!/usr/bin/env python3
"""Fail CI when a query against user data is written without a tenant scope.

WHY THIS EXISTS
MongoDB has no row-level security, so "only return this user's rows" is enforced by remembering
to write `user_id` into every filter. A single omission is a cross-account leak, and it fails
OPEN - the query returns more data, not less, so nothing errors and no test notices. This is the
mechanical backstop for that class of mistake. core/repository.py is the ergonomic fix; this stops
the unsafe pattern spreading.

RATCHET, NOT A WALL
Running this against the existing codebase reports dozens of hits, and a check that fails on
everything from day one is a check somebody disables. So known call sites live in a baseline file
and are tolerated; anything NEW fails the build. The baseline only ever shrinks - remove entries
as services move onto the seam, and it can never silently grow, because regenerating it is an
explicit, reviewable act.

DELIBERATE EXCEPTIONS
Some queries legitimately span users - the reminder cron sweeps every account's due events, auth
looks users up by email before any session exists. Mark those at the call site:

    # user-scope: ignore - cron sweeps all accounts by design
    await self.db.events.find({"reminder_at": {"$lte": now}})

Usage:
    python3 scripts/check_user_scoping.py             # check (exit 1 on new violations)
    python3 scripts/check_user_scoping.py --baseline  # rewrite the baseline
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import Iterator, List, Set, Tuple

BACKEND = Path(__file__).resolve().parent.parent
BASELINE_PATH = BACKEND / "scripts" / "user_scoping_baseline.json"

# Operations that read or mutate rows and therefore need a tenant predicate.
SCOPED_OPS = {
    "find", "find_one", "count_documents",
    "update_one", "update_many",
    "delete_one", "delete_many",
    "find_one_and_delete", "find_one_and_update",
}

# Collections that are NOT per-user-owned, so a user_id filter would be meaningless.
# `users` is keyed by its own id/email; sessions and devices are looked up by token/device id
# during auth, before a scoped handle can exist.
EXEMPT_COLLECTIONS = {"users", "sessions", "devices"}

IGNORE_MARKER = "user-scope: ignore"


def _collection_name(func: ast.Attribute) -> str | None:
    """`self.db.notes.find_one(...)` -> "notes". None when the shape isn't a collection access."""
    owner = func.value
    if isinstance(owner, ast.Attribute):
        return owner.attr
    return None


def _filter_has_user_scope(node: ast.Call) -> bool:
    """True when the first argument is a dict literal containing a user_id key.

    Deliberately conservative: a filter built dynamically (a variable, a merge, a helper call)
    cannot be verified statically, so it is treated as UNSCOPED and must either move onto the
    seam or carry an explicit ignore marker. Guessing in the permissive direction here would
    defeat the point of the check.
    """
    if not node.args:
        return False
    first = node.args[0]
    if not isinstance(first, ast.Dict):
        return False
    for key in first.keys:
        if isinstance(key, ast.Constant) and key.value == "user_id":
            return True
    return False


def scan_file(path: Path) -> Iterator[Tuple[str, int, str]]:
    source = path.read_text(encoding="utf-8")
    lines = source.splitlines()
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(f"::error file={path}::could not parse: {e}", file=sys.stderr)
        return

    rel = str(path.relative_to(BACKEND))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        op = node.func.attr
        if op not in SCOPED_OPS:
            continue
        collection = _collection_name(node.func)
        if collection is None or collection in EXEMPT_COLLECTIONS:
            continue
        if _filter_has_user_scope(node):
            continue

        # An ignore marker on the call line or the line above opts this site out.
        idx = node.lineno - 1
        context = "\n".join(lines[max(0, idx - 1): idx + 1])
        if IGNORE_MARKER in context:
            continue

        yield (rel, node.lineno, f"{collection}.{op}")


def collect() -> List[Tuple[str, int, str]]:
    found: List[Tuple[str, int, str]] = []
    for path in sorted(BACKEND.rglob("*.py")):
        parts = set(path.parts)
        if "__pycache__" in parts or ".venv" in parts or "tests" in parts or "scripts" in parts:
            continue
        # The seam itself is the one place that legitimately queries without a literal user_id -
        # it injects the scope in _scoped() rather than at the call site, which is its entire job.
        if path.name == "repository.py" and path.parent.name == "core":
            continue
        found.extend(scan_file(path))
    return found


def _key(v: Tuple[str, int, str]) -> str:
    # Line numbers deliberately excluded: unrelated edits shift them, and a baseline that churns
    # on every commit is noise. File + operation is specific enough to catch a genuinely new site.
    return f"{v[0]}::{v[2]}"


def main() -> int:
    violations = collect()

    if "--baseline" in sys.argv:
        keys = sorted({_key(v) for v in violations})
        BASELINE_PATH.write_text(json.dumps(keys, indent=2) + "\n", encoding="utf-8")
        print(f"Baseline written: {len(keys)} known unscoped call sites -> {BASELINE_PATH.name}")
        return 0

    baseline: Set[str] = set()
    if BASELINE_PATH.exists():
        baseline = set(json.loads(BASELINE_PATH.read_text(encoding="utf-8")))

    new = [v for v in violations if _key(v) not in baseline]

    if new:
        print("\nUnscoped queries against user data (new since baseline):\n", file=sys.stderr)
        for rel, line, what in new:
            print(f"  {rel}:{line}  {what}", file=sys.stderr)
        print(
            "\nEvery query touching user-owned data must carry a tenant scope.\n"
            "Fix by using the seam:\n"
            "    from core.repository import scoped\n"
            "    await scoped(self.db.notes, user_id).find_one({\"id\": note_id})\n\n"
            "If the query legitimately spans users (a cron sweep, a pre-auth lookup), mark it:\n"
            f"    # {IGNORE_MARKER} - <reason>\n",
            file=sys.stderr,
        )
        return 1

    stale = baseline - {_key(v) for v in violations}
    if stale:
        # Not a failure - it means someone fixed call sites, which is the point. Nudge so the
        # baseline shrinks rather than quietly protecting code that no longer needs it.
        print(f"{len(stale)} baseline entries no longer present - re-run with --baseline to shrink it.")

    print(f"OK: no new unscoped queries ({len(baseline)} known sites in baseline).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
