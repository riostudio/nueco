"""
MemoPad Backend API Tests

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
    email = f"pkg1-{uuid.uuid4().hex[:12]}@memopad-test.com"
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

    def test_unknown_freq_returns_none(self, server_module):
        server = server_module
        recurrence = Recurrence(freq="monthly", byweekday=None, until=None)
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
