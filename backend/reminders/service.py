"""Business logic for the reminder-delivery pipeline: claiming due event reminders, sending
them via Expo, tracking delivery receipts, and rolling recurring reminders forward to their
next occurrence. Framework-agnostic - takes `db` and an injected Expo client, raises nothing
HTTP-specific. backend/reminders/router.py's routes are thin adapters over run_tick()/
resolve_receipts().

Each step below is independently testable against a mock-Mongo `db` (see backend/tests/) and,
for send_and_track/resolve_receipts, a fake ExpoClient - no FastAPI app or real network call
needed to exercise the claim-atomicity or recurrence-rollforward correctness properties.
"""
import logging
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorDatabase
from pymongo import ReturnDocument

from events.schemas import Recurrence
from events.service import next_occurrence_on_or_after, reminder_label

from .expo_client import ExpoClient

logger = logging.getLogger(__name__)

# Cap the atomic claim loop so one tick can't run unbounded if a huge backlog is due at once.
MAX_CLAIM_PER_TICK = 500
# A claim older than this is assumed to belong to a tick that crashed between claim and send.
STUCK_CLAIM_MINUTES = 5
# Expo's per-call limit for both the send and getReceipts endpoints.
EXPO_BATCH_SIZE = 100
RECEIPTS_BATCH_SIZE = 300
# Receipts aren't ready at Expo until ~15 min after send; stop chasing one after 24h.
RECEIPT_READY_AFTER_MINUTES = 15
RECEIPT_GIVE_UP_AFTER_HOURS = 24
RECEIPT_FETCH_LIMIT = 1000


class RemindersService:
    def __init__(self, db: AsyncIOMotorDatabase, expo_client: ExpoClient | None = None):
        self.db = db
        self.expo = expo_client or ExpoClient()

    # ---- push_tick pipeline ----

    async def recover_stuck_claims(self, now: datetime) -> None:
        """A prior tick crashed between claim and send - return those events to 'pending'."""
        stuck_before = (now - timedelta(minutes=STUCK_CLAIM_MINUTES)).isoformat()
        await self.db.events.update_many(
            {"reminder_status": "claimed", "reminder_claimed_at": {"$lt": stuck_before}},
            {"$set": {"reminder_status": "pending", "reminder_claimed_at": None}},
        )

    async def claim_due_reminders(self, now_iso: str) -> list[dict]:
        """Atomically claim due, pending reminders. The atomicity here is what stops two
        overlapping ticks from double-sending the same reminder."""
        claimed = []
        while len(claimed) < MAX_CLAIM_PER_TICK:
            ev = await self.db.events.find_one_and_update(
                {"reminder_minutes": {"$ne": None},
                 "reminder_status": "pending",
                 "reminder_fire_at": {"$lte": now_iso}},
                {"$set": {"reminder_status": "claimed", "reminder_claimed_at": now_iso}},
                return_document=ReturnDocument.AFTER,
            )
            if not ev:
                break
            claimed.append(ev)
        return claimed

    async def build_messages(self, claimed: list[dict]) -> list[tuple]:
        """One Expo message per (event, active token). No active tokens -> the reminder is
        immediately 'sent' (nothing to deliver, but it's done)."""
        messages = []
        for ev in claimed:
            tokens = await self.db.push_tokens.find({"user_id": ev["user_id"], "active": True}).to_list(20)
            if not tokens:
                await self.db.events.update_one({"id": ev["id"]}, {"$set": {"reminder_status": "sent"}})
                continue
            # E2EE (Stage 5): an encrypted title is ciphertext to the server, so a reminder
            # push falls back to a generic title rather than showing garbled text. This is
            # a documented non-goal, not a bug - see docs/E2EE-DESIGN.md.
            push_title = 'Event Reminder' if ev.get('enc_version') else (ev.get('title') or 'Event Reminder')
            for t in tokens:
                messages.append((ev["id"], t["token"], {
                    "to": t["token"],
                    "title": f"⏰ {push_title}",
                    "body": f"Starts in {reminder_label(ev.get('reminder_minutes'))}",
                    "data": {"eventId": ev["id"], "kind": "event-reminder"},
                    "sound": "default",
                    "channelId": "event-reminders",
                }))
        return messages

    async def send_and_track(self, messages: list[tuple], now_iso: str) -> tuple[set, list[dict]]:
        """Batch-send via Expo (<=100/call). Expo returns one result PER ITEM - walked
        individually. A whole-batch transport failure leaves those events 'claimed' for the
        stuck-claim recovery to retry on a later tick."""
        processed_event_ids: set = set()
        receipts: list[dict] = []
        for i in range(0, len(messages), EXPO_BATCH_SIZE):
            batch = messages[i:i + EXPO_BATCH_SIZE]
            results = await self.expo.send_batch([m for (_e, _t, m) in batch])
            if results is None:
                continue
            for (eid, token, _msg), result in zip(batch, results):
                processed_event_ids.add(eid)
                if result.get("status") == "ok" and result.get("id"):
                    receipts.append({"ticket_id": result["id"], "event_id": eid, "token": token,
                                     "created_at": now_iso, "checked": False})
                else:
                    err = (result.get("details") or {}).get("error")
                    if err == "DeviceNotRegistered":
                        await self.db.push_tokens.update_one({"token": token}, {"$set": {"active": False}})
                    logger.warning(f"Expo push item error: {result}")

        if processed_event_ids:
            await self.db.events.update_many({"id": {"$in": list(processed_event_ids)}},
                                             {"$set": {"reminder_status": "sent"}})
        return processed_event_ids, receipts

    async def advance_recurring(self, claimed: list[dict], now: datetime) -> None:
        """Advance recurring reminders to their next occurrence.

        Operates ONLY on `claimed` - the exact in-memory list of event documents this tick
        invocation atomically owned via claim_due_reminders' find_one_and_update loop.
        Deliberately NOT a fresh DB query (e.g. `find({"reminder_status": "sent"})`) to find
        "the recurring ones to advance": every event in `claimed` is already 'sent' by this
        point (either directly, in build_messages' no-active-tokens branch, or via
        send_and_track's bulk update), so re-querying by status would let a second, overlapping
        tick match those same just-marked-sent events and race to advance them too - a possible
        double-advance (skipping an occurrence) or write race. The atomic claim guarantees no
        two tick invocations ever claim the same event id, so restricting this step to
        `claimed` makes that race structurally impossible rather than merely unlikely. Each
        event is wrapped in its own try/except so one bad/corrupt recurrence rule can only
        strand that one event on terminal 'sent' instead of aborting the rest of the batch.
        """
        for ev in claimed:
            if not ev.get("recurrence"):
                continue  # non-recurring: already 'sent' above, byte-identical to pre-recurrence behavior
            try:
                recurrence = Recurrence(**ev["recurrence"])
                # +1s so we don't re-match the instant that just fired.
                next_dt = next_occurrence_on_or_after(
                    ev.get("start_time"), recurrence, ev.get("timezone"), now + timedelta(seconds=1),
                )
                if next_dt is None:
                    continue  # series ended (`until` passed, inclusive) - stays terminal 'sent'
                new_fire_at = next_dt - timedelta(minutes=ev["reminder_minutes"])
                await self.db.events.update_one(
                    {"id": ev["id"]},
                    {"$set": {
                        "reminder_status": "pending",
                        "reminder_fire_at": new_fire_at.isoformat(),
                        "reminder_claimed_at": None,
                    }},
                )
            except Exception as e:
                logger.error(f"push_tick: failed to advance recurring event {ev.get('id')}: {e}")

    async def run_tick(self) -> dict:
        """Cron-driven (once/minute). Claims due reminders atomically, sends them via Expo in
        batches, handles per-item results, and records tickets for later receipt resolution.
        Recurring events are additionally rolled forward to their next occurrence at the end."""
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()

        await self.recover_stuck_claims(now)
        claimed = await self.claim_due_reminders(now_iso)
        if not claimed:
            return {"claimed": 0, "sent": 0}

        messages = await self.build_messages(claimed)
        processed_event_ids, receipts = await self.send_and_track(messages, now_iso)
        await self.advance_recurring(claimed, now)

        if receipts:
            await self.db.push_receipts.insert_many(receipts)
        return {"claimed": len(claimed), "sent": len(processed_event_ids), "tickets": len(receipts)}

    # ---- push_receipts_tick pipeline ----

    async def resolve_receipts(self) -> dict:
        """Cron-driven (~every 15-20 min). Resolves Expo delivery receipts; prunes tokens Expo
        reports as DeviceNotRegistered - the main way stale tokens (uninstall/reinstall) get
        cleaned up."""
        now = datetime.now(timezone.utc)
        ready_before = (now - timedelta(minutes=RECEIPT_READY_AFTER_MINUTES)).isoformat()
        give_up_before = (now - timedelta(hours=RECEIPT_GIVE_UP_AFTER_HOURS)).isoformat()
        pending = await self.db.push_receipts.find(
            {"checked": False, "created_at": {"$lte": ready_before}}
        ).to_list(RECEIPT_FETCH_LIMIT)
        if not pending:
            return {"checked": 0}

        checked = 0
        for i in range(0, len(pending), RECEIPTS_BATCH_SIZE):
            batch = pending[i:i + RECEIPTS_BATCH_SIZE]
            data = await self.expo.get_receipts([r["ticket_id"] for r in batch])
            if data is None:
                continue
            for r in batch:
                rec = data.get(r["ticket_id"])
                if rec is None:
                    if r["created_at"] <= give_up_before:  # never resolved - stop chasing it
                        await self.db.push_receipts.update_one({"_id": r["_id"]}, {"$set": {"checked": True}})
                    continue
                if rec.get("status") == "error":
                    err = (rec.get("details") or {}).get("error")
                    if err == "DeviceNotRegistered":
                        await self.db.push_tokens.update_one({"token": r["token"]}, {"$set": {"active": False}})
                    else:
                        logger.warning(f"Push receipt error ({r['ticket_id']}): {rec}")
                await self.db.push_receipts.update_one({"_id": r["_id"]}, {"$set": {"checked": True}})
                checked += 1
        return {"checked": checked}
