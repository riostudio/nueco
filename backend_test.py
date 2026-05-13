#!/usr/bin/env python3
"""
Comprehensive Backend API Testing for MemoPad
Tests all backend endpoints including the new JWT authentication system
"""

import requests
import json
import time
import uuid
from datetime import datetime, timezone

# Use the production URL from frontend/.env
BASE_URL = "https://web-production-a3258.up.railway.app/api"

class MemoPadTester:
    def __init__(self):
        self.base_url = BASE_URL
        self.session = requests.Session()
        self.access_token = None
        self.refresh_token = None
        self.test_user_email = f"testuser_{int(time.time())}@example.com"
        self.test_user_password = "testpassword123"
        self.test_user_name = "Test User"
        
    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {level}: {message}")
        
    def make_request(self, method, endpoint, **kwargs):
        """Make HTTP request with proper error handling"""
        url = f"{self.base_url}{endpoint}"
        try:
            response = self.session.request(method, url, **kwargs)
            self.log(f"{method} {endpoint} -> {response.status_code}")
            return response
        except requests.exceptions.RequestException as e:
            self.log(f"Request failed: {e}", "ERROR")
            return None
            
    def test_health_check(self):
        """Test health check endpoint"""
        self.log("=== Testing Health Check API ===")
        
        response = self.make_request("GET", "/health")
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "healthy" and "timestamp" in data:
                self.log("✅ Health check passed")
                return True
            else:
                self.log(f"❌ Health check failed - invalid response: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Health check failed - status {response.status_code}", "ERROR")
            return False
    
    def test_auth_signup(self):
        """Test user signup endpoint"""
        self.log("=== Testing Auth Signup API ===")
        
        # Test successful signup
        signup_data = {
            "name": self.test_user_name,
            "email": self.test_user_email,
            "password": self.test_user_password,
            "confirm_password": self.test_user_password
        }
        
        response = self.make_request("POST", "/auth/signup", json=signup_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if data.get("success") and "verify" in data.get("message", "").lower():
                self.log("✅ Signup successful - verification email message received")
            else:
                self.log(f"❌ Signup response invalid: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Signup failed - status {response.status_code}: {response.text}", "ERROR")
            return False
            
        # Test signup with mismatched passwords
        bad_signup_data = {
            "name": "Test User 2",
            "email": f"testuser2_{int(time.time())}@example.com",
            "password": "password123",
            "confirm_password": "differentpassword"
        }
        
        response = self.make_request("POST", "/auth/signup", json=bad_signup_data)
        if response and response.status_code == 400:
            self.log("✅ Signup correctly rejects mismatched passwords")
        else:
            self.log("❌ Signup should reject mismatched passwords", "ERROR")
            return False
            
        # Test signup with existing email
        response = self.make_request("POST", "/auth/signup", json=signup_data)
        if response and response.status_code == 400:
            self.log("✅ Signup correctly rejects duplicate email")
        else:
            self.log("❌ Signup should reject duplicate email", "ERROR")
            return False
            
        return True
    
    def test_auth_login(self):
        """Test user login endpoint"""
        self.log("=== Testing Auth Login API ===")
        
        # Test login with unverified email (should fail with 403)
        login_data = {
            "email": self.test_user_email,
            "password": self.test_user_password,
            "device_name": "Test Device",
            "platform": "web"
        }
        
        response = self.make_request("POST", "/auth/login", json=login_data)
        if not response:
            return False
            
        if response.status_code == 403:
            self.log("✅ Login correctly requires email verification")
            return True
        elif response.status_code == 200:
            # If login succeeds, store tokens for later tests
            data = response.json()
            if "access_token" in data and "refresh_token" in data:
                self.access_token = data["access_token"]
                self.refresh_token = data["refresh_token"]
                self.log("✅ Login successful - tokens received")
            else:
                self.log(f"❌ Login response missing tokens: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Login failed unexpectedly - status {response.status_code}: {response.text}", "ERROR")
            return False
            
        # Test login with wrong password
        wrong_login_data = {
            "email": self.test_user_email,
            "password": "wrongpassword",
            "device_name": "Test Device",
            "platform": "web"
        }
        
        response = self.make_request("POST", "/auth/login", json=wrong_login_data)
        if response and response.status_code == 401:
            self.log("✅ Login correctly rejects wrong password")
        else:
            self.log("❌ Login should reject wrong password", "ERROR")
            return False
            
        # Test login with non-existent email
        nonexistent_login_data = {
            "email": f"nonexistent_{int(time.time())}@example.com",
            "password": "password123",
            "device_name": "Test Device",
            "platform": "web"
        }
        
        response = self.make_request("POST", "/auth/login", json=nonexistent_login_data)
        if response and response.status_code == 401:
            self.log("✅ Login correctly rejects non-existent email")
        else:
            self.log("❌ Login should reject non-existent email", "ERROR")
            return False
            
        return True
    
    def test_auth_forgot_password(self):
        """Test forgot password endpoint"""
        self.log("=== Testing Auth Forgot Password API ===")
        
        forgot_data = {
            "email": self.test_user_email
        }
        
        response = self.make_request("POST", "/auth/forgot-password", json=forgot_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                self.log("✅ Forgot password request successful")
                return True
            else:
                self.log(f"❌ Forgot password response invalid: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Forgot password failed - status {response.status_code}: {response.text}", "ERROR")
            return False
    
    def test_auth_refresh(self):
        """Test token refresh endpoint"""
        self.log("=== Testing Auth Refresh Token API ===")
        
        if not self.refresh_token:
            self.log("⚠️ No refresh token available - skipping refresh test", "WARNING")
            return True
            
        refresh_data = {
            "refresh_token": self.refresh_token
        }
        
        response = self.make_request("POST", "/auth/refresh", json=refresh_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if "access_token" in data:
                self.access_token = data["access_token"]  # Update with new token
                self.log("✅ Token refresh successful")
                return True
            else:
                self.log(f"❌ Refresh response missing access_token: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Token refresh failed - status {response.status_code}: {response.text}", "ERROR")
            return False
    
    def test_auth_logout(self):
        """Test logout endpoint"""
        self.log("=== Testing Auth Logout API ===")
        
        if not self.refresh_token:
            self.log("⚠️ No refresh token available - skipping logout test", "WARNING")
            return True
            
        logout_data = {
            "refresh_token": self.refresh_token
        }
        
        response = self.make_request("POST", "/auth/logout", json=logout_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                self.log("✅ Logout successful")
                return True
            else:
                self.log(f"❌ Logout response invalid: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Logout failed - status {response.status_code}: {response.text}", "ERROR")
            return False
    
    def test_notes_crud(self):
        """Test Notes CRUD operations"""
        self.log("=== Testing Notes CRUD API ===")
        
        # Test GET notes
        response = self.make_request("GET", "/notes")
        if not response or response.status_code != 200:
            self.log("❌ Failed to get notes", "ERROR")
            return False
            
        existing_notes = response.json()
        self.log(f"✅ Retrieved {len(existing_notes)} existing notes")
        
        # Test POST note
        note_data = {
            "title": "Test Note",
            "content": "This is a test note content",
            "tags": [{"name": "test", "color": "#FF5722"}],
            "is_pinned": False
        }
        
        response = self.make_request("POST", "/notes", json=note_data)
        if not response or response.status_code != 200:
            self.log("❌ Failed to create note", "ERROR")
            return False
            
        created_note = response.json()
        note_id = created_note["id"]
        self.log(f"✅ Created note with ID: {note_id}")
        
        # Test GET specific note
        response = self.make_request("GET", f"/notes/{note_id}")
        if not response or response.status_code != 200:
            self.log("❌ Failed to get specific note", "ERROR")
            return False
            
        self.log("✅ Retrieved specific note")
        
        # Test PUT note
        update_data = {
            "title": "Updated Test Note",
            "content": "Updated content"
        }
        
        response = self.make_request("PUT", f"/notes/{note_id}", json=update_data)
        if not response or response.status_code != 200:
            self.log("❌ Failed to update note", "ERROR")
            return False
            
        self.log("✅ Updated note")
        
        # Test DELETE note
        response = self.make_request("DELETE", f"/notes/{note_id}")
        if not response or response.status_code != 200:
            self.log("❌ Failed to delete note", "ERROR")
            return False
            
        self.log("✅ Deleted note")
        
        return True
    
    def test_events_crud(self):
        """Test Events CRUD operations"""
        self.log("=== Testing Events CRUD API ===")
        
        # Test GET events
        response = self.make_request("GET", "/events")
        if not response or response.status_code != 200:
            self.log("❌ Failed to get events", "ERROR")
            return False
            
        existing_events = response.json()
        self.log(f"✅ Retrieved {len(existing_events)} existing events")
        
        # Test POST event
        event_data = {
            "title": "Test Event",
            "description": "This is a test event",
            "start_time": "2026-03-15T10:00:00",
            "end_time": "2026-03-15T11:00:00"
        }
        
        response = self.make_request("POST", "/events", json=event_data)
        if not response or response.status_code != 200:
            self.log("❌ Failed to create event", "ERROR")
            return False
            
        created_event = response.json()
        event_id = created_event["id"]
        self.log(f"✅ Created event with ID: {event_id}")
        
        # Test GET specific event
        response = self.make_request("GET", f"/events/{event_id}")
        if not response or response.status_code != 200:
            self.log("❌ Failed to get specific event", "ERROR")
            return False
            
        self.log("✅ Retrieved specific event")
        
        # Test DELETE event
        response = self.make_request("DELETE", f"/events/{event_id}")
        if not response or response.status_code != 200:
            self.log("❌ Failed to delete event", "ERROR")
            return False
            
        self.log("✅ Deleted event")
        
        return True
    
    def run_all_tests(self):
        """Run all tests and return summary"""
        self.log(f"Starting comprehensive backend testing for MemoPad")
        self.log(f"Backend URL: {self.base_url}")
        
        tests = [
            ("Health Check", self.test_health_check),
            ("Auth Signup", self.test_auth_signup),
            ("Auth Login", self.test_auth_login),
            ("Auth Forgot Password", self.test_auth_forgot_password),
            ("Auth Refresh Token", self.test_auth_refresh),
            ("Auth Logout", self.test_auth_logout),
            ("Notes CRUD", self.test_notes_crud),
            ("Events CRUD", self.test_events_crud),
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
        self.log(f"TESTING SUMMARY: {passed}/{total} tests passed")
        
        for test_name, result in results.items():
            status = "✅ PASS" if result else "❌ FAIL"
            self.log(f"  {test_name}: {status}")
        
        return results

if __name__ == "__main__":
    tester = MemoPadTester()
    results = tester.run_all_tests()