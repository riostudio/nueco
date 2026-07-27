"""Shared FastAPI dependencies: current-user resolution and DB access.

Lives here rather than in auth/router.py so the other feature-router modules that need "who's
calling, and give me a db handle" don't depend on a module whose actual purpose is auth's own
HTTP routes (signup/login/password-reset/etc). See CLAUDE.md's Known debt history - every
router.py in this backend used to import these two from auth.router, coupling nine unrelated
features to an implementation detail of the auth module.
"""
from typing import Optional

from fastapi import Depends, Header, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase


async def get_db() -> AsyncIOMotorDatabase:
    # Deferred import: server.py is what constructs `db` and imports every router (directly or
    # transitively) that depends on this module, so importing server.py at module load time
    # here would be circular. By the time a request actually calls this dependency, server.py
    # has finished importing and `db` exists.
    from server import db
    return db


async def get_current_user(
    authorization: Optional[str] = Header(None),
    db: AsyncIOMotorDatabase = Depends(get_db),
) -> dict:
    """Resolve the bearer token to a user document. Raises 401 if missing/invalid/expired,
    or if the token's session has been revoked (logout, or an expired session TTL)."""
    # Deferred import, same reasoning as get_db above: auth/__init__.py eagerly imports
    # auth.router, which imports this module - importing auth.service at module load time here
    # would round-trip back through that and fail as a circular import before either module
    # finishes initializing.
    from auth.service import AuthService

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization.split(" ")[1]
    service = AuthService(db)
    user_id = await service.verify_access_token(token)

    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user = await service.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user
