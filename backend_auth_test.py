#!/usr/bin/env python3
"""
Comprehensive test for Notes and Events API endpoints with JWT authentication
Tests authentication-protected endpoints as specified in the review request
"""

import requests
import json
import sys
from datetime import datetime, timezone

# Backend URL from environment configuration
BACKEND_URL = "https://note-builder-10.preview.emergentagent.com/api"

# Test credentials as specified in review request
TEST_EMAIL = "riobudiman@gmail.com"
TEST_PASSWORD = "Password123"
TEST_DEVICE_NAME = "Test"
TEST_PLATFORM = "web"

class AuthTestRunner:
    def __init__(self):
        self.access_token = None
        self.refresh_token = None
        self.test_note_id = None
        self.test_event_id = None
        self.results = []
        
    def log_result(self, test_name, success, details):
        """Log test result"""
        status = "✅ PASS" if success else "❌ FAIL"
        self.results.append({
            "test": test_name,
            "success": success,
            "details": details
        })
        print(f"{status}: {test_name} - {details}")
        
    def test_login_authentication(self):
        """Test 1: Login to get access token"""
        print("\n=== Testing JWT Authentication Login ===")
        
        login_data = {
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "device_name": TEST_DEVICE_NAME,
            "platform": TEST_PLATFORM
        }
        
        try:
            response = requests.post(f"{BACKEND_URL}/auth/login", json=login_data)
            
            if response.status_code == 200:
                data = response.json()
                self.access_token = data.get("access_token")
                self.refresh_token = data.get("refresh_token")
                
                if self.access_token and self.refresh_token:
                    self.log_result("Login Authentication", True, 
                                  f"Successfully logged in and received JWT tokens")
                    return True
                else:
                    self.log_result("Login Authentication", False, 
                                  "Login successful but missing tokens in response")
                    return False
            elif response.status_code == 401:
                self.log_result("Login Authentication", False, 
                              f"Invalid credentials: {response.json().get('detail', 'Unknown error')}")
                return False
            elif response.status_code == 403:
                self.log_result("Login Authentication", False, 
                              f"Email verification required: {response.json().get('detail', 'Unknown error')}")
                return False
            else:
                self.log_result("Login Authentication", False, 
                              f"Login failed with status {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("Login Authentication", False, f"Request failed: {str(e)}")
            return False
    
    def get_auth_headers(self):
        """Get authorization headers with Bearer token"""
        if not self.access_token:
            return {}
        return {"Authorization": f"Bearer {self.access_token}"}
    
    def test_notes_with_auth(self):
        """Test 2: Notes endpoints WITH authentication (should return 200)"""
        print("\n=== Testing Notes Endpoints WITH Authentication ===")
        
        if not self.access_token:
            self.log_result("Notes with Auth", False, "No access token available")
            return False
            
        headers = self.get_auth_headers()
        
        # Test GET /api/notes
        try:
            response = requests.get(f"{BACKEND_URL}/notes", headers=headers)
            if response.status_code == 200:
                notes = response.json()
                self.log_result("GET /api/notes (authenticated)", True, 
                              f"Retrieved {len(notes)} notes successfully")
            else:
                self.log_result("GET /api/notes (authenticated)", False, 
                              f"Failed with status {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_result("GET /api/notes (authenticated)", False, f"Request failed: {str(e)}")
            return False
        
        # Test POST /api/notes (create note)
        note_data = {
            "title": "Test Note with Auth",
            "content": "This is a test note created with authentication",
            "tags": [{"name": "test", "color": "#FF5722"}],
            "is_pinned": False
        }
        
        try:
            response = requests.post(f"{BACKEND_URL}/notes", json=note_data, headers=headers)
            if response.status_code == 200:
                created_note = response.json()
                self.test_note_id = created_note.get("id")
                self.log_result("POST /api/notes (authenticated)", True, 
                              f"Created note with ID: {self.test_note_id}")
            else:
                self.log_result("POST /api/notes (authenticated)", False, 
                              f"Failed with status {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_result("POST /api/notes (authenticated)", False, f"Request failed: {str(e)}")
            return False
        
        # Test GET /api/notes/{id} (get specific note)
        if self.test_note_id:
            try:
                response = requests.get(f"{BACKEND_URL}/notes/{self.test_note_id}", headers=headers)
                if response.status_code == 200:
                    note = response.json()
                    self.log_result("GET /api/notes/{id} (authenticated)", True, 
                                  f"Retrieved note: {note.get('title', 'No title')}")
                else:
                    self.log_result("GET /api/notes/{id} (authenticated)", False, 
                                  f"Failed with status {response.status_code}: {response.text}")
                    return False
            except Exception as e:
                self.log_result("GET /api/notes/{id} (authenticated)", False, f"Request failed: {str(e)}")
                return False
        
        # Test PUT /api/notes/{id} (update note)
        if self.test_note_id:
            update_data = {"title": "Updated Test Note", "is_pinned": True}
            try:
                response = requests.put(f"{BACKEND_URL}/notes/{self.test_note_id}", 
                                      json=update_data, headers=headers)
                if response.status_code == 200:
                    updated_note = response.json()
                    self.log_result("PUT /api/notes/{id} (authenticated)", True, 
                                  f"Updated note title to: {updated_note.get('title', 'No title')}")
                else:
                    self.log_result("PUT /api/notes/{id} (authenticated)", False, 
                                  f"Failed with status {response.status_code}: {response.text}")
                    return False
            except Exception as e:
                self.log_result("PUT /api/notes/{id} (authenticated)", False, f"Request failed: {str(e)}")
                return False
        
        return True
    
    def test_notes_without_auth(self):
        """Test 3: Notes endpoints WITHOUT authentication (should return 401)"""
        print("\n=== Testing Notes Endpoints WITHOUT Authentication ===")
        
        # Test GET /api/notes without token
        try:
            response = requests.get(f"{BACKEND_URL}/notes")
            if response.status_code == 401:
                self.log_result("GET /api/notes (unauthenticated)", True, 
                              "Correctly returned 401 Unauthorized")
            else:
                self.log_result("GET /api/notes (unauthenticated)", False, 
                              f"Expected 401 but got {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_result("GET /api/notes (unauthenticated)", False, f"Request failed: {str(e)}")
            return False
        
        return True
    
    def test_events_with_auth(self):
        """Test 4: Events endpoints WITH authentication"""
        print("\n=== Testing Events Endpoints WITH Authentication ===")
        
        if not self.access_token:
            self.log_result("Events with Auth", False, "No access token available")
            return False
            
        headers = self.get_auth_headers()
        
        # Test GET /api/events
        try:
            response = requests.get(f"{BACKEND_URL}/events", headers=headers)
            if response.status_code == 200:
                events = response.json()
                self.log_result("GET /api/events (authenticated)", True, 
                              f"Retrieved {len(events)} events successfully")
            else:
                self.log_result("GET /api/events (authenticated)", False, 
                              f"Failed with status {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_result("GET /api/events (authenticated)", False, f"Request failed: {str(e)}")
            return False
        
        # Test POST /api/events (create event)
        event_data = {
            "title": "Test Event with Auth",
            "description": "This is a test event created with authentication",
            "start_time": "2026-04-21T10:00:00Z",
            "end_time": "2026-04-21T11:00:00Z",
            "linked_note_ids": [],
            "reminder_minutes": 15
        }
        
        try:
            response = requests.post(f"{BACKEND_URL}/events", json=event_data, headers=headers)
            if response.status_code == 200:
                created_event = response.json()
                self.test_event_id = created_event.get("id")
                self.log_result("POST /api/events (authenticated)", True, 
                              f"Created event with ID: {self.test_event_id}")
            else:
                self.log_result("POST /api/events (authenticated)", False, 
                              f"Failed with status {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_result("POST /api/events (authenticated)", False, f"Request failed: {str(e)}")
            return False
        
        # Test GET /api/events/{id} (get specific event)
        if self.test_event_id:
            try:
                response = requests.get(f"{BACKEND_URL}/events/{self.test_event_id}", headers=headers)
                if response.status_code == 200:
                    event = response.json()
                    self.log_result("GET /api/events/{id} (authenticated)", True, 
                                  f"Retrieved event: {event.get('title', 'No title')}")
                else:
                    self.log_result("GET /api/events/{id} (authenticated)", False, 
                                  f"Failed with status {response.status_code}: {response.text}")
                    return False
            except Exception as e:
                self.log_result("GET /api/events/{id} (authenticated)", False, f"Request failed: {str(e)}")
                return False
        
        return True
    
    def test_events_without_auth(self):
        """Test 5: Events endpoints WITHOUT authentication (should return 401)"""
        print("\n=== Testing Events Endpoints WITHOUT Authentication ===")
        
        # Test GET /api/events without token
        try:
            response = requests.get(f"{BACKEND_URL}/events")
            if response.status_code == 401:
                self.log_result("GET /api/events (unauthenticated)", True, 
                              "Correctly returned 401 Unauthorized")
            else:
                self.log_result("GET /api/events (unauthenticated)", False, 
                              f"Expected 401 but got {response.status_code}: {response.text}")
                return False
        except Exception as e:
            self.log_result("GET /api/events (unauthenticated)", False, f"Request failed: {str(e)}")
            return False
        
        return True
    
    def cleanup_test_data(self):
        """Test 6: Cleanup - Delete created test data"""
        print("\n=== Cleaning Up Test Data ===")
        
        if not self.access_token:
            self.log_result("Cleanup", False, "No access token available")
            return False
            
        headers = self.get_auth_headers()
        
        # Delete test note
        if self.test_note_id:
            try:
                response = requests.delete(f"{BACKEND_URL}/notes/{self.test_note_id}", headers=headers)
                if response.status_code == 200:
                    self.log_result("DELETE /api/notes/{id} (authenticated)", True, 
                                  f"Successfully deleted test note")
                else:
                    self.log_result("DELETE /api/notes/{id} (authenticated)", False, 
                                  f"Failed with status {response.status_code}: {response.text}")
            except Exception as e:
                self.log_result("DELETE /api/notes/{id} (authenticated)", False, f"Request failed: {str(e)}")
        
        # Delete test event
        if self.test_event_id:
            try:
                response = requests.delete(f"{BACKEND_URL}/events/{self.test_event_id}", headers=headers)
                if response.status_code == 200:
                    self.log_result("DELETE /api/events/{id} (authenticated)", True, 
                                  f"Successfully deleted test event")
                else:
                    self.log_result("DELETE /api/events/{id} (authenticated)", False, 
                                  f"Failed with status {response.status_code}: {response.text}")
            except Exception as e:
                self.log_result("DELETE /api/events/{id} (authenticated)", False, f"Request failed: {str(e)}")
        
        return True
    
    def run_all_tests(self):
        """Run all authentication tests"""
        print(f"🚀 Starting Notes and Events API Authentication Tests")
        print(f"Backend URL: {BACKEND_URL}")
        print(f"Test Email: {TEST_EMAIL}")
        print("=" * 60)
        
        # Test sequence as specified in review request
        tests = [
            ("Login Authentication", self.test_login_authentication),
            ("Notes with Authentication", self.test_notes_with_auth),
            ("Notes without Authentication", self.test_notes_without_auth),
            ("Events with Authentication", self.test_events_with_auth),
            ("Events without Authentication", self.test_events_without_auth),
            ("Cleanup Test Data", self.cleanup_test_data)
        ]
        
        passed = 0
        total = len(tests)
        
        for test_name, test_func in tests:
            try:
                if test_func():
                    passed += 1
            except Exception as e:
                self.log_result(test_name, False, f"Test execution failed: {str(e)}")
        
        # Print summary
        print("\n" + "=" * 60)
        print(f"🎯 TEST SUMMARY: {passed}/{total} tests passed")
        print("=" * 60)
        
        # Print detailed results
        for result in self.results:
            status = "✅" if result["success"] else "❌"
            print(f"{status} {result['test']}: {result['details']}")
        
        if passed == total:
            print("\n🎉 ALL AUTHENTICATION TESTS PASSED!")
            return True
        else:
            print(f"\n⚠️  {total - passed} tests failed. Check details above.")
            return False

def main():
    """Main test execution"""
    runner = AuthTestRunner()
    success = runner.run_all_tests()
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()