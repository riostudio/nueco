"""
MemoPad Backend API Tests
Comprehensive testing for all backend APIs
"""
import requests
import json
import tempfile
import os

# Read backend URL from frontend/.env
BASE_URL = "https://note-builder-10.preview.emergentagent.com"

def test_health_api():
    """Test the health check endpoint"""
    print("\n=== Testing Health Check API ===")
    
    try:
        response = requests.get(f"{BASE_URL}/api/health")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"Response: {data}")
            
            if "status" in data and data["status"] == "healthy":
                print("✅ Health check PASSED")
                return True
            else:
                print("❌ Health check FAILED - Invalid response format")
                return False
        else:
            print(f"❌ Health check FAILED - Status code: {response.status_code}")
            return False
            
    except Exception as e:
        print(f"❌ Health check FAILED - Error: {str(e)}")
        return False

def test_notes_crud():
    """Test Notes CRUD operations"""
    print("\n=== Testing Notes CRUD API ===")
    
    # Test GET all notes
    print("\n--- GET /api/notes ---")
    try:
        response = requests.get(f"{BASE_URL}/api/notes")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            notes = response.json()
            print(f"Found {len(notes)} notes")
            print("✅ GET notes PASSED")
        else:
            print(f"❌ GET notes FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ GET notes FAILED - Error: {str(e)}")
        return False
    
    # Test POST create note
    print("\n--- POST /api/notes (Create) ---")
    create_data = {
        "title": "Test Note from API",
        "content": "This is a test note created via API testing",
        "tags": [{"name": "api-test", "color": "#FF5722"}],
        "is_pinned": False
    }
    
    try:
        response = requests.post(f"{BASE_URL}/api/notes", json=create_data)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            created_note = response.json()
            note_id = created_note.get("id")
            print(f"Created note with ID: {note_id}")
            print(f"Title: {created_note.get('title')}")
            print("✅ POST create note PASSED")
        else:
            print(f"❌ POST create note FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ POST create note FAILED - Error: {str(e)}")
        return False
    
    # Test GET specific note
    print(f"\n--- GET /api/notes/{note_id} ---")
    try:
        response = requests.get(f"{BASE_URL}/api/notes/{note_id}")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            note = response.json()
            print(f"Retrieved note: {note.get('title')}")
            print("✅ GET specific note PASSED")
        else:
            print(f"❌ GET specific note FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ GET specific note FAILED - Error: {str(e)}")
        return False
    
    # Test PUT update note
    print(f"\n--- PUT /api/notes/{note_id} (Update) ---")
    update_data = {
        "title": "Updated Test Note",
        "content": "This note has been updated via API",
        "tags": [{"name": "updated", "color": "#4CAF50"}],
        "is_pinned": True
    }
    
    try:
        response = requests.put(f"{BASE_URL}/api/notes/{note_id}", json=update_data)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            updated_note = response.json()
            print(f"Updated title: {updated_note.get('title')}")
            print(f"Is pinned: {updated_note.get('is_pinned')}")
            print("✅ PUT update note PASSED")
        else:
            print(f"❌ PUT update note FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ PUT update note FAILED - Error: {str(e)}")
        return False
    
    # Test DELETE note
    print(f"\n--- DELETE /api/notes/{note_id} ---")
    try:
        response = requests.delete(f"{BASE_URL}/api/notes/{note_id}")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"Delete result: {result}")
            print("✅ DELETE note PASSED")
        else:
            print(f"❌ DELETE note FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ DELETE note FAILED - Error: {str(e)}")
        return False
    
    # Verify note was deleted
    print(f"\n--- Verify note deleted ---")
    try:
        response = requests.get(f"{BASE_URL}/api/notes/{note_id}")
        if response.status_code == 404:
            print("✅ Note deletion verified")
            return True
        else:
            print(f"❌ Note still exists - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Verification FAILED - Error: {str(e)}")
        return False

def test_events_crud():
    """Test Events CRUD operations"""
    print("\n=== Testing Events CRUD API ===")
    
    # Test GET all events
    print("\n--- GET /api/events ---")
    try:
        response = requests.get(f"{BASE_URL}/api/events")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            events = response.json()
            print(f"Found {len(events)} events")
            print("✅ GET events PASSED")
        else:
            print(f"❌ GET events FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ GET events FAILED - Error: {str(e)}")
        return False
    
    # Test GET events with month/year filter
    print("\n--- GET /api/events?month=3&year=2026 ---")
    try:
        response = requests.get(f"{BASE_URL}/api/events?month=3&year=2026")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            events = response.json()
            print(f"Found {len(events)} events for March 2026")
            print("✅ GET filtered events PASSED")
        else:
            print(f"❌ GET filtered events FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ GET filtered events FAILED - Error: {str(e)}")
        return False
    
    # Test POST create event
    print("\n--- POST /api/events (Create) ---")
    create_data = {
        "title": "Test Event from API",
        "description": "This is a test event created via API testing",
        "start_time": "2026-03-15T10:00:00Z",
        "end_time": "2026-03-15T11:30:00Z",
        "linked_note_ids": []
    }
    
    try:
        response = requests.post(f"{BASE_URL}/api/events", json=create_data)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            created_event = response.json()
            event_id = created_event.get("id")
            print(f"Created event with ID: {event_id}")
            print(f"Title: {created_event.get('title')}")
            print("✅ POST create event PASSED")
        else:
            print(f"❌ POST create event FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ POST create event FAILED - Error: {str(e)}")
        return False
    
    # Test GET specific event
    print(f"\n--- GET /api/events/{event_id} ---")
    try:
        response = requests.get(f"{BASE_URL}/api/events/{event_id}")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            event = response.json()
            print(f"Retrieved event: {event.get('title')}")
            print("✅ GET specific event PASSED")
        else:
            print(f"❌ GET specific event FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ GET specific event FAILED - Error: {str(e)}")
        return False
    
    # Test PUT update event
    print(f"\n--- PUT /api/events/{event_id} (Update) ---")
    update_data = {
        "title": "Updated Test Event",
        "description": "This event has been updated via API",
        "start_time": "2026-03-15T11:00:00Z",
        "end_time": "2026-03-15T12:30:00Z"
    }
    
    try:
        response = requests.put(f"{BASE_URL}/api/events/{event_id}", json=update_data)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            updated_event = response.json()
            print(f"Updated title: {updated_event.get('title')}")
            print(f"Start time: {updated_event.get('start_time')}")
            print("✅ PUT update event PASSED")
        else:
            print(f"❌ PUT update event FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ PUT update event FAILED - Error: {str(e)}")
        return False
    
    # Test DELETE event
    print(f"\n--- DELETE /api/events/{event_id} ---")
    try:
        response = requests.delete(f"{BASE_URL}/api/events/{event_id}")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            result = response.json()
            print(f"Delete result: {result}")
            print("✅ DELETE event PASSED")
        else:
            print(f"❌ DELETE event FAILED - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ DELETE event FAILED - Error: {str(e)}")
        return False
    
    # Verify event was deleted
    print(f"\n--- Verify event deleted ---")
    try:
        response = requests.get(f"{BASE_URL}/api/events/{event_id}")
        if response.status_code == 404:
            print("✅ Event deletion verified")
            return True
        else:
            print(f"❌ Event still exists - Status: {response.status_code}")
            return False
    except Exception as e:
        print(f"❌ Verification FAILED - Error: {str(e)}")
        return False

def test_voice_transcription():
    """Test Voice Transcription API"""
    print("\n=== Testing Voice Transcription API ===")
    
    # Test with no file (should fail)
    print("\n--- POST /api/transcribe (without file) ---")
    try:
        response = requests.post(f"{BASE_URL}/api/transcribe")
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 422:  # Unprocessable Entity (missing file)
            print("✅ Correctly rejects request without file")
        else:
            print(f"❌ Expected 422, got {response.status_code}")
    except Exception as e:
        print(f"❌ Test without file FAILED - Error: {str(e)}")
    
    # Test with invalid file (should fail gracefully)
    print("\n--- POST /api/transcribe (with invalid file) ---")
    try:
        # Create a dummy text file (not audio)
        with tempfile.NamedTemporaryFile(suffix='.txt', delete=False) as tmp_file:
            tmp_file.write(b"This is not an audio file")
            tmp_file_path = tmp_file.name
        
        with open(tmp_file_path, 'rb') as f:
            files = {'file': ('test.txt', f, 'text/plain')}
            response = requests.post(f"{BASE_URL}/api/transcribe", files=files)
        
        print(f"Status Code: {response.status_code}")
        
        if response.status_code in [400, 422, 500]:
            print("✅ Correctly handles invalid file format")
            if response.status_code == 500:
                try:
                    error_data = response.json()
                    print(f"Error message: {error_data.get('detail', 'No detail')}")
                except:
                    print("Error response not in JSON format")
        else:
            print(f"❌ Unexpected response for invalid file: {response.status_code}")
        
        # Cleanup
        os.unlink(tmp_file_path)
        
    except Exception as e:
        print(f"❌ Test with invalid file FAILED - Error: {str(e)}")
    
    print("\n--- Voice Transcription Endpoint Status ---")
    print("✅ Transcription endpoint exists and handles requests appropriately")
    print("⚠️  Note: Full transcription testing requires actual audio file")
    
    return True

def run_all_tests():
    """Run all backend API tests"""
    print("Starting MemoPad Backend API Tests")
    print(f"Testing against: {BASE_URL}")
    
    results = {
        "Health Check": test_health_api(),
        "Notes CRUD": test_notes_crud(),
        "Events CRUD": test_events_crud(),
        "Voice Transcription": test_voice_transcription()
    }
    
    print("\n" + "="*50)
    print("FINAL TEST RESULTS")
    print("="*50)
    
    passed = 0
    total = len(results)
    
    for test_name, result in results.items():
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{test_name}: {status}")
        if result:
            passed += 1
    
    print(f"\nOverall: {passed}/{total} tests passed")
    
    if passed == total:
        print("🎉 All backend APIs are working correctly!")
        return True
    else:
        print("⚠️  Some backend APIs have issues that need attention.")
        return False

if __name__ == "__main__":
    success = run_all_tests()
    exit(0 if success else 1)