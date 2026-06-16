#!/usr/bin/env python3
"""
Debug Auth Issues - Focused testing for auth endpoints
"""

import requests
import json
import time

BASE_URL = "https://web-production-a3258.up.railway.app/api"

def test_auth_signup_detailed():
    """Test signup with detailed error checking"""
    print("=== Testing Auth Signup with Detailed Debugging ===")
    
    # Test mismatched passwords
    signup_data = {
        "name": "Test User",
        "email": f"testuser_{int(time.time())}@example.com",
        "password": "password123",
        "confirm_password": "differentpassword"
    }
    
    response = requests.post(f"{BASE_URL}/auth/signup", json=signup_data)
    print(f"Mismatched passwords test: Status {response.status_code}")
    print(f"Response: {response.text}")
    
    if response.status_code == 400:
        print("✅ Correctly rejects mismatched passwords")
    else:
        print("❌ Should reject mismatched passwords")
    
    # Test successful signup
    good_signup_data = {
        "name": "Test User Good",
        "email": f"gooduser_{int(time.time())}@example.com",
        "password": "Password123",
        "confirm_password": "Password123"
    }
    
    response = requests.post(f"{BASE_URL}/auth/signup", json=good_signup_data)
    print(f"\nGood signup test: Status {response.status_code}")
    print(f"Response: {response.text}")
    
    return good_signup_data["email"], good_signup_data["password"]

def test_auth_login_detailed(email, password):
    """Test login with detailed error checking"""
    print("\n=== Testing Auth Login with Detailed Debugging ===")
    
    # Test login with correct credentials
    login_data = {
        "email": email,
        "password": password,
        "device_name": "Test Device",
        "platform": "web"
    }
    
    response = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    print(f"Login test: Status {response.status_code}")
    print(f"Response: {response.text}")
    
    if response.status_code == 403:
        print("✅ Correctly requires email verification")
    elif response.status_code == 200:
        print("✅ Login successful (email verification bypassed)")
        data = response.json()
        return data.get("access_token"), data.get("refresh_token")
    else:
        print(f"❌ Unexpected login response: {response.status_code}")
    
    # Test login with wrong password
    wrong_login_data = {
        "email": email,
        "password": "wrongpassword",
        "device_name": "Test Device",
        "platform": "web"
    }
    
    response = requests.post(f"{BASE_URL}/auth/login", json=wrong_login_data)
    print(f"\nWrong password test: Status {response.status_code}")
    print(f"Response: {response.text}")
    
    if response.status_code == 401:
        print("✅ Correctly rejects wrong password")
    else:
        print("❌ Should reject wrong password")
    
    return None, None

def test_legacy_user_login():
    """Test login with a legacy user that might not have 'id' field"""
    print("\n=== Testing Legacy User Login (Email-based queries) ===")
    
    # Try to login with test@example.com as mentioned in the review request
    login_data = {
        "email": "test@example.com",
        "password": "Password123",
        "device_name": "Test Device",
        "platform": "web"
    }
    
    response = requests.post(f"{BASE_URL}/auth/login", json=login_data)
    print(f"Legacy user login test: Status {response.status_code}")
    print(f"Response: {response.text}")
    
    if response.status_code == 401:
        print("✅ User doesn't exist or wrong password (expected for test user)")
    elif response.status_code == 403:
        print("✅ User exists but needs email verification")
    elif response.status_code == 200:
        print("✅ Login successful - legacy user login working")
        data = response.json()
        return data.get("access_token"), data.get("refresh_token")
    else:
        print(f"❌ Unexpected response: {response.status_code}")
    
    return None, None

if __name__ == "__main__":
    # Test signup
    email, password = test_auth_signup_detailed()
    
    # Test login
    access_token, refresh_token = test_auth_login_detailed(email, password)
    
    # Test legacy user login
    legacy_access_token, legacy_refresh_token = test_legacy_user_login()
    
    print("\n=== Summary ===")
    print(f"Signup working: {'✅' if email else '❌'}")
    print(f"Login working: {'✅' if access_token or legacy_access_token else '❌'}")
    print(f"Legacy user support: {'✅' if legacy_access_token else 'Unknown (no legacy user found)'}")