#!/usr/bin/env python3
"""
JWT Authentication Testing for MemoPad
Tests the new JWT authentication endpoints specifically
"""

import requests
import json
import time
import uuid
from datetime import datetime, timezone

# Use the production URL from frontend/.env
BASE_URL = "https://note-builder-10.preview.emergentagent.com/api"

class JWTAuthTester:
    def __init__(self):
        self.base_url = BASE_URL
        self.session = requests.Session()
        self.access_token = None
        self.refresh_token = None
        # Use the verified email from backend logs
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
            if response.status_code >= 400:
                self.log(f"Response: {response.text}")
            return response
        except requests.exceptions.RequestException as e:
            self.log(f"Request failed: {e}", "ERROR")
            return None
    
    def test_signup_with_verified_email(self):
        """Test signup with the verified email address"""
        self.log("=== Testing JWT Auth Signup (Verified Email) ===")
        
        signup_data = {
            "name": self.test_name,
            "email": self.verified_email,
            "password": self.test_password,
            "confirm_password": self.test_password
        }
        
        response = self.make_request("POST", "/auth/signup", json=signup_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if data.get("success"):
                self.log("✅ Signup successful with verified email")
                return True
            else:
                self.log(f"❌ Signup failed: {data}", "ERROR")
                return False
        elif response.status_code == 400 and "already exists" in response.text.lower():
            self.log("✅ User already exists - this is expected for verified email")
            return True
        else:
            self.log(f"❌ Signup failed - status {response.status_code}", "ERROR")
            return False
    
    def test_login_and_get_tokens(self):
        """Test login to get JWT tokens"""
        self.log("=== Testing JWT Auth Login ===")
        
        login_data = {
            "email": self.verified_email,
            "password": self.test_password,
            "device_name": "Test Device JWT",
            "platform": "web"
        }
        
        response = self.make_request("POST", "/auth/login", json=login_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if "access_token" in data and "refresh_token" in data:
                self.access_token = data["access_token"]
                self.refresh_token = data["refresh_token"]
                self.log("✅ Login successful - JWT tokens received")
                self.log(f"Access token length: {len(self.access_token)}")
                self.log(f"Refresh token length: {len(self.refresh_token)}")
                return True
            else:
                self.log(f"❌ Login response missing tokens: {data}", "ERROR")
                return False
        elif response.status_code == 401:
            self.log("❌ Login failed - wrong credentials", "ERROR")
            return False
        elif response.status_code == 403:
            self.log("❌ Login failed - email not verified", "ERROR")
            return False
        else:
            self.log(f"❌ Login failed - status {response.status_code}", "ERROR")
            return False
    
    def test_refresh_token(self):
        """Test JWT token refresh"""
        self.log("=== Testing JWT Token Refresh ===")
        
        if not self.refresh_token:
            self.log("❌ No refresh token available", "ERROR")
            return False
            
        refresh_data = {
            "refresh_token": self.refresh_token
        }
        
        response = self.make_request("POST", "/auth/refresh", json=refresh_data)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if "access_token" in data:
                old_token = self.access_token
                self.access_token = data["access_token"]
                self.log("✅ Token refresh successful")
                self.log(f"New access token length: {len(self.access_token)}")
                if old_token != self.access_token:
                    self.log("✅ New access token is different from old one")
                return True
            else:
                self.log(f"❌ Refresh response missing access_token: {data}", "ERROR")
                return False
        else:
            self.log(f"❌ Token refresh failed - status {response.status_code}", "ERROR")
            return False
    
    def test_authenticated_endpoint(self):
        """Test accessing protected endpoint with JWT token"""
        self.log("=== Testing Authenticated Endpoint (/auth/me) ===")
        
        if not self.access_token:
            self.log("❌ No access token available", "ERROR")
            return False
            
        headers = {
            "Authorization": f"Bearer {self.access_token}"
        }
        
        response = self.make_request("GET", "/auth/me", headers=headers)
        if not response:
            return False
            
        if response.status_code == 200:
            data = response.json()
            if "email" in data and data["email"] == self.verified_email:
                self.log("✅ Authenticated endpoint access successful")
                self.log(f"User data: {data}")
                return True
            else:
                self.log(f"❌ Unexpected user data: {data}", "ERROR")
                return False
        elif response.status_code == 401:
            self.log("❌ Authentication failed - invalid token", "ERROR")
            return False
        else:
            self.log(f"❌ Authenticated endpoint failed - status {response.status_code}", "ERROR")
            return False
    
    def test_forgot_password(self):
        """Test forgot password endpoint"""
        self.log("=== Testing JWT Forgot Password ===")
        
        forgot_data = {
            "email": self.verified_email
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
            self.log(f"❌ Forgot password failed - status {response.status_code}", "ERROR")
            return False
    
    def test_logout(self):
        """Test logout endpoint"""
        self.log("=== Testing JWT Logout ===")
        
        if not self.refresh_token:
            self.log("❌ No refresh token available", "ERROR")
            return False
            
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
            self.log(f"❌ Logout failed - status {response.status_code}", "ERROR")
            return False
    
    def test_token_after_logout(self):
        """Test that tokens are invalid after logout"""
        self.log("=== Testing Token Invalidation After Logout ===")
        
        if not self.access_token:
            self.log("❌ No access token to test", "ERROR")
            return False
            
        headers = {
            "Authorization": f"Bearer {self.access_token}"
        }
        
        response = self.make_request("GET", "/auth/me", headers=headers)
        if not response:
            return False
            
        if response.status_code == 401:
            self.log("✅ Access token correctly invalidated after logout")
            return True
        elif response.status_code == 200:
            self.log("❌ Access token still valid after logout", "ERROR")
            return False
        else:
            self.log(f"❌ Unexpected response - status {response.status_code}", "ERROR")
            return False
    
    def test_error_cases(self):
        """Test various error cases"""
        self.log("=== Testing Error Cases ===")
        
        # Test signup with mismatched passwords
        bad_signup = {
            "name": "Test User",
            "email": "test@example.com",
            "password": "password123",
            "confirm_password": "different"
        }
        
        response = self.make_request("POST", "/auth/signup", json=bad_signup)
        if response and response.status_code == 400:
            self.log("✅ Correctly rejects mismatched passwords")
        else:
            self.log("❌ Should reject mismatched passwords", "ERROR")
            return False
        
        # Test login with wrong password
        bad_login = {
            "email": self.verified_email,
            "password": "wrongpassword",
            "device_name": "Test Device",
            "platform": "web"
        }
        
        response = self.make_request("POST", "/auth/login", json=bad_login)
        if response and response.status_code == 401:
            self.log("✅ Correctly rejects wrong password")
        else:
            self.log("❌ Should reject wrong password", "ERROR")
            return False
        
        # Test refresh with invalid token
        bad_refresh = {
            "refresh_token": "invalid_token_12345"
        }
        
        response = self.make_request("POST", "/auth/refresh", json=bad_refresh)
        if response and response.status_code == 401:
            self.log("✅ Correctly rejects invalid refresh token")
        else:
            self.log("❌ Should reject invalid refresh token", "ERROR")
            return False
        
        return True
    
    def run_comprehensive_jwt_test(self):
        """Run comprehensive JWT authentication test"""
        self.log(f"Starting comprehensive JWT authentication testing")
        self.log(f"Backend URL: {self.base_url}")
        self.log(f"Using verified email: {self.verified_email}")
        
        tests = [
            ("Signup (Verified Email)", self.test_signup_with_verified_email),
            ("Login & Get Tokens", self.test_login_and_get_tokens),
            ("Token Refresh", self.test_refresh_token),
            ("Authenticated Endpoint", self.test_authenticated_endpoint),
            ("Forgot Password", self.test_forgot_password),
            ("Error Cases", self.test_error_cases),
            ("Logout", self.test_logout),
            ("Token Invalidation", self.test_token_after_logout),
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
        
        self.log("=" * 60)
        self.log(f"JWT AUTHENTICATION TESTING SUMMARY: {passed}/{total} tests passed")
        
        for test_name, result in results.items():
            status = "✅ PASS" if result else "❌ FAIL"
            self.log(f"  {test_name}: {status}")
        
        return results

if __name__ == "__main__":
    tester = JWTAuthTester()
    results = tester.run_comprehensive_jwt_test()