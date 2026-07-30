#!/usr/bin/env python3
"""
Final Comprehensive JWT Authentication Test for Nueco
Tests all JWT endpoints as requested in the review
"""

import requests
import json
import time
import uuid
from datetime import datetime, timezone

# Use the production URL from frontend/.env
BASE_URL = "https://web-production-a3258.up.railway.app/api"

class FinalJWTTester:
    def __init__(self):
        self.base_url = BASE_URL
        self.session = requests.Session()
        self.access_token = None
        self.refresh_token = None
        self.verified_email = "riobudiman@gmail.com"
        self.test_password = "testpassword123"
        self.test_name = "Rio Test User"
        
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
    
    def test_all_jwt_endpoints(self):
        """Test all JWT endpoints as specified in the review request"""
        self.log("=" * 60)
        self.log("COMPREHENSIVE JWT AUTHENTICATION TESTING")
        self.log(f"Backend URL: {self.base_url}")
        self.log("=" * 60)
        
        results = {}
        
        # 1. Test POST /api/auth/signup
        self.log("\n1. Testing POST /api/auth/signup")
        new_email = f"testuser_{int(time.time())}@example.com"
        signup_data = {
            "name": "Test User",
            "email": new_email,
            "password": "password123",
            "confirm_password": "password123"
        }
        
        response = self.make_request("POST", "/auth/signup", json=signup_data)
        if response and response.status_code == 200:
            data = response.json()
            if "verification email" in data.get("message", "").lower():
                self.log("✅ Signup successful - verification email message received")
                results["signup"] = True
            else:
                self.log(f"❌ Signup response unexpected: {data}")
                results["signup"] = False
        else:
            self.log(f"❌ Signup failed - status {response.status_code if response else 'None'}")
            results["signup"] = False
        
        # Test signup error cases
        self.log("\n1a. Testing signup error cases")
        
        # Mismatched passwords
        bad_signup = {
            "name": "Test User",
            "email": "test2@example.com",
            "password": "password123",
            "confirm_password": "different"
        }
        response = self.make_request("POST", "/auth/signup", json=bad_signup)
        if response and response.status_code == 400:
            self.log("✅ Correctly rejects mismatched passwords")
        else:
            self.log("❌ Should reject mismatched passwords")
        
        # Existing email
        response = self.make_request("POST", "/auth/signup", json=signup_data)
        if response and response.status_code == 400:
            self.log("✅ Correctly rejects existing email")
        else:
            self.log("❌ Should reject existing email")
        
        # 2. Test POST /api/auth/login
        self.log("\n2. Testing POST /api/auth/login")
        login_data = {
            "email": self.verified_email,
            "password": self.test_password,
            "device_name": "Test Device",
            "platform": "web"
        }
        
        response = self.make_request("POST", "/auth/login", json=login_data)
        if response and response.status_code == 200:
            data = response.json()
            if "access_token" in data and "refresh_token" in data:
                self.access_token = data["access_token"]
                self.refresh_token = data["refresh_token"]
                self.log("✅ Login successful - JWT tokens received")
                results["login"] = True
            else:
                self.log(f"❌ Login response missing tokens: {data}")
                results["login"] = False
        else:
            self.log(f"❌ Login failed - status {response.status_code if response else 'None'}")
            results["login"] = False
        
        # Test login error cases
        self.log("\n2a. Testing login error cases")
        
        # Wrong password
        wrong_login = {
            "email": self.verified_email,
            "password": "wrongpassword",
            "device_name": "Test Device",
            "platform": "web"
        }
        response = self.make_request("POST", "/auth/login", json=wrong_login)
        if response and response.status_code == 401:
            self.log("✅ Correctly rejects wrong password")
        else:
            self.log("❌ Should reject wrong password")
        
        # Non-existent email
        nonexistent_login = {
            "email": "nonexistent@example.com",
            "password": "password123",
            "device_name": "Test Device",
            "platform": "web"
        }
        response = self.make_request("POST", "/auth/login", json=nonexistent_login)
        if response and response.status_code == 401:
            self.log("✅ Correctly rejects non-existent email")
        else:
            self.log("❌ Should reject non-existent email")
        
        # 3. Test POST /api/auth/forgot-password
        self.log("\n3. Testing POST /api/auth/forgot-password")
        forgot_data = {
            "email": self.verified_email
        }
        
        response = self.make_request("POST", "/auth/forgot-password", json=forgot_data)
        if response and response.status_code == 200:
            data = response.json()
            if data.get("success"):
                self.log("✅ Forgot password request successful")
                results["forgot_password"] = True
            else:
                self.log(f"❌ Forgot password response invalid: {data}")
                results["forgot_password"] = False
        else:
            self.log(f"❌ Forgot password failed - status {response.status_code if response else 'None'}")
            results["forgot_password"] = False
        
        # 4. Test POST /api/auth/refresh
        self.log("\n4. Testing POST /api/auth/refresh")
        if self.refresh_token:
            refresh_data = {
                "refresh_token": self.refresh_token
            }
            
            response = self.make_request("POST", "/auth/refresh", json=refresh_data)
            if response and response.status_code == 200:
                data = response.json()
                if "access_token" in data:
                    old_token = self.access_token
                    self.access_token = data["access_token"]
                    self.log("✅ Token refresh successful")
                    results["refresh"] = True
                else:
                    self.log(f"❌ Refresh response missing access_token: {data}")
                    results["refresh"] = False
            else:
                self.log(f"❌ Token refresh failed - status {response.status_code if response else 'None'}")
                results["refresh"] = False
        else:
            self.log("❌ No refresh token available for testing")
            results["refresh"] = False
        
        # 5. Test POST /api/auth/logout
        self.log("\n5. Testing POST /api/auth/logout")
        if self.refresh_token:
            logout_data = {
                "refresh_token": self.refresh_token
            }
            
            response = self.make_request("POST", "/auth/logout", json=logout_data)
            if response and response.status_code == 200:
                data = response.json()
                if data.get("success"):
                    self.log("✅ Logout successful")
                    results["logout"] = True
                else:
                    self.log(f"❌ Logout response invalid: {data}")
                    results["logout"] = False
            else:
                self.log(f"❌ Logout failed - status {response.status_code if response else 'None'}")
                results["logout"] = False
        else:
            self.log("❌ No refresh token available for testing")
            results["logout"] = False
        
        # 6. Test existing endpoints still work
        self.log("\n6. Testing existing endpoints")
        
        # Health check
        response = self.make_request("GET", "/health")
        if response and response.status_code == 200:
            self.log("✅ GET /api/health working")
            results["health"] = True
        else:
            self.log("❌ GET /api/health failed")
            results["health"] = False
        
        # Notes endpoint
        response = self.make_request("GET", "/notes")
        if response and response.status_code == 200:
            notes = response.json()
            self.log(f"✅ GET /api/notes working - {len(notes)} notes found")
            results["notes"] = True
        else:
            self.log("❌ GET /api/notes failed")
            results["notes"] = False
        
        # Summary
        self.log("\n" + "=" * 60)
        self.log("FINAL TEST RESULTS SUMMARY")
        self.log("=" * 60)
        
        passed = sum(1 for v in results.values() if v)
        total = len(results)
        
        for test_name, result in results.items():
            status = "✅ PASS" if result else "❌ FAIL"
            self.log(f"  {test_name.upper()}: {status}")
        
        self.log(f"\nOVERALL: {passed}/{total} tests passed")
        
        if passed == total:
            self.log("🎉 ALL JWT AUTHENTICATION ENDPOINTS WORKING PERFECTLY!")
        elif passed >= total * 0.8:
            self.log("✅ JWT Authentication mostly working with minor issues")
        else:
            self.log("❌ JWT Authentication has significant issues")
        
        return results

if __name__ == "__main__":
    tester = FinalJWTTester()
    results = tester.test_all_jwt_endpoints()