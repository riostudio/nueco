"""
Nueco Backend API Tests

Runs the real FastAPI app (backend/server.py) in-process against an in-memory
mongomock database, via the shared harness at tests/harness.py (the same
infrastructure the simulation eval suite uses). No live server, no real
MongoDB Atlas connection, no network egress.

The original version of this file made bare `requests` calls to
`EXPO_PUBLIC_BACKEND_URL` with no Authorization header. That URL is unset in
this environment and every endpoint here requires auth, so every test failed
before a single assertion ran. Rewritten to sign up + verify + log in a fresh
isolated user per test (matching how the rest of the test suite authenticates)
and exercise the app in-process instead.

Covers: health check, Notes CRUD (incl. linked_event_ids dual read/write),
Events CRUD/filtering, and the new recurrence/timezone fields (backend
foundation package - see docs plan for "multiple, independently-recurring
reminders per note").
"""
import asyncio
import json
import re
import sys
import types
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

# tests/harness.py is the shared in-process (mongomock + ASGI) bootstrap used by
# the simulation eval suite. Reuse it here instead of hitting a live server.
TESTS_DIR = Path(__file__).resolve().parents[2] / "tests"
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
import harness  # noqa: E402

# Recurrence/next_occurrence_on_or_after live in events/ (not re-exported from server.py -
# server.py no longer imports them now that the reminder-tick pipeline moved to
# backend/reminders/service.py). Imported directly here as ground-truth helpers for
# constructing fixtures/expected values; the actual routes under test are still exercised
# over HTTP via api_client, not by calling these directly.
from events.schemas import Recurrence  # noqa: E402
from events.service import next_occurrence_on_or_after  # noqa: E402
import accounts.service as accounts_service  # noqa: E402
import feedback.service as feedback_service  # noqa: E402
import textai.service as textai_service  # noqa: E402

PASSWORD = "TestPass0rd!"


@pytest.fixture
async def api_client():
    """Fresh isolated DB + a freshly signed-up, verified, logged-in user per test.

    Each test gets a distinct X-Forwarded-For so the per-IP signup rate limiter
    (backend/auth/router.py's AuthRateLimiter) doesn't trip across the whole test run.
    """
    await harness.reset_db()
    n = uuid.uuid4().int
    forwarded_for = f"10.{(n >> 16) % 256}.{(n >> 8) % 256}.{n % 256}"
    client = harness.make_client(forwarded_for=forwarded_for)
    email = f"pkg1-{uuid.uuid4().hex[:12]}@nueco-test.com"
    signup = await client.post("/api/auth/signup", json={
        "name": "Package1 Tester",
        "email": email,
        "password": PASSWORD,
        "confirm_password": PASSWORD,
    })
    assert signup.status_code == 200, signup.text
    await harness.verify_user_email(email)
    login = await client.post("/api/auth/login", json={
        "email": email,
        "password": PASSWORD,
        "device_name": "pytest",
        "platform": "test",
    })
    assert login.status_code == 200, login.text
    data = login.json()
    client.headers["Authorization"] = f"Bearer {data['access_token']}"
    yield client
    await client.aclose()


class TestHealth:
    """Health check endpoint"""

    async def test_health_check(self, api_client):
        response = await api_client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "timestamp" in data


class TestNotesCRUD:
    """Notes CRUD operations with Create->GET verification"""

    async def test_create_note_and_verify_persistence(self, api_client):
        create_payload = {
            "title": "TEST_New Note",
            "content": "This is a test note content",
            "tags": [{"name": "test", "color": "#FF0000"}],
            "is_pinned": False,
        }
        create_response = await api_client.post("/api/notes", json=create_payload)
        assert create_response.status_code == 200

        created_note = create_response.json()
        assert created_note["title"] == create_payload["title"]
        assert created_note["content"] == create_payload["content"]
        assert len(created_note["tags"]) == 1
        assert created_note["tags"][0]["name"] == "test"
        assert "id" in created_note
        assert "created_at" in created_note
        assert "updated_at" in created_note
        note_id = created_note["id"]

        get_response = await api_client.get(f"/api/notes/{note_id}")
        assert get_response.status_code == 200
        retrieved_note = get_response.json()
        assert retrieved_note["id"] == note_id
        assert retrieved_note["title"] == create_payload["title"]
        assert retrieved_note["content"] == create_payload["content"]

    async def test_update_note_and_verify_changes(self, api_client):
        create_payload = {
            "title": "TEST_Original Title",
            "content": "Original content",
            "tags": [],
            "is_pinned": False,
        }
        create_response = await api_client.post("/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]

        update_payload = {
            "title": "TEST_Updated Title",
            "content": "Updated content",
            "tags": [{"name": "updated", "color": "#00FF00"}],
        }
        update_response = await api_client.put(f"/api/notes/{note_id}", json=update_payload)
        assert update_response.status_code == 200
        updated_note = update_response.json()
        assert updated_note["title"] == update_payload["title"]
        assert updated_note["content"] == update_payload["content"]

        get_response = await api_client.get(f"/api/notes/{note_id}")
        assert get_response.status_code == 200
        retrieved_note = get_response.json()
        assert retrieved_note["title"] == "TEST_Updated Title"
        assert retrieved_note["content"] == "Updated content"
        assert len(retrieved_note["tags"]) == 1
        assert retrieved_note["tags"][0]["name"] == "updated"

    async def test_delete_note_and_verify_removal(self, api_client):
        create_payload = {
            "title": "TEST_To Be Deleted",
            "content": "This will be deleted",
            "tags": [],
            "is_pinned": False,
        }
        create_response = await api_client.post("/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]

        delete_response = await api_client.delete(f"/api/notes/{note_id}")
        assert delete_response.status_code == 200
        assert "message" in delete_response.json()

        get_response = await api_client.get(f"/api/notes/{note_id}")
        assert get_response.status_code == 404


class TestNotesFeatures:
    """Pin toggle and pinned-note ordering"""

    async def test_toggle_pin_changes_pin_status(self, api_client):
        create_payload = {
            "title": "TEST_Pin Toggle",
            "content": "Test pin toggle",
            "tags": [],
            "is_pinned": False,
        }
        create_response = await api_client.post("/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]
        assert create_response.json()["is_pinned"] is False

        toggle_response = await api_client.post(f"/api/notes/{note_id}/toggle-pin")
        assert toggle_response.status_code == 200
        assert toggle_response.json()["is_pinned"] is True

        get_response = await api_client.get(f"/api/notes/{note_id}")
        assert get_response.status_code == 200
        assert get_response.json()["is_pinned"] is True

        toggle_response2 = await api_client.post(f"/api/notes/{note_id}/toggle-pin")
        assert toggle_response2.status_code == 200
        assert toggle_response2.json()["is_pinned"] is False

    async def test_pinned_note_appears_first(self, api_client):
        for i in range(3):
            await api_client.post("/api/notes", json={
                "title": f"TEST_Note {i}", "content": "c", "tags": [], "is_pinned": False,
            })
        pinned = await api_client.post("/api/notes", json={
            "title": "TEST_Pinned Note", "content": "c", "tags": [], "is_pinned": True,
        })
        assert pinned.status_code == 200

        response = await api_client.get("/api/notes")
        assert response.status_code == 200
        notes = response.json()
        assert len(notes) >= 4
        assert notes[0]["is_pinned"] is True
        assert notes[0]["title"] == "TEST_Pinned Note"


class TestNotesLinkedEventIds:
    """linked_event_ids (new, plural) alongside linked_event_id (deprecated, singular) -
    dual read/write normalizer, package 1 of the recurrence feature."""

    async def test_create_with_legacy_singular_field_populates_plural(self, api_client):
        """An old client still sending only linked_event_id should see it reflected
        in linked_event_ids too (read-side normalizer)."""
        create = await api_client.post("/api/notes", json={
            "title": "TEST_Legacy Link", "content": "c", "tags": [],
            "linked_event_id": "evt-legacy-1",
        })
        assert create.status_code == 200
        note = create.json()
        assert note["linked_event_id"] == "evt-legacy-1"
        assert note["linked_event_ids"] == ["evt-legacy-1"]

        fetched = await api_client.get(f"/api/notes/{note['id']}")
        assert fetched.json()["linked_event_ids"] == ["evt-legacy-1"]

    async def test_create_with_plural_field_dual_writes_singular(self, api_client):
        """A new client sending linked_event_ids should dual-write linked_event_id
        (first id) so an old app build reading only the singular field still works."""
        create = await api_client.post("/api/notes", json={
            "title": "TEST_Multi Link", "content": "c", "tags": [],
            "linked_event_ids": ["evt-a", "evt-b", "evt-c"],
        })
        assert create.status_code == 200
        note = create.json()
        assert note["linked_event_ids"] == ["evt-a", "evt-b", "evt-c"]
        assert note["linked_event_id"] == "evt-a"

    async def test_update_linked_event_ids_dual_writes_and_round_trips(self, api_client):
        create = await api_client.post("/api/notes", json={"title": "TEST_Link Update", "content": "c", "tags": []})
        note_id = create.json()["id"]

        update = await api_client.put(f"/api/notes/{note_id}", json={"linked_event_ids": ["evt-x", "evt-y"]})
        assert update.status_code == 200
        updated = update.json()
        assert updated["linked_event_ids"] == ["evt-x", "evt-y"]
        assert updated["linked_event_id"] == "evt-x"

        fetched = await api_client.get(f"/api/notes/{note_id}")
        assert fetched.json()["linked_event_ids"] == ["evt-x", "evt-y"]
        assert fetched.json()["linked_event_id"] == "evt-x"

    async def test_explicit_clear_of_linked_event_ids(self, api_client):
        """Explicitly clearing linked_event_ids (null) must actually clear both fields,
        not silently no-op (this is the same class of bug as the update_event fix -
        see TestUpdateEventNoneHandling)."""
        create = await api_client.post("/api/notes", json={
            "title": "TEST_Clear Links", "content": "c", "tags": [],
            "linked_event_ids": ["evt-1"],
        })
        note_id = create.json()["id"]
        assert create.json()["linked_event_id"] == "evt-1"

        update = await api_client.put(f"/api/notes/{note_id}", json={"linked_event_ids": None})
        assert update.status_code == 200
        assert update.json()["linked_event_ids"] == []
        assert update.json()["linked_event_id"] is None

        fetched = await api_client.get(f"/api/notes/{note_id}")
        assert fetched.json()["linked_event_ids"] == []
        assert fetched.json()["linked_event_id"] is None

    async def test_get_notes_list_normalizes_linked_event_ids(self, api_client):
        """The list endpoint (get_notes) uses an explicit Mongo field projection -
        confirm linked_event_ids is actually included and normalized there too,
        not just on the single-note GET."""
        await api_client.post("/api/notes", json={
            "title": "TEST_List Link", "content": "c", "tags": [],
            "linked_event_id": "evt-list-1",
        })
        listed = await api_client.get("/api/notes")
        assert listed.status_code == 200
        found = [n for n in listed.json() if n["title"] == "TEST_List Link"]
        assert len(found) == 1
        assert found[0]["linked_event_ids"] == ["evt-list-1"]


class TestEventsCRUD:
    """Events CRUD operations with Create->GET verification"""

    async def test_create_event_and_verify_persistence(self, api_client):
        create_payload = {
            "title": "TEST_New Event",
            "description": "Test event description",
            "start_time": "2026-03-20T10:00:00Z",
            "end_time": "2026-03-20T11:00:00Z",
            "linked_note_ids": [],
        }
        create_response = await api_client.post("/api/events", json=create_payload)
        assert create_response.status_code == 200
        created_event = create_response.json()
        assert created_event["title"] == create_payload["title"]
        assert created_event["description"] == create_payload["description"]
        assert "id" in created_event
        assert "created_at" in created_event
        event_id = created_event["id"]

        get_response = await api_client.get(f"/api/events/{event_id}")
        assert get_response.status_code == 200
        retrieved_event = get_response.json()
        assert retrieved_event["id"] == event_id
        assert retrieved_event["title"] == create_payload["title"]

    async def test_filter_events_by_month(self, api_client):
        create_payload = {
            "title": "TEST_March Event",
            "description": "Event in March",
            "start_time": "2026-03-15T14:00:00Z",
            "end_time": "2026-03-15T15:00:00Z",
            "linked_note_ids": [],
        }
        create_response = await api_client.post("/api/events", json=create_payload)
        assert create_response.status_code == 200
        event_id = create_response.json()["id"]

        filter_response = await api_client.get("/api/events?month=3&year=2026")
        assert filter_response.status_code == 200
        filtered_events = filter_response.json()
        assert isinstance(filtered_events, list)
        found = any(e["id"] == event_id for e in filtered_events)
        assert found, "Created test event should be in filtered results"
        for event in filtered_events:
            assert event["start_time"].startswith("2026-03")


class TestRecurrenceAndTimezone:
    """New Recurrence model + timezone field (package 1 of the recurrence feature)."""

    async def test_create_update_round_trip(self, api_client):
        payload = {
            "title": "TEST_Recurring Med",
            "description": "",
            "start_time": "2026-08-03T09:00:00Z",  # a Monday
            "end_time": "2026-08-03T09:30:00Z",
            "linked_note_ids": [],
            "recurrence": {"freq": "weekly", "byweekday": [1, 3, 5], "until": "2026-12-31"},
            "timezone": "Australia/Sydney",
        }
        create = await api_client.post("/api/events", json=payload)
        assert create.status_code == 200
        created = create.json()
        assert created["recurrence"] == {"freq": "weekly", "byweekday": [1, 3, 5], "until": "2026-12-31"}
        assert created["timezone"] == "Australia/Sydney"
        event_id = created["id"]

        fetched = await api_client.get(f"/api/events/{event_id}")
        assert fetched.status_code == 200
        assert fetched.json()["recurrence"] == payload["recurrence"]
        assert fetched.json()["timezone"] == "Australia/Sydney"

        # get_events (month-filtered list) uses an explicit projection - confirm
        # recurrence/timezone are actually included there too.
        listed = await api_client.get("/api/events?month=8&year=2026")
        assert listed.status_code == 200
        found = [e for e in listed.json() if e["id"] == event_id]
        assert len(found) == 1
        assert found[0]["recurrence"] == payload["recurrence"]
        assert found[0]["timezone"] == "Australia/Sydney"

        # update: change the recurrence rule and re-verify round trip
        update = await api_client.put(f"/api/events/{event_id}", json={
            "recurrence": {"freq": "daily", "byweekday": None, "until": None},
        })
        assert update.status_code == 200
        assert update.json()["recurrence"] == {"freq": "daily", "byweekday": None, "until": None}

        refetched = await api_client.get(f"/api/events/{event_id}")
        assert refetched.json()["recurrence"] == {"freq": "daily", "byweekday": None, "until": None}

    async def test_non_recurring_event_has_null_recurrence_and_timezone(self, api_client):
        create = await api_client.post("/api/events", json={
            "title": "TEST_Plain Event",
            "start_time": "2026-05-01T10:00:00Z",
            "end_time": "2026-05-01T11:00:00Z",
            "linked_note_ids": [],
        })
        assert create.status_code == 200
        assert create.json()["recurrence"] is None
        assert create.json()["timezone"] is None


class TestUpdateEventNoneHandling:
    """Regression test for the pre-existing bug: update_event had no explicit-None
    allow-list, so PUT-ing reminder_minutes: null (or recurrence: null) to explicitly
    clear a field was silently dropped instead of clearing it."""

    async def test_clearing_reminder_minutes_actually_clears_it(self, api_client):
        create = await api_client.post("/api/events", json={
            "title": "TEST_Reminder Clear",
            "start_time": "2026-09-01T09:00:00Z",
            "end_time": "2026-09-01T10:00:00Z",
            "linked_note_ids": [],
            "reminder_minutes": 15,
        })
        assert create.status_code == 200
        event_id = create.json()["id"]
        assert create.json()["reminder_minutes"] == 15

        update = await api_client.put(f"/api/events/{event_id}", json={"reminder_minutes": None})
        assert update.status_code == 200
        assert update.json()["reminder_minutes"] is None, (
            "reminder_minutes: null must clear the field, not be silently dropped"
        )

        fetched = await api_client.get(f"/api/events/{event_id}")
        assert fetched.status_code == 200
        assert fetched.json()["reminder_minutes"] is None

    async def test_clearing_recurrence_actually_clears_it(self, api_client):
        create = await api_client.post("/api/events", json={
            "title": "TEST_Recurrence Clear",
            "start_time": "2026-09-01T09:00:00Z",
            "end_time": "2026-09-01T10:00:00Z",
            "linked_note_ids": [],
            "recurrence": {"freq": "daily", "byweekday": None, "until": None},
            "timezone": "UTC",
        })
        assert create.status_code == 200
        event_id = create.json()["id"]
        assert create.json()["recurrence"] is not None

        update = await api_client.put(f"/api/events/{event_id}", json={"recurrence": None})
        assert update.status_code == 200
        assert update.json()["recurrence"] is None, (
            "recurrence: null must clear the field, not be silently dropped"
        )

        fetched = await api_client.get(f"/api/events/{event_id}")
        assert fetched.json()["recurrence"] is None

    async def test_unrelated_field_update_does_not_clear_reminder(self, api_client):
        """Sanity check the fix didn't over-broaden: fields NOT in the explicit-None
        allow-list should still ignore an explicit null (unchanged prior behavior),
        and updating an unrelated field must not disturb reminder_minutes."""
        create = await api_client.post("/api/events", json={
            "title": "TEST_Untouched Reminder",
            "start_time": "2026-09-01T09:00:00Z",
            "end_time": "2026-09-01T10:00:00Z",
            "linked_note_ids": [],
            "reminder_minutes": 30,
        })
        event_id = create.json()["id"]

        update = await api_client.put(f"/api/events/{event_id}", json={"title": "TEST_Renamed"})
        assert update.status_code == 200
        assert update.json()["reminder_minutes"] == 30
        assert update.json()["title"] == "TEST_Renamed"


# ---------------------------------------------------------------------------
# next_occurrence_on_or_after - pure unit tests against the server module
# directly (no HTTP), imported via the harness boot() so it's the same module
# instance the app runs (mongomock-patched motor etc.).
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def server_module():
    _, server = harness.boot()
    return server


class TestNextOccurrenceOnOrAfter:

    def test_weekly_rule_start_time_not_on_a_listed_weekday(self, server_module):
        """dtstart is a Tuesday; rule is Mon/Wed/Fri. The first occurrence must land
        on a listed day (not Tuesday) and preserve the original 09:00 time-of-day."""
        server = server_module
        recurrence = Recurrence(freq="weekly", byweekday=[1, 3, 5], until=None)  # Mon, Wed, Fri
        start_time_iso = "2024-01-02T09:00:00Z"  # Tuesday
        after = datetime(2024, 1, 2, 9, 0, 0, tzinfo=timezone.utc)

        result = next_occurrence_on_or_after(start_time_iso, recurrence, "UTC", after)

        assert result is not None
        assert result.weekday() in (0, 2, 4)  # Python Mon=0..Sun=6: Mon/Wed/Fri
        assert result.hour == 9 and result.minute == 0
        assert result.date().isoformat() == "2024-01-03"  # first Wed on/after the Tuesday start

    def test_until_boundary_is_inclusive_both_sides(self, server_module):
        server = server_module
        recurrence = Recurrence(freq="daily", byweekday=None, until="2024-01-05")
        start_time_iso = "2024-01-01T09:00:00Z"

        # Exactly on `until` date -> still returned (inclusive)
        on_boundary = next_occurrence_on_or_after(
            start_time_iso, recurrence, "UTC", datetime(2024, 1, 5, 9, 0, 0, tzinfo=timezone.utc)
        )
        assert on_boundary is not None
        assert on_boundary.date().isoformat() == "2024-01-05"

        # The day after `until` -> nothing left
        past_boundary = next_occurrence_on_or_after(
            start_time_iso, recurrence, "UTC", datetime(2024, 1, 6, 9, 0, 0, tzinfo=timezone.utc)
        )
        assert past_boundary is None

    def test_dst_transition_shifts_utc_instant_but_not_local_hour(self, server_module):
        """America/New_York springs forward on 2025-03-09 (2am -> 3am). A daily 9am
        local reminder must keep firing at 9am local (UTC instant shifts by 1 hour),
        not silently drift to 8am/10am local."""
        server = server_module
        recurrence = Recurrence(freq="daily", byweekday=None, until=None)
        start_time_iso = "2025-03-07T14:00:00Z"  # 2025-03-07 09:00 EST (UTC-5)
        tz = ZoneInfo("America/New_York")

        before = next_occurrence_on_or_after(
            start_time_iso, recurrence, "America/New_York",
            datetime(2025, 3, 8, 9, 0, 0, tzinfo=timezone.utc),  # any time on/before the 8th
        )
        after = next_occurrence_on_or_after(
            start_time_iso, recurrence, "America/New_York",
            datetime(2025, 3, 10, 0, 0, 0, tzinfo=timezone.utc),  # forces the 3/10 occurrence
        )

        assert before is not None and after is not None
        # Local wall-clock hour stays 9am on both sides of the transition.
        assert before.astimezone(tz).hour == 9
        assert after.astimezone(tz).hour == 9
        # But the UTC hour shifts by exactly one hour across the DST transition
        # (EST UTC-5 -> EDT UTC-4).
        assert before.astimezone(timezone.utc).hour == 14  # pre-DST: 9am EST = 14:00 UTC
        assert after.astimezone(timezone.utc).hour == 13   # post-DST: 9am EDT = 13:00 UTC

    def test_falls_back_to_utc_when_timezone_missing(self, server_module):
        server = server_module
        recurrence = Recurrence(freq="daily", byweekday=None, until=None)
        result = next_occurrence_on_or_after(
            "2026-01-01T09:00:00Z", recurrence, None,
            datetime(2026, 1, 1, 9, 0, 0, tzinfo=timezone.utc),
        )
        assert result is not None
        assert result.isoformat() == "2026-01-01T09:00:00+00:00"

    def test_falls_back_to_utc_when_timezone_invalid(self, server_module):
        server = server_module
        recurrence = Recurrence(freq="daily", byweekday=None, until=None)
        result = next_occurrence_on_or_after(
            "2026-01-01T09:00:00Z", recurrence, "Not/AZone",
            datetime(2026, 1, 1, 9, 0, 0, tzinfo=timezone.utc),
        )
        assert result is not None
        assert result.isoformat() == "2026-01-01T09:00:00+00:00"

    def test_monthly_recurs_on_the_same_day_of_month(self, server_module):
        """Monthly/yearly were added to _RRULE_FREQ after this class was written; this asserted
        that "monthly" was unsupported and returned None long after it stopped being true."""
        recurrence = Recurrence(freq="monthly", byweekday=None, until=None)
        result = next_occurrence_on_or_after(
            "2026-01-31T09:00:00Z", recurrence, "UTC",
            datetime(2026, 2, 1, 0, 0, 0, tzinfo=timezone.utc),
        )
        assert result is not None
        assert result.isoformat() == "2026-03-31T09:00:00+00:00", (
            "rrule skips months with no 31st rather than clamping to the 28th"
        )

    def test_unknown_freq_returns_none(self, server_module):
        server = server_module
        recurrence = Recurrence(freq="fortnightly", byweekday=None, until=None)
        result = next_occurrence_on_or_after(
            "2026-01-01T09:00:00Z", recurrence, "UTC",
            datetime(2026, 1, 1, 9, 0, 0, tzinfo=timezone.utc),
        )
        assert result is None


# ---------------------------------------------------------------------------
# push_tick - recurrence-advance step (package 2 of the recurrence feature).
#
# These bypass the API for seeding so a due-in-the-past reminder can be planted
# directly (the API's own compute_reminder_fields would immediately mark a
# past-due fire time 'sent' on create, which is correct product behavior but
# useless for testing the tick job). The event is still owned by a real,
# API-created user so GET /api/events/{id} can verify the post-tick state
# through the normal authenticated read path, not just a raw DB read.
# ---------------------------------------------------------------------------

TICK_SECRET = "pkg2-test-tick-secret"


@pytest.fixture
def tick_headers(monkeypatch):
    """Enable the internal tick endpoint for this test and return its auth header."""
    monkeypatch.setenv("PUSH_TICK_SECRET", TICK_SECRET)
    return {"X-Tick-Secret": TICK_SECRET}


async def _seed_event(server, user_id, *, start_time, reminder_minutes, reminder_fire_at,
                       reminder_status="pending", recurrence=None, timezone_name=None):
    """Insert an event doc straight into the (mongomock) DB with full control over the
    scheduler fields, mirroring create_event's doc shape exactly."""
    event_id = str(uuid.uuid4())
    doc = {
        "id": event_id,
        "title": "TEST_Tick Seed",
        "description": "",
        "location": "",
        "start_time": start_time,
        "end_time": start_time,
        "linked_note_ids": [],
        "reminder_minutes": reminder_minutes,
        "device_calendar_event_id": None,
        "user_id": user_id,
        "enc_version": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "recurrence": recurrence,
        "timezone": timezone_name,
        "reminder_fire_at": reminder_fire_at,
        "reminder_status": reminder_status,
        "reminder_claimed_at": None,
    }
    await server.db.events.insert_one(doc)
    return event_id


async def _get_scheduler_fields(server, event_id: str) -> dict:
    """reminder_status/reminder_fire_at/reminder_claimed_at are internal scheduler
    fields, not exposed on EventResponse - read them straight from the DB."""
    doc = await server.db.events.find_one({"id": event_id}, {"_id": 0})
    assert doc is not None, f"event {event_id} vanished"
    return doc


async def _get_user_id(api_client) -> str:
    me = await api_client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    return me.json()["id"]


class TestPushTickRecurrenceAdvance:

    async def test_due_recurring_event_advances_to_new_pending_not_terminal_sent(
        self, api_client, server_module, tick_headers,
    ):
        server = server_module
        user_id = await _get_user_id(api_client)

        now = datetime.now(timezone.utc)
        start_time = now - timedelta(days=7)  # a past occurrence, same weekday as "now"
        js_weekday = (start_time.weekday() + 1) % 7  # Python Mon=0..Sun=6 -> JS 0=Sun..6=Sat
        original_fire_at = (start_time - timedelta(minutes=10)).isoformat()

        event_id = await _seed_event(
            server, user_id,
            start_time=start_time.isoformat(),
            reminder_minutes=10,
            reminder_fire_at=original_fire_at,
            reminder_status="pending",
            recurrence={"freq": "weekly", "byweekday": [js_weekday], "until": None},
            timezone_name="UTC",
        )

        tick = await api_client.post("/api/internal/push/tick", headers=tick_headers)
        assert tick.status_code == 200, tick.text

        ev = await _get_scheduler_fields(server, event_id)
        assert ev["reminder_status"] == "pending", (
            "recurring event must roll forward to a new pending occurrence, "
            "not get stuck on terminal 'sent'"
        )
        assert ev["reminder_fire_at"] is not None
        new_fire_at = datetime.fromisoformat(ev["reminder_fire_at"])
        assert new_fire_at > datetime.fromisoformat(original_fire_at), (
            "the new reminder_fire_at must be the *next* occurrence, strictly later "
            "than the one that just fired"
        )

    async def test_due_non_recurring_event_behaves_byte_identical_to_before(
        self, api_client, server_module, tick_headers,
    ):
        server = server_module
        user_id = await _get_user_id(api_client)

        now = datetime.now(timezone.utc)
        start_time = now - timedelta(hours=1)
        original_fire_at = (start_time - timedelta(minutes=10)).isoformat()

        event_id = await _seed_event(
            server, user_id,
            start_time=start_time.isoformat(),
            reminder_minutes=10,
            reminder_fire_at=original_fire_at,
            reminder_status="pending",
            recurrence=None,
            timezone_name=None,
        )

        tick = await api_client.post("/api/internal/push/tick", headers=tick_headers)
        assert tick.status_code == 200, tick.text

        ev = await _get_scheduler_fields(server, event_id)
        assert ev["reminder_status"] == "sent"
        assert ev["reminder_fire_at"] == original_fire_at, (
            "non-recurring events must be completely unaffected by the recurrence-"
            "advance step: reminder_fire_at must not change"
        )

    async def test_recurrence_past_until_ends_sent_and_stays_sent(
        self, api_client, server_module, tick_headers,
    ):
        server = server_module
        user_id = await _get_user_id(api_client)

        now = datetime.now(timezone.utc)
        start_time = now - timedelta(days=30)
        until_date = (now - timedelta(days=20)).date().isoformat()  # already passed
        original_fire_at = (start_time - timedelta(minutes=5)).isoformat()

        event_id = await _seed_event(
            server, user_id,
            start_time=start_time.isoformat(),
            reminder_minutes=5,
            reminder_fire_at=original_fire_at,
            reminder_status="pending",
            recurrence={"freq": "daily", "byweekday": None, "until": until_date},
            timezone_name="UTC",
        )

        tick = await api_client.post("/api/internal/push/tick", headers=tick_headers)
        assert tick.status_code == 200, tick.text

        ev = await _get_scheduler_fields(server, event_id)
        assert ev["reminder_status"] == "sent"
        assert ev["reminder_fire_at"] == original_fire_at

        # A second tick must not re-claim (status is 'sent', not 'pending') or
        # otherwise disturb an already-ended series.
        tick2 = await api_client.post("/api/internal/push/tick", headers=tick_headers)
        assert tick2.status_code == 200, tick2.text
        ev2 = await _get_scheduler_fields(server, event_id)
        assert ev2["reminder_status"] == "sent"
        assert ev2["reminder_fire_at"] == original_fire_at

    async def test_overlapping_ticks_cannot_double_claim_or_double_advance(
        self, api_client, server_module, tick_headers,
    ):
        """Regression test for the review-flagged race (plan finding #3): two
        overlapping tick invocations must not both claim (and therefore both
        advance) the same due recurring event. The pre-existing atomic
        find_one_and_update claim in step 2 is what guarantees this - confirm
        that guarantee still holds with the recurrence-advance step added."""
        server = server_module
        user_id = await _get_user_id(api_client)

        now = datetime.now(timezone.utc)
        # Anchor deliberately offset from a whole-day boundary relative to "now"
        # (36h back, not exactly 24h/48h) so "the next daily occurrence after now"
        # is unambiguous even with a couple seconds of test-execution jitter - a
        # double-advance would land a full 24h later than a single advance, easily
        # distinguishable from timing noise.
        start_time = now - timedelta(hours=36)
        original_fire_at = (start_time - timedelta(minutes=5)).isoformat()
        recurrence = Recurrence(freq="daily", byweekday=None, until=None)
        # Ground truth for "one correct advance", computed via the same helper and
        # (approximately) the same after_dt the tick job itself will use - this
        # test is checking that the tick job claims/advances *exactly once*, not
        # re-deriving next_occurrence_on_or_after's own correctness (covered above).
        expected_next = next_occurrence_on_or_after(
            start_time.isoformat(), recurrence, "UTC", now + timedelta(seconds=1),
        )
        assert expected_next is not None

        event_id = await _seed_event(
            server, user_id,
            start_time=start_time.isoformat(),
            reminder_minutes=5,
            reminder_fire_at=original_fire_at,
            reminder_status="pending",
            recurrence={"freq": "daily", "byweekday": None, "until": None},
            timezone_name="UTC",
        )

        # Fire two tick invocations concurrently against the same in-process app,
        # simulating two overlapping cron ticks racing on the same due event.
        results = await asyncio.gather(
            api_client.post("/api/internal/push/tick", headers=tick_headers),
            api_client.post("/api/internal/push/tick", headers=tick_headers),
        )
        for r in results:
            assert r.status_code == 200, r.text

        total_claimed = sum(r.json()["claimed"] for r in results)
        assert total_claimed == 1, (
            f"exactly one of the two overlapping ticks may claim the single due "
            f"event; got combined claimed={total_claimed} across both responses "
            f"({[r.json() for r in results]})"
        )

        ev = await _get_scheduler_fields(server, event_id)
        assert ev["reminder_status"] == "pending"
        new_fire_at = datetime.fromisoformat(ev["reminder_fire_at"])
        assert new_fire_at > datetime.fromisoformat(original_fire_at)

        # A double-advance (the race this guards against) would land ~24h past
        # `expected_next`. Allow generous tolerance for test-execution jitter
        # while staying far short of that 24h gap.
        actual_next = new_fire_at + timedelta(minutes=5)
        drift = abs((actual_next - expected_next).total_seconds())
        assert drift < 3600, (
            f"expected a single-occurrence advance to ~{expected_next.isoformat()}, "
            f"got {actual_next.isoformat()} (drift {drift}s) - looks like a "
            f"double-advance (would land ~24h later)"
        )


# ---------------------------------------------------------------------------
# Voice intent classification (POST /api/classify-voice-intent) - the note editor's mic button
# routes every transcript through this before deciding whether to dictate into the note body or
# hand off to event/trip creation. No live OpenAI call - a fake client stands in for
# get_openai_client() so these tests run offline/without an API key, following the same
# chat.completions.create(...).choices[0].message.content shape the real SDK returns.
# ---------------------------------------------------------------------------

def _fake_openai_client(content: str):
    """A minimal stand-in for AsyncOpenAI exposing only client.chat.completions.create(...),
    returning an object shaped like a real ChatCompletion response (choices[0].message.content)."""
    async def create(**kwargs):
        message = types.SimpleNamespace(content=content)
        choice = types.SimpleNamespace(message=message)
        return types.SimpleNamespace(choices=[choice])

    completions = types.SimpleNamespace(create=create)
    chat = types.SimpleNamespace(completions=completions)
    return types.SimpleNamespace(chat=chat)


class TestVoiceIntentClassification:

    async def test_note_intent_returns_no_events(self, api_client, monkeypatch):
        fake_json = json.dumps({"intent": "note", "trip_name": None, "events": []})
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Remember to buy milk, eggs, and bread for the week",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["intent"] == "note"
        assert data["events"] == []
        assert data["trip_name"] is None

    async def test_single_event_intent_extracts_recurring_event(self, api_client, monkeypatch):
        """Confirms the full shape round-trips, including the 0=Sunday byweekday convention
        (Monday = 1 here) - this must match events/schemas.py's Recurrence exactly, not
        dateutil's own Monday=0 convention."""
        fake_json = json.dumps({
            "intent": "single_event",
            "trip_name": None,
            "events": [{
                "title": "Take out the trash",
                "start_time": "2026-08-03T09:00:00+00:00",
                "end_time": None,
                "location": "",
                "recurrence": {"freq": "weekly", "byweekday": [1], "until": None},
                "confidence": "high",
            }],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Remind me every Monday at 9am to take out the trash",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["intent"] == "single_event"
        assert len(data["events"]) == 1
        ev = data["events"][0]
        assert ev["title"] == "Take out the trash"
        assert ev["start_time"] == "2026-08-03T09:00:00+00:00"
        assert ev["confidence"] == "high"
        assert ev["recurrence"] == {"freq": "weekly", "byweekday": [1], "until": None}

    async def test_extracted_recurring_event_creates_and_computes_correctly(self, api_client, monkeypatch):
        """Classification itself does no date-math (by design - see classify_voice_intent's
        docstring). This confirms an LLM-shaped payload, once confirmed by the user and POSTed
        through the normal event-creation path, produces a real event whose recurrence actually
        computes the expected next occurrence - exercising the already-tested
        next_occurrence_on_or_after path against realistic AI output instead of trusting the
        live model in CI."""
        fake_json = json.dumps({
            "intent": "single_event",
            "trip_name": None,
            "events": [{
                "title": "Standup",
                "start_time": "2026-08-03T09:00:00+00:00",  # a Monday
                "end_time": "2026-08-03T09:30:00+00:00",
                "location": "",
                "recurrence": {"freq": "weekly", "byweekday": [1], "until": None},
                "confidence": "high",
            }],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        classify = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Standup every Monday at 9am",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert classify.status_code == 200, classify.text
        extracted = classify.json()["events"][0]

        create = await api_client.post("/api/events", json={
            "title": extracted["title"],
            "start_time": extracted["start_time"],
            "end_time": extracted["end_time"],
            "location": extracted["location"],
            "recurrence": extracted["recurrence"],
            "timezone": "UTC",
        })
        assert create.status_code == 200, create.text
        event_id = create.json()["id"]

        recurrence = Recurrence(**extracted["recurrence"])
        expected_next = next_occurrence_on_or_after(
            extracted["start_time"], recurrence, "UTC",
            datetime(2026, 8, 10, 0, 0, 0, tzinfo=timezone.utc),
        )
        assert expected_next is not None
        assert expected_next.date().isoformat() == "2026-08-10"  # the following Monday

        got = await api_client.get(f"/api/events/{event_id}")
        assert got.status_code == 200, got.text
        assert got.json()["recurrence"] == {"freq": "weekly", "byweekday": [1], "until": None}

    async def test_multiple_events_intent_returns_all_events(self, api_client, monkeypatch):
        fake_json = json.dumps({
            "intent": "multiple_events",
            "trip_name": None,
            "events": [
                {"title": "Dentist", "start_time": "2026-08-04T14:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "high"},
                {"title": "Haircut", "start_time": "2026-08-06T10:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "high"},
            ],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Schedule a dentist appointment Tuesday at 2 and a haircut Thursday at 10",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["intent"] == "multiple_events"
        assert [e["title"] for e in data["events"]] == ["Dentist", "Haircut"]
        assert data["trip_name"] is None

    async def test_itinerary_intent_returns_trip_name_and_events(self, api_client, monkeypatch):
        fake_json = json.dumps({
            "intent": "itinerary",
            "trip_name": "Tokyo Trip",
            "events": [
                {"title": "Flight to Tokyo", "start_time": "2026-09-01T09:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "high"},
                {"title": "Hotel check-in", "start_time": "2026-09-01T15:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "high"},
                {"title": "Dinner reservation", "start_time": "2026-09-01T19:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "low"},
            ],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Plan my Tokyo trip: flight Friday at 9am, hotel check-in at 3pm, dinner reservation at 7",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["intent"] == "itinerary"
        assert data["trip_name"] == "Tokyo Trip"
        assert len(data["events"]) == 3

    async def test_itinerary_intent_with_missing_trip_name_gets_fallback(self, api_client, monkeypatch):
        fake_json = json.dumps({
            "intent": "itinerary",
            "trip_name": None,
            "events": [
                {"title": "Flight", "start_time": "2026-09-01T09:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "low"},
                {"title": "Hotel", "start_time": "2026-09-01T15:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "low"},
            ],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Flight Friday morning then hotel in the afternoon",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        assert r.json()["trip_name"] == "New Trip"

    async def test_malformed_llm_json_returns_500(self, api_client, monkeypatch):
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client("not valid json"))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Lunch with Sam tomorrow at noon",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 500, r.text

    async def test_non_note_intent_with_no_usable_events_returns_500(self, api_client, monkeypatch):
        fake_json = json.dumps({
            "intent": "single_event",
            "trip_name": None,
            "events": [{"title": "", "start_time": "2026-07-29T12:00:00+00:00", "end_time": None, "location": "", "recurrence": None, "confidence": "low"}],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "mumble mumble",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 500, r.text

    async def test_malformed_recurrence_is_dropped_not_fatal(self, api_client, monkeypatch):
        """An unrecognized freq must not fail the whole extraction - the event still comes
        back (as a one-off), matching smart_format's 'unrecognized note_type -> general'
        fallback style rather than erroring on one bad sub-field."""
        fake_json = json.dumps({
            "intent": "single_event",
            "trip_name": None,
            "events": [{
                "title": "Dentist",
                "start_time": "2026-08-01T10:00:00+00:00",
                "end_time": None,
                "location": "",
                "recurrence": {"freq": "fortnightly", "byweekday": None, "until": None},
                "confidence": "low",
            }],
        })
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Dentist appointment August 1st at 10am",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        assert r.json()["events"][0]["recurrence"] is None

    async def test_unrecognized_intent_falls_back_to_note(self, api_client, monkeypatch):
        fake_json = json.dumps({"intent": "something_else", "trip_name": None, "events": []})
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(fake_json))

        r = await api_client.post("/api/classify-voice-intent", json={
            "transcript": "whatever",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })
        assert r.status_code == 200, r.text
        assert r.json()["intent"] == "note"


# ---------------------------------------------------------------------------
# Trips (itinerary / trip grouping for events) - backend/trips/.
# ---------------------------------------------------------------------------

class TestTripsCRUD:

    async def test_create_list_get_update_delete(self, api_client):
        create = await api_client.post("/api/trips", json={"name": "TEST_Tokyo", "description": "Team offsite"})
        assert create.status_code == 200, create.text
        trip = create.json()
        assert trip["name"] == "TEST_Tokyo"
        assert trip["description"] == "Team offsite"
        assert "id" in trip and "created_at" in trip
        trip_id = trip["id"]

        listed = await api_client.get("/api/trips")
        assert listed.status_code == 200, listed.text
        assert any(t["id"] == trip_id for t in listed.json())

        got = await api_client.get(f"/api/trips/{trip_id}")
        assert got.status_code == 200, got.text
        assert got.json()["name"] == "TEST_Tokyo"

        updated = await api_client.put(f"/api/trips/{trip_id}", json={"name": "TEST_Tokyo Renamed"})
        assert updated.status_code == 200, updated.text
        assert updated.json()["name"] == "TEST_Tokyo Renamed"
        assert updated.json()["description"] == "Team offsite"  # untouched field preserved

        deleted = await api_client.delete(f"/api/trips/{trip_id}")
        assert deleted.status_code == 200, deleted.text

        gone = await api_client.get(f"/api/trips/{trip_id}")
        assert gone.status_code == 404, gone.text

    async def test_get_nonexistent_trip_returns_404(self, api_client):
        r = await api_client.get("/api/trips/does-not-exist")
        assert r.status_code == 404, r.text

    async def test_update_nonexistent_trip_returns_404(self, api_client):
        r = await api_client.put("/api/trips/does-not-exist", json={"name": "X"})
        assert r.status_code == 404, r.text

    async def test_delete_nonexistent_trip_returns_404(self, api_client):
        r = await api_client.delete("/api/trips/does-not-exist")
        assert r.status_code == 404, r.text

    async def test_event_can_be_created_with_trip_id_and_read_back(self, api_client):
        trip = await api_client.post("/api/trips", json={"name": "TEST_Bali"})
        trip_id = trip.json()["id"]

        event = await api_client.post("/api/events", json={
            "title": "TEST_Flight",
            "start_time": "2026-09-01T09:00:00Z",
            "end_time": "2026-09-01T11:00:00Z",
            "linked_note_ids": [],
            "trip_id": trip_id,
        })
        assert event.status_code == 200, event.text
        assert event.json()["trip_id"] == trip_id
        event_id = event.json()["id"]

        got = await api_client.get(f"/api/events/{event_id}")
        assert got.status_code == 200, got.text
        assert got.json()["trip_id"] == trip_id

    async def test_event_trip_id_can_be_set_via_update_and_cleared(self, api_client):
        trip = await api_client.post("/api/trips", json={"name": "TEST_Kyoto"})
        trip_id = trip.json()["id"]

        event = await api_client.post("/api/events", json={
            "title": "TEST_Standalone",
            "start_time": "2026-09-02T09:00:00Z",
            "end_time": "2026-09-02T10:00:00Z",
            "linked_note_ids": [],
        })
        event_id = event.json()["id"]
        assert event.json()["trip_id"] is None

        linked = await api_client.put(f"/api/events/{event_id}", json={"trip_id": trip_id})
        assert linked.status_code == 200, linked.text
        assert linked.json()["trip_id"] == trip_id

        unlinked = await api_client.put(f"/api/events/{event_id}", json={"trip_id": None})
        assert unlinked.status_code == 200, unlinked.text
        assert unlinked.json()["trip_id"] is None

    async def test_deleting_trip_unsets_trip_id_on_its_events(self, api_client):
        trip = await api_client.post("/api/trips", json={"name": "TEST_Osaka"})
        trip_id = trip.json()["id"]

        event = await api_client.post("/api/events", json={
            "title": "TEST_Hotel Checkin",
            "start_time": "2026-09-03T15:00:00Z",
            "end_time": "2026-09-03T15:30:00Z",
            "linked_note_ids": [],
            "trip_id": trip_id,
        })
        event_id = event.json()["id"]

        deleted = await api_client.delete(f"/api/trips/{trip_id}")
        assert deleted.status_code == 200, deleted.text

        got = await api_client.get(f"/api/events/{event_id}")
        assert got.status_code == 200, got.text
        assert got.json()["trip_id"] is None, "event must not be left pointing at a deleted trip"


class TestEventUpdatedAt:
    """`updated_at` on events: client-authoritative on write, backfilled on read.

    Events had no per-write timestamp at all, so the client's offline merge had nothing to
    compare and an already-synced event edited locally lost to the server's stale copy on the
    next pull. These lock in the contract that merge now depends on.
    """

    async def test_create_returns_updated_at_defaulting_to_server_time(self, api_client):
        created = await api_client.post("/api/events", json={
            "title": "TEST_Stamped",
            "start_time": "2026-10-01T09:00:00Z",
            "end_time": "2026-10-01T10:00:00Z",
            "linked_note_ids": [],
        })
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["updated_at"], "every event response must carry updated_at"
        assert body["updated_at"] == body["created_at"], (
            "with no client timestamp sent, a brand-new event's updated_at is its created_at"
        )

    async def test_create_honors_client_supplied_updated_at(self, api_client):
        client_ts = "2026-01-02T03:04:05.678000+00:00"
        created = await api_client.post("/api/events", json={
            "title": "TEST_Client Clock",
            "start_time": "2026-10-02T09:00:00Z",
            "end_time": "2026-10-02T10:00:00Z",
            "linked_note_ids": [],
            "updated_at": client_ts,
        })
        assert created.status_code == 200, created.text
        assert created.json()["updated_at"] == client_ts, (
            "the client's clock must win - the offline merge compares against it, so a "
            "server-stamped time from an earlier round trip could outrank a newer local edit"
        )

    async def test_update_honors_client_supplied_updated_at(self, api_client):
        created = await api_client.post("/api/events", json={
            "title": "TEST_Before",
            "start_time": "2026-10-03T09:00:00Z",
            "end_time": "2026-10-03T10:00:00Z",
            "linked_note_ids": [],
        })
        event_id = created.json()["id"]

        client_ts = "2026-05-06T07:08:09.101112+00:00"
        updated = await api_client.put(f"/api/events/{event_id}", json={
            "title": "TEST_After",
            "updated_at": client_ts,
        })
        assert updated.status_code == 200, updated.text
        assert updated.json()["title"] == "TEST_After"
        assert updated.json()["updated_at"] == client_ts

    async def test_update_without_client_timestamp_advances_updated_at(self, api_client):
        created = await api_client.post("/api/events", json={
            "title": "TEST_Fallback",
            "start_time": "2026-10-04T09:00:00Z",
            "end_time": "2026-10-04T10:00:00Z",
            "linked_note_ids": [],
        })
        original = created.json()["updated_at"]

        updated = await api_client.put(
            f"/api/events/{created.json()['id']}", json={"title": "TEST_Fallback Edited"}
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["updated_at"] > original, (
            "an older app build that sends no timestamp still needs the field to move forward"
        )

    async def test_legacy_event_without_updated_at_is_backfilled_from_created_at(
        self, api_client, server_module,
    ):
        """Events written before the field existed must not come back without it - a client
        merging them would have nothing to compare. Backfilled on read, no migration."""
        user_id = await _get_user_id(api_client)
        event_id = await _seed_event(
            server_module, user_id,
            start_time="2026-10-05T09:00:00+00:00",
            reminder_minutes=None,
            reminder_fire_at=None,
            reminder_status="none",
        )
        raw = await server_module.db.events.find_one({"id": event_id})
        assert "updated_at" not in raw, "fixture must reproduce a pre-updated_at document"

        got = await api_client.get(f"/api/events/{event_id}")
        assert got.status_code == 200, got.text
        assert got.json()["updated_at"] == got.json()["created_at"]

        listed = await api_client.get("/api/events")
        assert listed.status_code == 200, listed.text
        seeded = next(e for e in listed.json() if e["id"] == event_id)
        assert seeded["updated_at"] == seeded["created_at"]

        batched = await api_client.post("/api/events/batch", json={"event_ids": [event_id]})
        assert batched.status_code == 200, batched.text
        assert batched.json()[0]["updated_at"] == batched.json()[0]["created_at"]


class TestCollectionPagination:
    """Paging the list endpoints.

    These endpoints were always paginated; the client just never paged, so it saw the first
    page and treated it as the whole collection. Paging has to be exhaustive (every record
    reachable) and disjoint (no record on two pages) for a client to rebuild its offline store
    from it safely.
    """

    async def test_notes_paging_is_exhaustive_and_disjoint(self, api_client):
        created_ids = []
        for i in range(5):
            response = await api_client.post("/api/notes", json={
                "title": f"TEST_Paged {i}",
                "content": "x",
            })
            assert response.status_code == 200, response.text
            created_ids.append(response.json()["id"])

        seen = []
        for page in range(1, 4):
            response = await api_client.get(f"/api/notes?page={page}&page_size=2")
            assert response.status_code == 200, response.text
            seen.extend(n["id"] for n in response.json())

        assert len(seen) == len(set(seen)) == 5, f"expected 5 distinct notes across pages, got {seen}"
        assert set(seen) == set(created_ids)

    async def test_notes_short_page_marks_the_end_of_the_collection(self, api_client):
        for i in range(3):
            await api_client.post("/api/notes", json={"title": f"TEST_Short {i}", "content": "x"})

        full = await api_client.get("/api/notes?page=1&page_size=2")
        assert len(full.json()) == 2, "a full page means the client must ask for another"
        short = await api_client.get("/api/notes?page=2&page_size=2")
        assert len(short.json()) == 1, "a short page is how the client learns the pull is complete"
        past_end = await api_client.get("/api/notes?page=3&page_size=2")
        assert past_end.json() == [], "paging past the end is empty, not an error"

    async def test_notes_page_size_is_capped(self, api_client):
        response = await api_client.get("/api/notes?page_size=101")
        assert response.status_code == 422, "page_size above the cap must be rejected, not clamped"

    async def test_events_paging_is_exhaustive_and_disjoint(self, api_client):
        created_ids = []
        for day in range(1, 6):
            response = await api_client.post("/api/events", json={
                "title": f"TEST_Paged Event {day}",
                "start_time": f"2026-11-0{day}T09:00:00Z",
                "end_time": f"2026-11-0{day}T10:00:00Z",
                "linked_note_ids": [],
            })
            assert response.status_code == 200, response.text
            created_ids.append(response.json()["id"])

        seen = []
        for page in range(1, 4):
            response = await api_client.get(f"/api/events?page={page}&page_size=2")
            assert response.status_code == 200, response.text
            seen.extend(e["id"] for e in response.json())

        assert len(seen) == len(set(seen)) == 5, f"expected 5 distinct events across pages, got {seen}"
        assert set(seen) == set(created_ids)

    async def test_events_paging_is_disjoint_when_start_times_are_identical(self, api_client):
        """start_time alone is not unique - all-day events on the same date tie exactly. Without
        the `id` tiebreaker in the sort, skip/limit can hand back the same event twice and never
        return another one at all."""
        for _ in range(4):
            response = await api_client.post("/api/events", json={
                "title": "TEST_Same Instant",
                "start_time": "2026-11-20T09:00:00Z",
                "end_time": "2026-11-20T10:00:00Z",
                "linked_note_ids": [],
            })
            assert response.status_code == 200, response.text

        seen = []
        for page in range(1, 3):
            response = await api_client.get(f"/api/events?page={page}&page_size=2")
            seen.extend(e["id"] for e in response.json())
        assert len(seen) == len(set(seen)) == 4, f"tied start_times must still page cleanly: {seen}"

    async def test_events_paging_respects_the_month_filter(self, api_client):
        for month, day in (("11", "10"), ("11", "11"), ("12", "01")):
            await api_client.post("/api/events", json={
                "title": f"TEST_Filtered {month}-{day}",
                "start_time": f"2026-{month}-{day}T09:00:00Z",
                "end_time": f"2026-{month}-{day}T10:00:00Z",
                "linked_note_ids": [],
            })

        page1 = await api_client.get("/api/events?month=11&year=2026&page=1&page_size=1")
        page2 = await api_client.get("/api/events?month=11&year=2026&page=2&page_size=1")
        page3 = await api_client.get("/api/events?month=11&year=2026&page=3&page_size=1")
        assert len(page1.json()) == 1 and len(page2.json()) == 1
        assert page3.json() == [], "the December event must not leak into a November pull"

    async def test_trips_paging_is_exhaustive_and_disjoint(self, api_client):
        created_ids = []
        for i in range(3):
            response = await api_client.post("/api/trips", json={"name": f"TEST_Paged Trip {i}"})
            assert response.status_code == 200, response.text
            created_ids.append(response.json()["id"])

        seen = []
        for page in range(1, 4):
            response = await api_client.get(f"/api/trips?page={page}&page_size=1")
            assert response.status_code == 200, response.text
            seen.extend(t["id"] for t in response.json())

        assert set(seen) == set(created_ids)
        assert len(seen) == len(set(seen)) == 3

    async def test_list_endpoints_still_return_bare_arrays(self, api_client):
        """Released app builds parse these responses as lists. Pagination must not have turned
        any of them into a paging envelope."""
        await api_client.post("/api/notes", json={"title": "TEST_Shape", "content": "x"})
        for path in ("/api/notes", "/api/events", "/api/trips"):
            response = await api_client.get(path)
            assert response.status_code == 200, response.text
            assert isinstance(response.json(), list), f"{path} must stay a bare array"


# ---------------------------------------------------------------------------
# Account erasure (POST /api/account/delete) - GDPR Art. 17
# ---------------------------------------------------------------------------

# `self.db.notes`, `db.users`, ... - how every module reaches a collection.
_COLLECTION_REFERENCE = re.compile(r"\bdb\.([a-z_][a-z0-9_]*)\b")

# Attributes on the database handle itself, not collections. Only needed so the scan below reports
# a genuinely unclassified collection rather than tripping over a driver call.
_DB_HANDLE_ATTRS = {"client", "command", "list_collection_names", "name"}


class TestErasureCoverage:
    """Erasure has to reach every collection, and has to keep reaching them.

    The list of collections to wipe was hand-maintained and had fallen behind the schema: `trips`,
    `feedback` and `user_keys` were written by their modules and never added, so an itinerary, a
    feedback comment and the E2EE key-escrow record each outlived the account that owned them.
    `push_receipts` was worse than missing - it was listed, but its documents carry no `user_id`,
    so the delete matched nothing and the collection looked covered while retaining a row naming
    the user's device for every reminder they were ever sent.
    """

    def test_every_collection_the_backend_writes_is_classified(self):
        """The drift guard. A new collection has to be classified one way or the other, so the
        next module to add one can't quietly reintroduce the bug above."""
        backend_dir = Path(__file__).resolve().parent.parent
        referenced: set[str] = set()
        for path in backend_dir.rglob("*.py"):
            if "tests" in path.parts:
                continue
            # Skip virtualenvs and hidden dirs: site-packages files contain thousands of
            # `db.<something>` examples that are pymongo docs, not backend collections.
            if any(part.startswith(".") or part in {"venv", "site-packages"} for part in path.relative_to(backend_dir).parts):
                continue
            referenced.update(
                name for name in _COLLECTION_REFERENCE.findall(path.read_text())
                if name not in _DB_HANDLE_ATTRS
            )

        assert referenced, "found no collection references at all - the scan pattern is broken"
        declared = (
            set(accounts_service.USER_ID_SCOPED_COLLECTIONS)
            | accounts_service.NON_USER_SCOPED_COLLECTIONS
        )
        assert referenced <= declared, (
            f"unclassified for erasure: {sorted(referenced - declared)}. Add each to "
            "USER_ID_SCOPED_COLLECTIONS in accounts/service.py, or - if it holds no personal data "
            "or is erased another way - to NON_USER_SCOPED_COLLECTIONS with the reason."
        )

    async def _seed_one_document_everywhere(self, api_client, server_module, user_id: str) -> str:
        """Give the user a document in every user-scoped collection. Returns their push token."""
        note = await api_client.post("/api/notes", json={"title": "TEST_Erase", "content": "x"})
        assert note.status_code == 200, note.text
        event = await api_client.post("/api/events", json={
            "title": "TEST_Erase Event",
            "start_time": "2026-11-01T09:00:00Z",
            "end_time": "2026-11-01T10:00:00Z",
            "linked_note_ids": [],
        })
        assert event.status_code == 200, event.text
        trip = await api_client.post("/api/trips", json={"name": "TEST_Erase Trip"})
        assert trip.status_code == 200, trip.text
        # Empty text keeps the AI triage path (and its network call) out of this test.
        given = await api_client.post("/api/feedback", json={"sentiment": "positive", "text": ""})
        assert given.status_code == 200, given.text
        keys = await api_client.put("/api/crypto/wrapped-key", json={
            "wrapped_by_password": "opaque-a",
            "wrapped_by_recovery": "opaque-b",
            "kdf_salt": "salt-a",
            "recovery_salt": "salt-b",
        })
        assert keys.status_code == 200, keys.text
        used = await api_client.post("/api/events/feature", json={"event": "erasure_test"})
        assert used.status_code == 200, used.text

        token = "ExponentPushToken[erasure-test]"
        registered = await api_client.post("/api/push/register", json={
            "token": token, "platform": "ios",
        })
        assert registered.status_code == 200, registered.text
        # As reminders/service.py records a sent push - note the absent user_id.
        await server_module.db.push_receipts.insert_one({
            "ticket_id": "ticket-erasure-test",
            "event_id": event.json()["id"],
            "token": token,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "checked": False,
        })
        return token

    async def test_erasure_leaves_nothing_behind(self, api_client, server_module):
        user_id = await _get_user_id(api_client)
        token = await self._seed_one_document_everywhere(api_client, server_module, user_id)

        # Assert the fixture worked before asserting it was cleared - otherwise a collection that
        # nothing writes to would pass this test while proving nothing.
        for collection in accounts_service.USER_ID_SCOPED_COLLECTIONS:
            assert await server_module.db[collection].count_documents({"user_id": user_id}) > 0, (
                f"fixture wrote nothing to {collection}, so erasing it proves nothing"
            )
        assert await server_module.db.push_receipts.count_documents({"token": token}) == 1

        erased = await api_client.post("/api/account/delete", json={"password": PASSWORD})
        assert erased.status_code == 200, erased.text

        # Every collection in the database, not just the declared ones: iterating the declaration
        # alone would only ever re-check what someone remembered to list, which is the failure this
        # test exists for.
        for collection in await server_module.db.list_collection_names():
            assert await server_module.db[collection].count_documents({"user_id": user_id}) == 0, (
                f"{collection} still holds data for an erased user"
            )
        assert await server_module.db.push_receipts.count_documents({"token": token}) == 0, (
            "push receipts name the user's device and nothing else ever deletes them"
        )
        assert await server_module.db.users.count_documents({"id": user_id}) == 0

    async def test_wrong_password_erases_nothing(self, api_client, server_module):
        user_id = await _get_user_id(api_client)
        await self._seed_one_document_everywhere(api_client, server_module, user_id)

        refused = await api_client.post("/api/account/delete", json={"password": "not-the-password"})
        assert refused.status_code == 401, refused.text

        assert await server_module.db.users.count_documents({"id": user_id}) == 1
        for collection in accounts_service.USER_ID_SCOPED_COLLECTIONS:
            assert await server_module.db[collection].count_documents({"user_id": user_id}) > 0, (
                f"{collection} was cleared despite the password being rejected"
            )


# ---------------------------------------------------------------------------
# Model replies as untrusted input: what the schemas reject, tolerate, and store.
# ---------------------------------------------------------------------------

class TestLLMOutputValidation:
    """A model reply is request-shaped input from outside the trust boundary, and the feedback
    triage reply is the one that gets written to the database. It used to be read off a bare
    json.loads with .get(), so a reply that ignored the prompt - or was steered into ignoring it by
    the user's own feedback text - could store arbitrary strings in the fields triage exists to
    make sortable. The rules now live in the schemas; these cover what that changes.
    """

    TRIAGE_PATH = "/api/feedback"

    async def _submit_with_triage_reply(self, api_client, monkeypatch, reply: str):
        monkeypatch.setattr(
            feedback_service, "get_openai_client", lambda: _fake_openai_client(reply),
        )
        return await api_client.post(self.TRIAGE_PATH, json={
            "sentiment": "negative",
            "text": "The editor lost my note when I hit back.",
        })

    async def _stored_feedback(self, server_module, user_id: str) -> dict:
        doc = await server_module.db.feedback.find_one({"user_id": user_id})
        assert doc is not None, "feedback must be stored whatever triage did"
        return doc

    async def test_valid_triage_is_stored(self, api_client, server_module, monkeypatch):
        user_id = await _get_user_id(api_client)
        reply = json.dumps({
            "category": "bug", "priority": "urgent", "summary": "Note lost on back navigation.",
        })
        response = await self._submit_with_triage_reply(api_client, monkeypatch, reply)
        assert response.status_code == 200, response.text

        doc = await self._stored_feedback(server_module, user_id)
        assert doc["aiCategory"] == "bug"
        assert doc["aiPriority"] == "urgent"
        assert doc["aiSummary"] == "Note lost on back navigation."

    async def test_invented_category_is_not_stored(self, api_client, server_module, monkeypatch):
        """A value outside the closed set is a malformed reply, not a new category - storing it
        would put an unsortable value in the field triage exists to sort by."""
        user_id = await _get_user_id(api_client)
        reply = json.dumps({
            "category": "escalate-to-the-ceo", "priority": "urgent", "summary": "Serious.",
        })
        response = await self._submit_with_triage_reply(api_client, monkeypatch, reply)
        assert response.status_code == 200, f"triage failure must not fail the submission: {response.text}"

        doc = await self._stored_feedback(server_module, user_id)
        assert doc["aiCategory"] is None
        assert doc["aiPriority"] is None, "the whole triage is rejected, not the bad field alone"
        assert doc["aiSummary"] is None
        assert doc["text"] == "The editor lost my note when I hit back.", "the feedback itself survives"

    async def test_oversized_summary_is_not_stored(self, api_client, server_module, monkeypatch):
        """The prompt asks for one short sentence. A reply this far off-script is not trustworthy,
        and it is the path by which prompt-injected text would reach the database."""
        user_id = await _get_user_id(api_client)
        reply = json.dumps({
            "category": "bug", "priority": "high", "summary": "x" * 5000,
        })
        response = await self._submit_with_triage_reply(api_client, monkeypatch, reply)
        assert response.status_code == 200, response.text

        doc = await self._stored_feedback(server_module, user_id)
        assert doc["aiSummary"] is None

    async def test_triage_reply_that_is_not_json_leaves_the_fields_null(
        self, api_client, server_module, monkeypatch,
    ):
        user_id = await _get_user_id(api_client)
        response = await self._submit_with_triage_reply(api_client, monkeypatch, "I'd say it's a bug!")
        assert response.status_code == 200, response.text

        doc = await self._stored_feedback(server_module, user_id)
        assert (doc["aiCategory"], doc["aiPriority"], doc["aiSummary"]) == (None, None, None)

    async def _classify(self, api_client, monkeypatch, payload: dict):
        monkeypatch.setattr(
            textai_service, "get_openai_client", lambda: _fake_openai_client(json.dumps(payload)),
        )
        return await api_client.post("/api/classify-voice-intent", json={
            "transcript": "Dinner with Sam on Friday at 7",
            "reference_date": "2026-07-28",
            "timezone": "UTC",
        })

    async def test_unrecognized_confidence_degrades_to_low(self, api_client, monkeypatch):
        """Confidence only decides whether the UI asks the user to confirm the time, so an
        unreadable value must cost the confirmation prompt, not the event."""
        response = await self._classify(api_client, monkeypatch, {
            "intent": "single_event",
            "events": [{
                "title": "Dinner with Sam",
                "start_time": "2026-07-31T19:00:00+00:00",
                "confidence": "pretty sure",
            }],
        })
        assert response.status_code == 200, response.text
        assert response.json()["events"][0]["confidence"] == "low"

    async def test_boolean_weekday_does_not_become_monday(self, api_client, monkeypatch):
        """`true` is an int in Python, so an unchecked byweekday would read it as weekday 1 and
        schedule a repeat the user never asked for. The rest of the recurrence is still usable."""
        response = await self._classify(api_client, monkeypatch, {
            "intent": "single_event",
            "events": [{
                "title": "Standup",
                "start_time": "2026-07-31T09:00:00+00:00",
                "recurrence": {"freq": "weekly", "byweekday": [True], "until": None},
            }],
        })
        assert response.status_code == 200, response.text
        recurrence = response.json()["events"][0]["recurrence"]
        assert recurrence is not None, "a weekly rule stays weekly"
        assert recurrence["byweekday"] is None, "an unusable weekday list is dropped, not coerced"

    async def test_unusable_event_is_dropped_without_taking_its_siblings(
        self, api_client, monkeypatch,
    ):
        response = await self._classify(api_client, monkeypatch, {
            "intent": "itinerary",
            "trip_name": "Tokyo",
            "events": [
                {"title": "   ", "start_time": "2026-07-31T09:00:00+00:00"},
                {"title": "Flight", "start_time": "2026-07-31T11:00:00+00:00"},
                {"title": "Hotel check-in", "start_time": ""},
            ],
        })
        assert response.status_code == 200, response.text
        titles = [e["title"] for e in response.json()["events"]]
        assert titles == ["Flight"], "one unusable entry must not cost the whole itinerary"

    async def test_events_that_are_not_a_list_are_treated_as_none_extracted(
        self, api_client, monkeypatch,
    ):
        response = await self._classify(api_client, monkeypatch, {
            "intent": "single_event",
            "events": {"title": "Dinner", "start_time": "2026-07-31T19:00:00+00:00"},
        })
        assert response.status_code == 500, response.text

    async def test_unrecognized_note_type_degrades_to_general(self, api_client, monkeypatch):
        """smart_format's note_type only picks a formatting template, so an unknown one must not
        cost the user the restructured text the model did produce."""
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client(
            json.dumps({"note_type": "shopping_list", "html": "<ul><li>milk</li></ul>"}),
        ))
        response = await api_client.post("/api/process-text", json={
            "text": "milk", "action": "smart_format",
        })
        assert response.status_code == 200, response.text
        assert response.json()["note_type"] == "general"
        assert response.json()["text"] == "<ul><li>milk</li></ul>"

    async def test_non_classifying_actions_answer_with_text_alone(self, api_client, monkeypatch):
        """organize/summarize don't classify, and released builds expect note_type to be absent
        rather than null - see the response_model_exclude_none note on the route."""
        monkeypatch.setattr(
            textai_service, "get_openai_client", lambda: _fake_openai_client("Tidied up."),
        )
        response = await api_client.post("/api/process-text", json={
            "text": "some rambling text", "action": "organize",
        })
        assert response.status_code == 200, response.text
        assert response.json() == {"text": "Tidied up."}

    async def test_unknown_action_is_still_a_400(self, api_client):
        """The action check moved into the schema module's declared set; the client-facing
        contract (400 with a message, not a 422) must not have moved with it."""
        response = await api_client.post("/api/process-text", json={
            "text": "x", "action": "translate",
        })
        assert response.status_code == 400, response.text


# ---------------------------------------------------------------------------
# Artifact extraction (POST /api/extract-artifacts) - A4. The full transcript is always the note;
# artifacts are additive extras and each carries a source_span the server verifies against the
# transcript. Same fake-client pattern as the voice-intent tests above: no live OpenAI call.
# ---------------------------------------------------------------------------

EXTRACTION_TRANSCRIPT = (
    "Tomorrow I need to buy milk and two eggs, and I have to call the plumber at 3pm. "
    "Also remember to water the plants. Honestly today felt long."
)


class TestArtifactExtraction:

    async def _extract(self, api_client, monkeypatch, payload: dict, transcript: str = EXTRACTION_TRANSCRIPT):
        monkeypatch.setattr(
            textai_service, "get_openai_client", lambda: _fake_openai_client(json.dumps(payload)),
        )
        return await api_client.post("/api/extract-artifacts", json={
            "transcript": transcript,
            "reference_date": "2026-07-30",
            "timezone": "Australia/Sydney",
        })

    async def test_note_content_always_echoes_full_transcript(self, api_client, monkeypatch):
        """The note is the source of truth and never depends on what the model repeated."""
        response = await self._extract(api_client, monkeypatch, {
            "events": [], "shopping_items": [], "checklist_items": [], "trip": None,
        })
        assert response.status_code == 200, response.text
        assert response.json()["note_content"] == EXTRACTION_TRANSCRIPT

    async def test_grounded_artifacts_round_trip(self, api_client, monkeypatch):
        response = await self._extract(api_client, monkeypatch, {
            "events": [{
                "title": "Call the plumber",
                "start_time": "2026-07-31T15:00:00+10:00",
                "end_time": None, "location": "", "recurrence": None,
                "confidence": "high", "source_span": "call the plumber at 3pm",
            }],
            "shopping_items": [
                {"text": "milk", "confidence": "high", "source_span": "buy milk"},
                {"text": "two eggs", "confidence": "high", "source_span": "two eggs"},
            ],
            "checklist_items": [
                {"text": "Water the plants", "confidence": "high", "source_span": "water the plants"},
            ],
            "trip": None,
        })
        assert response.status_code == 200, response.text
        data = response.json()
        assert len(data["events"]) == 1
        assert data["events"][0]["source_span"] == "call the plumber at 3pm"
        assert [i["text"] for i in data["shopping_items"]] == ["milk", "two eggs"]
        assert [i["text"] for i in data["checklist_items"]] == ["Water the plants"]
        assert data["trip"] is None

    async def test_fabricated_span_is_dropped_grounded_sibling_kept(self, api_client, monkeypatch):
        """The plan's zero-fabrication gate: an item whose source_span isn't in the transcript is
        dropped, but per-entry - it must not cost a real item beside it."""
        response = await self._extract(api_client, monkeypatch, {
            "events": [],
            "shopping_items": [
                {"text": "milk", "confidence": "high", "source_span": "buy milk"},
                {"text": "goldfish", "confidence": "high", "source_span": "buy a goldfish"},
            ],
            "checklist_items": [], "trip": None,
        })
        assert response.status_code == 200, response.text
        items = response.json()["shopping_items"]
        assert [i["text"] for i in items] == ["milk"]

    async def test_missing_source_span_is_dropped(self, api_client, monkeypatch):
        """source_span is mandatory (plan: no exceptions) - an item without one never ships."""
        response = await self._extract(api_client, monkeypatch, {
            "events": [],
            "shopping_items": [{"text": "milk", "confidence": "high"}],
            "checklist_items": [{"text": "water plants", "confidence": "low", "source_span": "   "}],
            "trip": None,
        })
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["shopping_items"] == []
        assert data["checklist_items"] == []

    async def test_span_matching_ignores_whitespace_reflow_only(self, api_client, monkeypatch):
        """The model may re-flow whitespace inside a span, but not change the words."""
        response = await self._extract(api_client, monkeypatch, {
            "events": [],
            "shopping_items": [
                {"text": "milk", "confidence": "high", "source_span": "buy   milk"},
                {"text": "butter", "confidence": "high", "source_span": "buy butter"},
            ],
            "checklist_items": [], "trip": None,
        })
        assert response.status_code == 200, response.text
        assert [i["text"] for i in response.json()["shopping_items"]] == ["milk"]

    async def test_storytelling_yields_no_artifacts(self, api_client, monkeypatch):
        """Conversational input must not become artifact clutter - empty lists are the right answer,
        and the transcript still comes back as the note."""
        response = await self._extract(api_client, monkeypatch, {
            "events": [], "shopping_items": [], "checklist_items": [], "trip": None,
        }, transcript="Honestly today felt long and I just want to rest.")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["note_content"] == "Honestly today felt long and I just want to rest."
        assert data["events"] == []
        assert data["shopping_items"] == []
        assert data["checklist_items"] == []
        assert data["trip"] is None

    async def test_trip_returned_when_grounded(self, api_client, monkeypatch):
        trip_transcript = "Plan my Tokyo trip: flight Friday at 9am, hotel check-in at 3pm."
        response = await self._extract(api_client, monkeypatch, {
            "events": [], "shopping_items": [], "checklist_items": [],
            "trip": {
                "name": "Tokyo trip",
                "source_span": "Plan my Tokyo trip",
                "events": [{
                    "title": "Flight", "start_time": "2026-07-31T09:00:00+10:00",
                    "end_time": None, "location": "", "recurrence": None,
                    "confidence": "high", "source_span": "flight Friday at 9am",
                }],
            },
        }, transcript=trip_transcript)
        assert response.status_code == 200, response.text
        trip = response.json()["trip"]
        assert trip["name"] == "Tokyo trip"
        assert len(trip["events"]) == 1

    async def test_trip_with_ungrounded_span_is_dropped(self, api_client, monkeypatch):
        response = await self._extract(api_client, monkeypatch, {
            "events": [], "shopping_items": [], "checklist_items": [],
            "trip": {"name": "Paris", "source_span": "plan my Paris getaway", "events": []},
        })
        assert response.status_code == 200, response.text
        assert response.json()["trip"] is None

    async def test_malformed_json_returns_500(self, api_client, monkeypatch):
        monkeypatch.setattr(textai_service, "get_openai_client", lambda: _fake_openai_client("not valid json"))
        response = await api_client.post("/api/extract-artifacts", json={
            "transcript": EXTRACTION_TRANSCRIPT,
            "reference_date": "2026-07-30",
            "timezone": "Australia/Sydney",
        })
        assert response.status_code == 500, response.text

    async def test_empty_transcript_is_a_422(self, api_client):
        response = await api_client.post("/api/extract-artifacts", json={
            "transcript": "", "reference_date": "2026-07-30", "timezone": "Australia/Sydney",
        })
        assert response.status_code == 422, response.text
