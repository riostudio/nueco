"""Thin adapter over Expo's two push-notification HTTP endpoints. The only place network/httpx
concerns touch the reminder pipeline in reminders/service.py - swap this for a fake in tests to
exercise the pipeline's business logic without a network call.

Both endpoint URLs come from core.regions (env-declared, AU-region-checked at startup) -
nothing about where push traffic goes is hardcoded here.
"""
import logging
import os

import httpx

from core import regions

logger = logging.getLogger(__name__)


class ExpoClient:
    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        token = os.environ.get("EXPO_ACCESS_TOKEN")  # optional but recommended for send security
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def send_batch(self, messages: list[dict]) -> list[dict] | None:
        """POST up to 100 push messages. Returns Expo's per-item result list, or None if the
        whole call failed (rate limit / 5xx) - the caller leaves those events 'claimed' for the
        next tick to retry rather than treating a transport failure as per-item failures."""
        send_url = regions.expo_push_send_url()
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                resp = await http.post(send_url, headers=self._headers(), json=messages)
                return resp.json().get("data", [])
        except Exception as e:
            logger.error(f"Expo push send failed (batch left claimed): {e}")
            return None

    async def get_receipts(self, ticket_ids: list[str]) -> dict | None:
        """POST up to 300 ticket ids. Returns Expo's {ticket_id: receipt} map, or None if the
        whole call failed - the caller leaves those receipts unchecked for the next run."""
        receipts_url = regions.expo_push_receipts_url()
        try:
            async with httpx.AsyncClient(timeout=30) as http:
                resp = await http.post(receipts_url, headers=self._headers(), json={"ids": ticket_ids})
                return resp.json().get("data", {})
        except Exception as e:
            logger.error(f"Expo getReceipts failed: {e}")
            return None
