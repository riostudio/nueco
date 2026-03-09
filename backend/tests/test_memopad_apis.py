"""
MemoPad Backend API Tests
Tests for: Health check, Notes CRUD, Pin toggle, Search, Events CRUD, Events filtering
"""
import pytest
import requests
import os

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')

@pytest.fixture
def api_client():
    """Shared requests session"""
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    return session


class TestHealth:
    """Health check endpoint"""
    
    def test_health_check(self, api_client):
        response = api_client.get(f"{BASE_URL}/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert "timestamp" in data
        print("✓ Health check passed")


class TestNotesSeededData:
    """Test seeded notes data"""
    
    def test_get_all_notes_returns_3_seeded_notes(self, api_client):
        """GET /api/notes should return 3 seeded notes"""
        response = api_client.get(f"{BASE_URL}/api/notes")
        assert response.status_code == 200
        
        notes = response.json()
        assert isinstance(notes, list)
        assert len(notes) >= 3, f"Expected at least 3 seeded notes, got {len(notes)}"
        print(f"✓ Found {len(notes)} notes")
        
        # Check note titles
        titles = [n['title'] for n in notes]
        print(f"  Note titles: {titles}")
        
    def test_pinned_note_appears_first(self, api_client):
        """Pinned note (Doctor Appointment Notes) should appear first"""
        response = api_client.get(f"{BASE_URL}/api/notes")
        assert response.status_code == 200
        
        notes = response.json()
        assert len(notes) >= 3
        
        # First note should be pinned
        first_note = notes[0]
        assert first_note['is_pinned'] == True, "First note should be pinned"
        print(f"✓ First note is pinned: {first_note['title']}")


class TestNotesCRUD:
    """Notes CRUD operations with Create→GET verification"""
    
    def test_create_note_and_verify_persistence(self, api_client):
        """POST /api/notes creates a note, GET /api/notes/{id} retrieves it"""
        create_payload = {
            "title": "TEST_New Note",
            "content": "This is a test note content",
            "tags": [{"name": "test", "color": "#FF0000"}],
            "is_pinned": False
        }
        
        # Create note
        create_response = api_client.post(f"{BASE_URL}/api/notes", json=create_payload)
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
        print(f"✓ Created note with ID: {note_id}")
        
        # GET to verify persistence
        get_response = api_client.get(f"{BASE_URL}/api/notes/{note_id}")
        assert get_response.status_code == 200
        
        retrieved_note = get_response.json()
        assert retrieved_note["id"] == note_id
        assert retrieved_note["title"] == create_payload["title"]
        assert retrieved_note["content"] == create_payload["content"]
        print(f"✓ Retrieved note verified, data persisted correctly")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/notes/{note_id}")
        
    def test_update_note_and_verify_changes(self, api_client):
        """PUT /api/notes/{id} updates a note, GET verifies changes"""
        # Create a note first
        create_payload = {
            "title": "TEST_Original Title",
            "content": "Original content",
            "tags": [],
            "is_pinned": False
        }
        create_response = api_client.post(f"{BASE_URL}/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]
        
        # Update note
        update_payload = {
            "title": "TEST_Updated Title",
            "content": "Updated content",
            "tags": [{"name": "updated", "color": "#00FF00"}]
        }
        update_response = api_client.put(f"{BASE_URL}/api/notes/{note_id}", json=update_payload)
        assert update_response.status_code == 200
        
        updated_note = update_response.json()
        assert updated_note["title"] == update_payload["title"]
        assert updated_note["content"] == update_payload["content"]
        print(f"✓ Updated note {note_id}")
        
        # GET to verify changes persisted
        get_response = api_client.get(f"{BASE_URL}/api/notes/{note_id}")
        assert get_response.status_code == 200
        
        retrieved_note = get_response.json()
        assert retrieved_note["title"] == "TEST_Updated Title"
        assert retrieved_note["content"] == "Updated content"
        assert len(retrieved_note["tags"]) == 1
        assert retrieved_note["tags"][0]["name"] == "updated"
        print(f"✓ Update verified, changes persisted correctly")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/notes/{note_id}")
        
    def test_delete_note_and_verify_removal(self, api_client):
        """DELETE /api/notes/{id} deletes a note, GET returns 404"""
        # Create a note first
        create_payload = {
            "title": "TEST_To Be Deleted",
            "content": "This will be deleted",
            "tags": [],
            "is_pinned": False
        }
        create_response = api_client.post(f"{BASE_URL}/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]
        print(f"✓ Created note {note_id} for deletion test")
        
        # Delete note
        delete_response = api_client.delete(f"{BASE_URL}/api/notes/{note_id}")
        assert delete_response.status_code == 200
        assert "message" in delete_response.json()
        print(f"✓ Deleted note {note_id}")
        
        # GET to verify deletion (should return 404)
        get_response = api_client.get(f"{BASE_URL}/api/notes/{note_id}")
        assert get_response.status_code == 404
        print(f"✓ Delete verified, note no longer exists")


class TestNotesFeatures:
    """Test pin toggle and search features"""
    
    def test_toggle_pin_changes_pin_status(self, api_client):
        """POST /api/notes/{id}/toggle-pin toggles pin status"""
        # Create unpinned note
        create_payload = {
            "title": "TEST_Pin Toggle",
            "content": "Test pin toggle",
            "tags": [],
            "is_pinned": False
        }
        create_response = api_client.post(f"{BASE_URL}/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]
        assert create_response.json()["is_pinned"] == False
        print(f"✓ Created unpinned note {note_id}")
        
        # Toggle to pinned
        toggle_response = api_client.post(f"{BASE_URL}/api/notes/{note_id}/toggle-pin")
        assert toggle_response.status_code == 200
        toggled_note = toggle_response.json()
        assert toggled_note["is_pinned"] == True
        print(f"✓ Toggled to pinned")
        
        # Verify pin status persisted
        get_response = api_client.get(f"{BASE_URL}/api/notes/{note_id}")
        assert get_response.status_code == 200
        assert get_response.json()["is_pinned"] == True
        
        # Toggle back to unpinned
        toggle_response2 = api_client.post(f"{BASE_URL}/api/notes/{note_id}/toggle-pin")
        assert toggle_response2.status_code == 200
        assert toggle_response2.json()["is_pinned"] == False
        print(f"✓ Toggled back to unpinned")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/notes/{note_id}")
        
    def test_search_notes_by_content(self, api_client):
        """GET /api/notes?search=doctor filters notes correctly"""
        # Create a note with "doctor" in title
        create_payload = {
            "title": "TEST_Doctor Appointment",
            "content": "Remember to bring insurance",
            "tags": [],
            "is_pinned": False
        }
        create_response = api_client.post(f"{BASE_URL}/api/notes", json=create_payload)
        assert create_response.status_code == 200
        note_id = create_response.json()["id"]
        
        # Search for "doctor"
        search_response = api_client.get(f"{BASE_URL}/api/notes?search=doctor")
        assert search_response.status_code == 200
        
        results = search_response.json()
        assert isinstance(results, list)
        assert len(results) >= 1, "Should find at least 1 note with 'doctor'"
        
        # Verify our test note is in results
        found = any(n['id'] == note_id for n in results)
        assert found, "Created test note should be in search results"
        print(f"✓ Search for 'doctor' returned {len(results)} results")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/notes/{note_id}")


class TestEventsSeededData:
    """Test seeded events data"""
    
    def test_get_all_events_returns_seeded_events(self, api_client):
        """GET /api/events should return seeded events"""
        response = api_client.get(f"{BASE_URL}/api/events")
        assert response.status_code == 200
        
        events = response.json()
        assert isinstance(events, list)
        assert len(events) >= 2, f"Expected at least 2 seeded events, got {len(events)}"
        print(f"✓ Found {len(events)} events")
        
        # Check event titles
        titles = [e['title'] for e in events]
        print(f"  Event titles: {titles}")


class TestEventsCRUD:
    """Events CRUD operations with Create→GET verification"""
    
    def test_create_event_and_verify_persistence(self, api_client):
        """POST /api/events creates event, GET /api/events retrieves it"""
        create_payload = {
            "title": "TEST_New Event",
            "description": "Test event description",
            "start_time": "2026-03-20T10:00:00Z",
            "end_time": "2026-03-20T11:00:00Z",
            "linked_note_ids": []
        }
        
        # Create event
        create_response = api_client.post(f"{BASE_URL}/api/events", json=create_payload)
        assert create_response.status_code == 200
        
        created_event = create_response.json()
        assert created_event["title"] == create_payload["title"]
        assert created_event["description"] == create_payload["description"]
        assert "id" in created_event
        assert "created_at" in created_event
        event_id = created_event["id"]
        print(f"✓ Created event with ID: {event_id}")
        
        # GET to verify persistence
        get_response = api_client.get(f"{BASE_URL}/api/events/{event_id}")
        assert get_response.status_code == 200
        
        retrieved_event = get_response.json()
        assert retrieved_event["id"] == event_id
        assert retrieved_event["title"] == create_payload["title"]
        print(f"✓ Retrieved event verified, data persisted correctly")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/events/{event_id}")
        
    def test_filter_events_by_month(self, api_client):
        """GET /api/events?month=3&year=2026 filters by month"""
        # Create event in March 2026
        create_payload = {
            "title": "TEST_March Event",
            "description": "Event in March",
            "start_time": "2026-03-15T14:00:00Z",
            "end_time": "2026-03-15T15:00:00Z",
            "linked_note_ids": []
        }
        create_response = api_client.post(f"{BASE_URL}/api/events", json=create_payload)
        assert create_response.status_code == 200
        event_id = create_response.json()["id"]
        
        # Filter by March 2026
        filter_response = api_client.get(f"{BASE_URL}/api/events?month=3&year=2026")
        assert filter_response.status_code == 200
        
        filtered_events = filter_response.json()
        assert isinstance(filtered_events, list)
        assert len(filtered_events) >= 1, "Should find at least 1 event in March 2026"
        
        # Verify our test event is in results
        found = any(e['id'] == event_id for e in filtered_events)
        assert found, "Created test event should be in filtered results"
        print(f"✓ Filter by March 2026 returned {len(filtered_events)} events")
        
        # Verify all events are in March 2026
        for event in filtered_events:
            start_time = event['start_time']
            assert start_time.startswith('2026-03'), f"Event {event['id']} not in March 2026"
        print(f"✓ All filtered events are in March 2026")
        
        # Cleanup
        api_client.delete(f"{BASE_URL}/api/events/{event_id}")


class TestCleanup:
    """Cleanup test data"""
    
    def test_cleanup_test_notes(self, api_client):
        """Clean up any remaining TEST_ notes"""
        response = api_client.get(f"{BASE_URL}/api/notes")
        if response.status_code == 200:
            notes = response.json()
            test_notes = [n for n in notes if n['title'].startswith('TEST_')]
            for note in test_notes:
                api_client.delete(f"{BASE_URL}/api/notes/{note['id']}")
            if test_notes:
                print(f"✓ Cleaned up {len(test_notes)} test notes")
                
    def test_cleanup_test_events(self, api_client):
        """Clean up any remaining TEST_ events"""
        response = api_client.get(f"{BASE_URL}/api/events")
        if response.status_code == 200:
            events = response.json()
            test_events = [e for e in events if e['title'].startswith('TEST_')]
            for event in test_events:
                api_client.delete(f"{BASE_URL}/api/events/{event['id']}")
            if test_events:
                print(f"✓ Cleaned up {len(test_events)} test events")
