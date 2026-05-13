#!/usr/bin/env python3
"""
Focused DELETE Note Functionality Test for MemoPad
Tests the specific DELETE note functionality as requested
"""

import requests
import json
import time
from datetime import datetime

# Use the production URL from frontend/.env
BASE_URL = "https://web-production-a3258.up.railway.app/api"

class DeleteNoteTester:
    def __init__(self):
        self.base_url = BASE_URL
        self.session = requests.Session()
        
    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {level}: {message}")
        
    def make_request(self, method, endpoint, **kwargs):
        """Make HTTP request with proper error handling"""
        url = f"{self.base_url}{endpoint}"
        try:
            response = self.session.request(method, url, **kwargs)
            self.log(f"{method} {endpoint} -> {response.status_code}")
            if response.status_code >= 400:
                self.log(f"Response body: {response.text}")
            return response
        except requests.exceptions.RequestException as e:
            self.log(f"Request failed: {e}", "ERROR")
            return None
    
    def test_delete_note_functionality(self):
        """Test DELETE note functionality as requested"""
        self.log("=== Testing DELETE Note Functionality ===")
        
        # Step 1: GET /api/notes to see existing notes and get a note ID
        self.log("Step 1: Getting existing notes...")
        response = self.make_request("GET", "/notes")
        if not response or response.status_code != 200:
            self.log("❌ Failed to get existing notes", "ERROR")
            return False
            
        existing_notes = response.json()
        self.log(f"✅ Retrieved {len(existing_notes)} existing notes")
        
        if not existing_notes:
            # Create a test note first if no notes exist
            self.log("No existing notes found. Creating a test note first...")
            note_data = {
                "title": "Test Note for Deletion",
                "content": "This note will be deleted as part of the test",
                "tags": [{"name": "test", "color": "#FF5722"}],
                "is_pinned": False
            }
            
            response = self.make_request("POST", "/notes", json=note_data)
            if not response or response.status_code != 200:
                self.log("❌ Failed to create test note", "ERROR")
                return False
                
            created_note = response.json()
            note_id = created_note["id"]
            self.log(f"✅ Created test note with ID: {note_id}")
            
            # Get notes again to confirm creation
            response = self.make_request("GET", "/notes")
            if response and response.status_code == 200:
                existing_notes = response.json()
                self.log(f"✅ Now have {len(existing_notes)} notes after creation")
        else:
            # Use the first existing note
            note_id = existing_notes[0]["id"]
            self.log(f"✅ Using existing note ID: {note_id}")
        
        # Step 2: Test DELETE /api/notes/{note_id} with a valid note ID
        self.log(f"Step 2: Deleting note with ID: {note_id}")
        response = self.make_request("DELETE", f"/notes/{note_id}")
        if not response:
            self.log("❌ DELETE request failed", "ERROR")
            return False
            
        if response.status_code == 200:
            data = response.json()
            if data.get("message") == "Note deleted":
                self.log("✅ DELETE request successful - note deleted")
            else:
                self.log(f"❌ DELETE response unexpected: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ DELETE failed - status {response.status_code}: {response.text}", "ERROR")
            return False
        
        # Step 3: Verify the note is deleted by doing GET /api/notes again
        self.log("Step 3: Verifying note deletion...")
        response = self.make_request("GET", "/notes")
        if not response or response.status_code != 200:
            self.log("❌ Failed to verify deletion - couldn't get notes", "ERROR")
            return False
            
        notes_after_deletion = response.json()
        self.log(f"✅ Retrieved {len(notes_after_deletion)} notes after deletion")
        
        # Check that the deleted note is no longer in the list
        deleted_note_found = any(note["id"] == note_id for note in notes_after_deletion)
        if deleted_note_found:
            self.log("❌ Note still exists after deletion", "ERROR")
            return False
        else:
            self.log("✅ Confirmed note was successfully deleted from the list")
        
        # Additional verification: Try to GET the specific deleted note (should return 404)
        self.log("Step 4: Verifying deleted note returns 404...")
        response = self.make_request("GET", f"/notes/{note_id}")
        if response is None:
            self.log("❌ Request failed - network issue", "ERROR")
            return False
        elif response.status_code == 404:
            self.log("✅ Deleted note correctly returns 404")
            return True
        else:
            self.log(f"❌ Deleted note should return 404, got {response.status_code}", "ERROR")
            return False
    
    def test_delete_invalid_note_id(self):
        """Test DELETE with invalid note ID (should return 404)"""
        self.log("=== Testing DELETE with Invalid Note ID ===")
        
        invalid_id = "invalid-note-id-12345"
        self.log(f"Testing DELETE with invalid ID: {invalid_id}")
        
        response = self.make_request("DELETE", f"/notes/{invalid_id}")
        if response is None:
            self.log("❌ DELETE request failed - network issue", "ERROR")
            return False
            
        if response.status_code == 404:
            data = response.json()
            if data.get("detail") == "Note not found":
                self.log("✅ DELETE with invalid ID correctly returns 404")
                return True
            else:
                self.log(f"❌ DELETE 404 response unexpected: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ DELETE with invalid ID should return 404, got {response.status_code}: {response.text}", "ERROR")
            return False
    
    def run_delete_tests(self):
        """Run all DELETE-related tests"""
        self.log(f"Starting DELETE note functionality testing")
        self.log(f"Backend URL: {self.base_url}")
        
        tests = [
            ("DELETE Valid Note", self.test_delete_note_functionality),
            ("DELETE Invalid Note ID", self.test_delete_invalid_note_id),
        ]
        
        results = {}
        passed = 0
        total = len(tests)
        
        for test_name, test_func in tests:
            try:
                result = test_func()
                results[test_name] = result
                if result:
                    passed += 1
                self.log(f"Test '{test_name}': {'PASSED' if result else 'FAILED'}")
            except Exception as e:
                self.log(f"Test '{test_name}' crashed: {e}", "ERROR")
                results[test_name] = False
        
        self.log("=" * 50)
        self.log(f"DELETE TESTING SUMMARY: {passed}/{total} tests passed")
        
        for test_name, result in results.items():
            status = "✅ PASS" if result else "❌ FAIL"
            self.log(f"  {test_name}: {status}")
        
        return results

if __name__ == "__main__":
    tester = DeleteNoteTester()
    results = tester.run_delete_tests()