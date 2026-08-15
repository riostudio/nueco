import os
import base64
import hashlib
import secrets
import time
import logging
from datetime import datetime, timedelta
from typing import Optional, Tuple
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet
from motor.motor_asyncio import AsyncIOMotorDatabase

from core import regions

logger = logging.getLogger(__name__)

CANVA_CLIENT_ID = os.getenv("CANVA_CLIENT_ID")
CANVA_CLIENT_SECRET = os.getenv("CANVA_CLIENT_SECRET")
CANVA_TOKEN_ENCRYPTION_KEY = os.getenv("CANVA_TOKEN_ENCRYPTION_KEY")

# No hardcoded Canva endpoints: authorize/token/API base URLs are the residency-checked
# declarations in core.regions, validated against the AU allowlist at startup.
SCOPES = "design:meta:read design:content:read"

# In-memory PKCE state store: state token -> (code_verifier, user_id, expires_at epoch seconds).
# Railway runs a single replica for this service today, so in-memory is fine for a handshake
# window measured in minutes - if that ever changes to multiple replicas, move this to a
# short-TTL Mongo collection instead so a callback can land on a different instance than /connect.
_pending_states: dict[str, tuple[str, str, float]] = {}
_STATE_TTL_SECONDS = 600  # 10 minutes - generous for "switch to Canva, log in, approve"


def _require_credentials() -> None:
    if not CANVA_CLIENT_ID or not CANVA_CLIENT_SECRET:
        raise RuntimeError("CANVA_CLIENT_ID/CANVA_CLIENT_SECRET environment variables are required")


def _get_fernet() -> Fernet:
    if not CANVA_TOKEN_ENCRYPTION_KEY:
        raise RuntimeError("CANVA_TOKEN_ENCRYPTION_KEY environment variable is required")
    return Fernet(CANVA_TOKEN_ENCRYPTION_KEY.encode())


def _encrypt(value: str) -> str:
    return _get_fernet().encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    return _get_fernet().decrypt(value.encode()).decode()


def _cleanup_expired_states() -> None:
    now = time.time()
    expired = [s for s, (_, _, exp) in _pending_states.items() if exp < now]
    for s in expired:
        _pending_states.pop(s, None)


def _basic_auth_header() -> str:
    raw = f"{CANVA_CLIENT_ID}:{CANVA_CLIENT_SECRET}".encode()
    return f"Basic {base64.b64encode(raw).decode()}"


class CanvaService:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.users = db.users

    def build_authorize_url(self, user_id: str, redirect_uri: str) -> str:
        """Generates a PKCE pair, stashes the verifier against a fresh state token (keyed to
        this user so the callback can't be replayed against a different account), and returns
        the URL to send the user's browser to."""
        _require_credentials()
        _cleanup_expired_states()

        # 43-128 chars of high-entropy randomness per Canva's PKCE spec.
        code_verifier = secrets.token_urlsafe(96)[:128]
        challenge_bytes = hashlib.sha256(code_verifier.encode()).digest()
        code_challenge = base64.urlsafe_b64encode(challenge_bytes).decode().rstrip("=")

        state = secrets.token_urlsafe(32)
        _pending_states[state] = (code_verifier, user_id, time.time() + _STATE_TTL_SECONDS)

        params = {
            "code_challenge": code_challenge,
            "code_challenge_method": "s256",
            "scope": SCOPES,
            "response_type": "code",
            "client_id": CANVA_CLIENT_ID,
            "state": state,
            "redirect_uri": redirect_uri,
        }
        return f"{regions.canva_authorize_url()}?{urlencode(params)}"

    async def exchange_code(self, code: str, state: str, redirect_uri: str) -> Tuple[bool, str]:
        """Handles the OAuth redirect: validates the state token, exchanges the code for
        tokens, and stores them encrypted on the user doc."""
        _require_credentials()
        _cleanup_expired_states()

        pending = _pending_states.pop(state, None)
        if not pending:
            return False, "This connection link has expired or was already used - please try connecting again."
        code_verifier, user_id, expires_at = pending
        if expires_at < time.time():
            return False, "This connection link has expired - please try connecting again."

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                regions.canva_token_url(),
                headers={
                    "Authorization": _basic_auth_header(),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": code_verifier,
                    "redirect_uri": redirect_uri,
                },
            )
        if resp.status_code != 200:
            logger.error(f"Canva token exchange failed: {resp.status_code} {resp.text}")
            return False, "Canva didn't accept that connection. Please try again."

        await self._store_tokens(user_id, resp.json())
        return True, "Connected"

    async def _store_tokens(self, user_id: str, payload: dict) -> None:
        expires_in = payload.get("expires_in", 0)
        await self.users.update_one(
            {"id": user_id},
            {"$set": {
                "canva_access_token": _encrypt(payload["access_token"]),
                "canva_refresh_token": _encrypt(payload["refresh_token"]),
                "canva_token_expires_at": datetime.utcnow() + timedelta(seconds=expires_in),
                "canva_connected_at": datetime.utcnow(),
            }},
        )

    async def get_status(self, user_id: str) -> dict:
        user = await self.users.find_one({"id": user_id})
        connected = bool(user and user.get("canva_refresh_token"))
        return {
            "connected": connected,
            "connected_at": user.get("canva_connected_at") if connected else None,
        }

    async def disconnect(self, user_id: str) -> None:
        await self.users.update_one(
            {"id": user_id},
            {"$unset": {
                "canva_access_token": "",
                "canva_refresh_token": "",
                "canva_token_expires_at": "",
                "canva_connected_at": "",
            }},
        )

    async def _get_valid_access_token(self, user_id: str) -> Optional[str]:
        """Returns a usable access token, refreshing first if it's expired or about to be.
        Canva refresh tokens are single-use - the new one that comes back with every refresh
        MUST be persisted immediately, or the next refresh silently fails."""
        user = await self.users.find_one({"id": user_id})
        if not user or not user.get("canva_refresh_token"):
            return None

        expires_at = user.get("canva_token_expires_at")
        needs_refresh = not expires_at or expires_at <= datetime.utcnow() + timedelta(seconds=60)
        if not needs_refresh:
            return _decrypt(user["canva_access_token"])

        _require_credentials()
        refresh_token = _decrypt(user["canva_refresh_token"])
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                regions.canva_token_url(),
                headers={
                    "Authorization": _basic_auth_header(),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "refresh_token", "refresh_token": refresh_token},
            )
        if resp.status_code != 200:
            logger.error(f"Canva token refresh failed: {resp.status_code} {resp.text}")
            # Refresh failed (revoked/expired on Canva's side) - clear the connection so the UI
            # prompts to reconnect instead of retrying a dead refresh token forever.
            await self.disconnect(user_id)
            return None

        payload = resp.json()
        await self._store_tokens(user_id, payload)
        return payload["access_token"]

    async def list_designs(self, user_id: str, query: Optional[str], continuation: Optional[str]) -> Tuple[bool, dict]:
        token = await self._get_valid_access_token(user_id)
        if not token:
            return False, {"detail": "Not connected to Canva"}

        params = {}
        if query:
            params["query"] = query
        if continuation:
            params["continuation"] = continuation

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{regions.canva_api_base_url()}/designs",
                headers={"Authorization": f"Bearer {token}"},
                params=params,
            )
        if resp.status_code != 200:
            logger.error(f"Canva list designs failed: {resp.status_code} {resp.text}")
            return False, {"detail": "Could not load your Canva designs. Please try again."}

        data = resp.json()
        designs = [
            {
                "id": d["id"],
                "title": d.get("title") or "Untitled design",
                "thumbnail_url": (d.get("thumbnail") or {}).get("url"),
                "updated_at": d.get("updated_at"),
            }
            for d in data.get("items", [])
        ]
        return True, {"designs": designs, "continuation": data.get("continuation")}

    async def create_export(self, user_id: str, design_id: str) -> Tuple[bool, dict]:
        token = await self._get_valid_access_token(user_id)
        if not token:
            return False, {"detail": "Not connected to Canva"}

        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{regions.canva_api_base_url()}/exports",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"design_id": design_id, "format": {"type": "png"}},
            )
        if resp.status_code not in (200, 202):
            logger.error(f"Canva export create failed: {resp.status_code} {resp.text}")
            return False, {"detail": "Could not start exporting that design. Please try again."}

        job = resp.json().get("job", {})
        return True, {"job_id": job.get("id"), "status": job.get("status")}

    async def get_export_status(self, user_id: str, job_id: str) -> Tuple[bool, dict]:
        token = await self._get_valid_access_token(user_id)
        if not token:
            return False, {"detail": "Not connected to Canva"}

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{regions.canva_api_base_url()}/exports/{job_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
        if resp.status_code != 200:
            logger.error(f"Canva export status failed: {resp.status_code} {resp.text}")
            return False, {"detail": "Could not check export status. Please try again."}

        job = resp.json().get("job", {})
        urls = job.get("urls") or []
        return True, {
            "status": job.get("status"),
            "download_url": urls[0] if urls else None,
        }
