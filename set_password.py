#!/usr/bin/env python3
"""
Script to set password for testing user
"""

import asyncio
import os
import bcrypt
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv('/app/backend/.env')

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()

async def set_password():
    mongo_url = os.environ['MONGO_URL']
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ['DB_NAME']]
    
    email = "riobudiman@gmail.com"
    password = "testpassword123"
    
    print(f"=== Setting Password for: {email} ===")
    
    # Find user by email
    user = await db.users.find_one({"email": email})
    if not user:
        print(f"❌ User not found: {email}")
        return
    
    # Hash the password
    password_hash = hash_password(password)
    
    # Update password
    result = await db.users.update_one(
        {"email": email},
        {
            "$set": {
                "password": password_hash,
                "email_verified": True,
                "failed_login_attempts": 0,
                "locked_until": None
            }
        }
    )
    
    if result.modified_count > 0:
        print(f"✅ Password set for: {email}")
        print(f"Password: {password}")
    else:
        print(f"❌ Failed to set password for: {email}")
    
    # Verify the update
    updated_user = await db.users.find_one({"email": email})
    print(f"User has password: {bool(updated_user.get('password'))}")
    print(f"Email verified: {updated_user.get('email_verified', False)}")
    print(f"User ID: {updated_user.get('id', 'No ID')}")
    print(f"User name: {updated_user.get('name', 'No name')}")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(set_password())