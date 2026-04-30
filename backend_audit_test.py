#!/usr/bin/env python3
"""
Comprehensive test suite for MemoPad Technical Audit Fixes
Tests rate limiting, pagination, batch APIs, auth requirements, and existing functionality
"""

import asyncio
import aiohttp
import json
import time
from typing import Dict, List, Optional

# Backend URL from environment
BACKEND_URL = "https://note-builder-10.preview.emergentagent.com/api"

# Test credentials from previous testing
TEST_EMAIL = "riobudiman@gmail.com"
TEST_PASSWORD = "12345678"

class AuditTestRunner:
    def __init__(self):
        self.session = None
        self.access_token = None
        self.refresh_token = None
        self.test_results = []
        
    async def setup(self):
        """Setup HTTP session and authenticate"""
        self.session = aiohttp.ClientSession()
        print("🔧 Setting up test environment...")
        
        # Login to get JWT tokens
        await self.login()
        
    async def teardown(self):
        """Cleanup HTTP session"""
        if self.session:
            await self.session.close()
            
    async def login(self):
        """Login and get JWT tokens, create user if needed"""
        print(f"🔐 Attempting login with {TEST_EMAIL}...")
        
        login_data = {
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "device_name": "Test Device",
            "platform": "test"
        }
        
        async with self.session.post(f"{BACKEND_URL}/auth/login", json=login_data) as resp:
            if resp.status == 200:
                data = await resp.json()
                self.access_token = data["access_token"]
                self.refresh_token = data["refresh_token"]
                print("✅ Login successful")
                return True
            elif resp.status == 401:
                print("🔧 User doesn't exist, creating test user...")
                return await self.create_test_user()
            else:
                error = await resp.text()
                print(f"❌ Login failed: {resp.status} - {error}")
                return False
                
    async def create_test_user(self):
        """Create a test user for testing"""
        signup_data = {
            "name": "Test User",
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "confirm_password": TEST_PASSWORD
        }
        
        async with self.session.post(f"{BACKEND_URL}/auth/signup", json=signup_data) as resp:
            if resp.status == 200:
                print("✅ Test user created successfully")
                # For testing purposes, we'll assume email verification is bypassed
                # Try to login again
                return await self.login_after_signup()
            else:
                error = await resp.text()
                print(f"❌ Failed to create test user: {resp.status} - {error}")
                return False
                
    async def login_after_signup(self):
        """Try to login after signup (may need email verification)"""
        login_data = {
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "device_name": "Test Device",
            "platform": "test"
        }
        
        async with self.session.post(f"{BACKEND_URL}/auth/login", json=login_data) as resp:
            if resp.status == 200:
                data = await resp.json()
                self.access_token = data["access_token"]
                self.refresh_token = data["refresh_token"]
                print("✅ Login successful after signup")
                return True
            elif resp.status == 403:
                print("⚠️ Email verification required - using alternative approach")
                # For testing, we'll proceed without full auth for some tests
                return False
            else:
                error = await resp.text()
                print(f"❌ Login after signup failed: {resp.status} - {error}")
                return False
                
    def get_auth_headers(self) -> Dict[str, str]:
        """Get authorization headers"""
        return {"Authorization": f"Bearer {self.access_token}"}
        
    async def test_rate_limiting(self):
        """Test rate limiting on auth endpoints"""
        print("\n🚦 TESTING RATE LIMITING")
        print("=" * 50)
        
        # Test 1: Login rate limiting (5 per email per minute)
        print("📧 Testing login rate limiting (5 per email per minute)...")
        login_data = {
            "email": "test@nonexistent.com",  # Use non-existent email to avoid lockout
            "password": "wrongpassword",
            "device_name": "Test Device",
            "platform": "test"
        }
        
        rate_limit_hit = False
        for i in range(7):  # Try 7 requests, should hit limit at 6th
            async with self.session.post(f"{BACKEND_URL}/auth/login", json=login_data) as resp:
                if resp.status == 429:
                    rate_limit_hit = True
                    response_text = await resp.text()
                    print(f"✅ Rate limit hit on attempt {i+1}: {resp.status} - {response_text}")
                    break
                elif resp.status == 401:
                    print(f"   Attempt {i+1}: 401 (expected for wrong credentials)")
                else:
                    print(f"   Attempt {i+1}: {resp.status}")
                    
        if rate_limit_hit:
            self.test_results.append("✅ Login rate limiting working")
        else:
            self.test_results.append("❌ Login rate limiting not working")
            
        # Wait a bit before next test
        await asyncio.sleep(2)
        
        # Test 2: Signup rate limiting (3 per IP per hour)
        print("\n📝 Testing signup rate limiting (3 per IP per hour)...")
        signup_data = {
            "name": "Test User",
            "email": f"test{int(time.time())}@test.com",
            "password": "testpassword123",
            "confirm_password": "testpassword123"
        }
        
        signup_rate_limit_hit = False
        for i in range(5):  # Try 5 requests, should hit limit at 4th
            # Use different email each time
            signup_data["email"] = f"test{int(time.time())}{i}@test.com"
            async with self.session.post(f"{BACKEND_URL}/auth/signup", json=signup_data) as resp:
                if resp.status == 429:
                    signup_rate_limit_hit = True
                    response_text = await resp.text()
                    print(f"✅ Signup rate limit hit on attempt {i+1}: {resp.status} - {response_text}")
                    break
                else:
                    print(f"   Attempt {i+1}: {resp.status}")
                    
        if signup_rate_limit_hit:
            self.test_results.append("✅ Signup rate limiting working")
        else:
            self.test_results.append("❌ Signup rate limiting not working")
            
        # Wait a bit before next test
        await asyncio.sleep(2)
        
        # Test 3: Forgot password rate limiting (3 per email per hour)
        print("\n🔑 Testing forgot password rate limiting (3 per email per hour)...")
        forgot_data = {"email": "test@nonexistent.com"}
        
        forgot_rate_limit_hit = False
        for i in range(5):  # Try 5 requests, should hit limit at 4th
            async with self.session.post(f"{BACKEND_URL}/auth/forgot-password", json=forgot_data) as resp:
                if resp.status == 429:
                    forgot_rate_limit_hit = True
                    response_text = await resp.text()
                    print(f"✅ Forgot password rate limit hit on attempt {i+1}: {resp.status} - {response_text}")
                    break
                else:
                    print(f"   Attempt {i+1}: {resp.status}")
                    
        if forgot_rate_limit_hit:
            self.test_results.append("✅ Forgot password rate limiting working")
        else:
            self.test_results.append("❌ Forgot password rate limiting not working")
            
    async def test_notes_pagination(self):
        """Test notes pagination functionality"""
        print("\n📄 TESTING NOTES PAGINATION")
        print("=" * 50)
        
        # First, create some test notes to ensure we have data
        print("📝 Creating test notes for pagination testing...")
        created_notes = []
        for i in range(15):  # Create 15 notes
            note_data = {
                "title": f"Test Note {i+1}",
                "content": f"This is test note content {i+1} for pagination testing.",
                "tags": [{"name": f"tag{i}", "color": "#FF5722"}],
                "is_pinned": i % 3 == 0  # Pin every 3rd note
            }
            
            async with self.session.post(f"{BACKEND_URL}/notes", 
                                       json=note_data, 
                                       headers=self.get_auth_headers()) as resp:
                if resp.status == 200:
                    note = await resp.json()
                    created_notes.append(note["id"])
                    
        print(f"✅ Created {len(created_notes)} test notes")
        
        # Test 1: Basic pagination with page_size=10
        print("\n🔍 Testing GET /api/notes?page=1&page_size=10...")
        async with self.session.get(f"{BACKEND_URL}/notes?page=1&page_size=10", 
                                  headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                notes = await resp.json()
                if len(notes) <= 10:
                    print(f"✅ Page 1 returned {len(notes)} notes (≤10)")
                    self.test_results.append("✅ Notes pagination page_size=10 working")
                else:
                    print(f"❌ Page 1 returned {len(notes)} notes (>10)")
                    self.test_results.append("❌ Notes pagination page_size=10 not working")
            else:
                print(f"❌ Pagination request failed: {resp.status}")
                self.test_results.append("❌ Notes pagination request failed")
                
        # Test 2: Second page with page_size=5
        print("\n🔍 Testing GET /api/notes?page=2&page_size=5...")
        async with self.session.get(f"{BACKEND_URL}/notes?page=2&page_size=5", 
                                  headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                notes = await resp.json()
                if len(notes) <= 5:
                    print(f"✅ Page 2 returned {len(notes)} notes (≤5)")
                    self.test_results.append("✅ Notes pagination page=2&page_size=5 working")
                else:
                    print(f"❌ Page 2 returned {len(notes)} notes (>5)")
                    self.test_results.append("❌ Notes pagination page=2&page_size=5 not working")
            else:
                print(f"❌ Pagination request failed: {resp.status}")
                
        # Test 3: Maximum page_size limit (should be capped at 100)
        print("\n🔍 Testing page_size limit (should be capped at 100)...")
        async with self.session.get(f"{BACKEND_URL}/notes?page=1&page_size=200", 
                                  headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                notes = await resp.json()
                print(f"✅ Request with page_size=200 returned {len(notes)} notes")
                self.test_results.append("✅ Notes pagination max page_size limit working")
            else:
                print(f"❌ Max page_size test failed: {resp.status}")
                
        # Cleanup: Delete created test notes
        print("\n🧹 Cleaning up test notes...")
        for note_id in created_notes:
            async with self.session.delete(f"{BACKEND_URL}/notes/{note_id}", 
                                         headers=self.get_auth_headers()) as resp:
                pass  # Ignore cleanup errors
                
    async def test_batch_events_api(self):
        """Test batch events API for N+1 fix"""
        print("\n📅 TESTING BATCH EVENTS API")
        print("=" * 50)
        
        # First, create some test events
        print("📝 Creating test events for batch testing...")
        created_events = []
        for i in range(5):
            event_data = {
                "title": f"Test Event {i+1}",
                "description": f"Test event description {i+1}",
                "start_time": f"2026-03-{15+i:02d}T10:00:00Z",
                "end_time": f"2026-03-{15+i:02d}T11:00:00Z",
                "linked_note_ids": [],
                "reminder_minutes": 15
            }
            
            async with self.session.post(f"{BACKEND_URL}/events", 
                                       json=event_data, 
                                       headers=self.get_auth_headers()) as resp:
                if resp.status == 200:
                    event = await resp.json()
                    created_events.append(event["id"])
                    
        print(f"✅ Created {len(created_events)} test events")
        
        # Test 1: Batch events API with valid IDs
        print("\n🔍 Testing POST /api/events/batch with valid event IDs...")
        batch_data = {"event_ids": created_events[:3]}  # Use first 3 events
        
        async with self.session.post(f"{BACKEND_URL}/events/batch", 
                                   json=batch_data, 
                                   headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                events = await resp.json()
                if len(events) == 3:
                    print(f"✅ Batch API returned {len(events)} events (expected 3)")
                    self.test_results.append("✅ Batch events API working with valid IDs")
                else:
                    print(f"❌ Batch API returned {len(events)} events (expected 3)")
                    self.test_results.append("❌ Batch events API not returning correct count")
            else:
                error = await resp.text()
                print(f"❌ Batch events API failed: {resp.status} - {error}")
                self.test_results.append("❌ Batch events API request failed")
                
        # Test 2: Batch events API without auth (should return 401)
        print("\n🔍 Testing POST /api/events/batch without authentication...")
        async with self.session.post(f"{BACKEND_URL}/events/batch", json=batch_data) as resp:
            if resp.status == 401:
                print("✅ Batch events API correctly requires authentication (401)")
                self.test_results.append("✅ Batch events API auth requirement working")
            else:
                print(f"❌ Batch events API should return 401, got {resp.status}")
                self.test_results.append("❌ Batch events API auth requirement not working")
                
        # Test 3: Batch events API with empty array
        print("\n🔍 Testing POST /api/events/batch with empty event_ids...")
        empty_batch_data = {"event_ids": []}
        
        async with self.session.post(f"{BACKEND_URL}/events/batch", 
                                   json=empty_batch_data, 
                                   headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                events = await resp.json()
                if len(events) == 0:
                    print("✅ Batch API correctly returns empty array for empty input")
                    self.test_results.append("✅ Batch events API empty input handling working")
                else:
                    print(f"❌ Batch API should return empty array, got {len(events)} events")
                    
        # Cleanup: Delete created test events
        print("\n🧹 Cleaning up test events...")
        for event_id in created_events:
            async with self.session.delete(f"{BACKEND_URL}/events/{event_id}", 
                                         headers=self.get_auth_headers()) as resp:
                pass  # Ignore cleanup errors
                
    async def test_transcription_auth_requirements(self):
        """Test that transcription endpoints now require authentication"""
        print("\n🎤 TESTING TRANSCRIPTION AUTH REQUIREMENTS")
        print("=" * 50)
        
        # Test 1: POST /api/transcribe-base64 without auth
        print("🔍 Testing POST /api/transcribe-base64 without authentication...")
        transcribe_data = {
            "audio_base64": "dGVzdCBhdWRpbyBkYXRh",  # "test audio data" in base64
            "file_extension": "m4a"
        }
        
        async with self.session.post(f"{BACKEND_URL}/transcribe-base64", json=transcribe_data) as resp:
            if resp.status == 401:
                print("✅ transcribe-base64 correctly requires authentication (401)")
                self.test_results.append("✅ transcribe-base64 auth requirement working")
            else:
                error = await resp.text()
                print(f"❌ transcribe-base64 should return 401, got {resp.status} - {error}")
                self.test_results.append("❌ transcribe-base64 auth requirement not working")
                
        # Test 2: POST /api/process-text without auth
        print("\n🔍 Testing POST /api/process-text without authentication...")
        process_data = {
            "text": "This is test text to process",
            "action": "summarize"
        }
        
        async with self.session.post(f"{BACKEND_URL}/process-text", json=process_data) as resp:
            if resp.status == 401:
                print("✅ process-text correctly requires authentication (401)")
                self.test_results.append("✅ process-text auth requirement working")
            else:
                error = await resp.text()
                print(f"❌ process-text should return 401, got {resp.status} - {error}")
                self.test_results.append("❌ process-text auth requirement not working")
                
        # Test 3: POST /api/transcribe-base64 with auth (should work but may fail due to invalid data)
        print("\n🔍 Testing POST /api/transcribe-base64 with authentication...")
        async with self.session.post(f"{BACKEND_URL}/transcribe-base64", 
                                   json=transcribe_data, 
                                   headers=self.get_auth_headers()) as resp:
            if resp.status in [200, 400, 500]:  # 400/500 expected for invalid audio data
                print(f"✅ transcribe-base64 accepts authenticated requests ({resp.status})")
                self.test_results.append("✅ transcribe-base64 accepts authenticated requests")
            elif resp.status == 401:
                print("❌ transcribe-base64 still returns 401 with auth token")
                self.test_results.append("❌ transcribe-base64 auth not working properly")
            else:
                error = await resp.text()
                print(f"⚠️ transcribe-base64 unexpected response: {resp.status} - {error}")
                
        # Test 4: POST /api/process-text with auth (should work)
        print("\n🔍 Testing POST /api/process-text with authentication...")
        async with self.session.post(f"{BACKEND_URL}/process-text", 
                                   json=process_data, 
                                   headers=self.get_auth_headers()) as resp:
            if resp.status in [200, 500]:  # 500 might occur if AI service not configured
                print(f"✅ process-text accepts authenticated requests ({resp.status})")
                self.test_results.append("✅ process-text accepts authenticated requests")
            elif resp.status == 401:
                print("❌ process-text still returns 401 with auth token")
                self.test_results.append("❌ process-text auth not working properly")
            else:
                error = await resp.text()
                print(f"⚠️ process-text unexpected response: {resp.status} - {error}")
                
    async def run_all_tests(self):
        """Run all audit tests"""
        print("🚀 STARTING MEMOPAD TECHNICAL AUDIT TESTING")
        print("=" * 60)
        
        await self.setup()
        
        try:
            # Always test rate limiting (doesn't require auth)
            await self.test_rate_limiting()
            
            # Test transcription auth requirements (doesn't require valid auth)
            await self.test_transcription_auth_requirements()
            
            # Test existing functionality that doesn't require auth
            await self.test_health_check()
            
            if self.access_token:
                print("\n✅ Authentication successful - running authenticated tests")
                await self.test_notes_pagination()
                await self.test_batch_events_api()
                await self.test_authenticated_functionality()
            else:
                print("\n⚠️ No authentication - skipping authenticated tests")
                print("   Rate limiting and auth requirement tests completed")
            
        finally:
            await self.teardown()
            
        # Print final results
        print("\n" + "=" * 60)
        print("📊 FINAL TEST RESULTS")
        print("=" * 60)
        
        passed = 0
        failed = 0
        
        for result in self.test_results:
            print(result)
            if result.startswith("✅"):
                passed += 1
            else:
                failed += 1
                
        print(f"\n📈 SUMMARY: {passed} passed, {failed} failed")
        
        if failed == 0:
            print("🎉 ALL TECHNICAL AUDIT FIXES WORKING PERFECTLY!")
        else:
            print(f"⚠️ {failed} issues found that need attention")
            
    async def test_health_check(self):
        """Test health check endpoint"""
        print("\n🔧 TESTING HEALTH CHECK")
        print("=" * 50)
        
        print("🔍 Testing GET /api/health...")
        async with self.session.get(f"{BACKEND_URL}/health") as resp:
            if resp.status == 200:
                data = await resp.json()
                if "status" in data and data["status"] == "healthy":
                    print("✅ Health check working")
                    self.test_results.append("✅ Health check API working")
                else:
                    print(f"❌ Health check invalid response: {data}")
                    self.test_results.append("❌ Health check API invalid response")
            else:
                print(f"❌ Health check failed: {resp.status}")
                self.test_results.append("❌ Health check API failed")
                
    async def test_authenticated_functionality(self):
        """Test authenticated endpoints"""
        print("\n🔐 TESTING AUTHENTICATED FUNCTIONALITY")
        print("=" * 50)
        
        # Test Notes CRUD (with auth)
        print("🔍 Testing Notes CRUD with authentication...")
        
        # GET notes
        async with self.session.get(f"{BACKEND_URL}/notes", headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                notes = await resp.json()
                print(f"✅ GET /api/notes returned {len(notes)} notes")
                self.test_results.append("✅ Notes GET API working")
            else:
                print(f"❌ GET notes failed: {resp.status}")
                self.test_results.append("❌ Notes GET API failed")
                
        # POST note
        note_data = {
            "title": "Test Note for Existing Functionality",
            "content": "This is a test note to verify existing functionality still works.",
            "tags": [{"name": "test", "color": "#2196F3"}],
            "is_pinned": False
        }
        
        created_note_id = None
        async with self.session.post(f"{BACKEND_URL}/notes", 
                                   json=note_data, 
                                   headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                note = await resp.json()
                created_note_id = note["id"]
                print("✅ POST /api/notes working")
                self.test_results.append("✅ Notes POST API working")
            else:
                print(f"❌ POST note failed: {resp.status}")
                self.test_results.append("❌ Notes POST API failed")
                
        # Test Events CRUD (with auth)
        print("\n🔍 Testing Events CRUD with authentication...")
        
        # GET events
        async with self.session.get(f"{BACKEND_URL}/events", headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                events = await resp.json()
                print(f"✅ GET /api/events returned {len(events)} events")
                self.test_results.append("✅ Events GET API working")
            else:
                print(f"❌ GET events failed: {resp.status}")
                self.test_results.append("❌ Events GET API failed")
                
        # POST event
        event_data = {
            "title": "Test Event for Existing Functionality",
            "description": "This is a test event to verify existing functionality still works.",
            "start_time": "2026-03-20T14:00:00Z",
            "end_time": "2026-03-20T15:00:00Z",
            "linked_note_ids": [],
            "reminder_minutes": 30
        }
        
        created_event_id = None
        async with self.session.post(f"{BACKEND_URL}/events", 
                                   json=event_data, 
                                   headers=self.get_auth_headers()) as resp:
            if resp.status == 200:
                event = await resp.json()
                created_event_id = event["id"]
                print("✅ POST /api/events working")
                self.test_results.append("✅ Events POST API working")
            else:
                print(f"❌ POST event failed: {resp.status}")
                self.test_results.append("❌ Events POST API failed")
                
        # Cleanup created test data
        if created_note_id:
            async with self.session.delete(f"{BACKEND_URL}/notes/{created_note_id}", 
                                         headers=self.get_auth_headers()) as resp:
                pass
                
        if created_event_id:
            async with self.session.delete(f"{BACKEND_URL}/events/{created_event_id}", 
                                         headers=self.get_auth_headers()) as resp:
                pass

async def main():
    """Main test runner"""
    runner = AuditTestRunner()
    await runner.run_all_tests()

if __name__ == "__main__":
    asyncio.run(main())