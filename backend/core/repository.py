"""User-scoped data access seam.

THE PROBLEM THIS SOLVES
Every query against user data has to carry `user_id`, and today that is enforced by remembering
to type it. One omission is a cross-account data leak, and nothing below the call site would
catch it - no test fails, no type error, and the query returns MORE data rather than less, so it
looks like it worked.

MongoDB has no row-level security to fall back on (that is a PostgreSQL feature), so the
enforcement has to live somewhere in our own code. Putting it here means a caller cannot forget:
the scope is applied by construction, not by discipline.

WHAT THIS IS NOT
It is not a full repository abstraction. Services still speak Mongo-shaped queries; this only
guarantees the tenant predicate. That keeps the change mechanical and reviewable rather than a
rewrite of every service, which is what makes it safe to adopt incrementally.

Also see scripts/check_user_scoping.py, which fails CI when a NEW raw query is added without a
user scope - the seam makes the safe path easy, the checker stops the unsafe path spreading.
"""
from typing import Any, Dict, Mapping, Optional

# The field every user-owned document carries. Centralised so a rename is one edit, not a grep.
USER_FIELD = "user_id"


class UserScopedCollection:
    """A Motor collection with the tenant predicate applied to every operation.

    Wraps rather than subclasses: Motor's collection is not designed for subclassing, and wrapping
    means an un-proxied method is a clear AttributeError at the call site instead of silently
    reaching the unscoped collection - failing loudly is the whole point here.
    """

    def __init__(self, collection: Any, user_id: str) -> None:
        if not user_id:
            # An empty user id would scope to `{"user_id": ""}` and quietly match nothing, which
            # reads as "no data" rather than "you have a bug". Refuse to construct instead.
            raise ValueError("UserScopedCollection requires a non-empty user_id")
        self._c = collection
        self._uid = user_id

    def _scoped(self, filter: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
        """Merge the caller's filter with the tenant predicate.

        The scope is applied LAST so a caller cannot override it - passing an explicit
        `{"user_id": someone_else}` is silently corrected rather than honoured. That asymmetry is
        deliberate: there is no legitimate reason for a scoped handle to read another account.
        """
        merged = dict(filter or {})
        merged[USER_FIELD] = self._uid
        return merged

    # --- reads ---
    async def find_one(self, filter: Optional[Mapping[str, Any]] = None, *args: Any, **kwargs: Any):
        return await self._c.find_one(self._scoped(filter), *args, **kwargs)

    def find(self, filter: Optional[Mapping[str, Any]] = None, *args: Any, **kwargs: Any):
        # Returns a cursor, so not awaited here - the caller still chains .sort()/.to_list().
        return self._c.find(self._scoped(filter), *args, **kwargs)

    async def count_documents(self, filter: Optional[Mapping[str, Any]] = None, **kwargs: Any):
        return await self._c.count_documents(self._scoped(filter), **kwargs)

    # --- writes ---
    async def insert_one(self, document: Mapping[str, Any], **kwargs: Any):
        """Stamps ownership rather than trusting the caller to set it, so a document cannot be
        created unowned (invisible to every scoped read) or owned by someone else."""
        doc = dict(document)
        doc[USER_FIELD] = self._uid
        return await self._c.insert_one(doc, **kwargs)

    async def update_one(self, filter: Mapping[str, Any], update: Mapping[str, Any], **kwargs: Any):
        return await self._c.update_one(self._scoped(filter), update, **kwargs)

    async def update_many(self, filter: Mapping[str, Any], update: Mapping[str, Any], **kwargs: Any):
        return await self._c.update_many(self._scoped(filter), update, **kwargs)

    async def delete_one(self, filter: Mapping[str, Any], **kwargs: Any):
        return await self._c.delete_one(self._scoped(filter), **kwargs)

    async def delete_many(self, filter: Mapping[str, Any], **kwargs: Any):
        return await self._c.delete_many(self._scoped(filter), **kwargs)

    async def find_one_and_delete(self, filter: Mapping[str, Any], *args: Any, **kwargs: Any):
        return await self._c.find_one_and_delete(self._scoped(filter), *args, **kwargs)

    async def find_one_and_update(self, filter: Mapping[str, Any], update: Mapping[str, Any], **kwargs: Any):
        return await self._c.find_one_and_update(self._scoped(filter), update, **kwargs)


def scoped(collection: Any, user_id: str) -> UserScopedCollection:
    """Shorthand: `scoped(db.notes, user_id).find_one({"id": note_id})`."""
    return UserScopedCollection(collection, user_id)
