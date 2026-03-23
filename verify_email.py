#!/usr/bin/env python3
"""
Script to manually verify email for testing
"""

import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv('/app/backend/.env')

async def verify_email():
    mongo_url = os.environ['MONGO_URL']
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ['DB_NAME']]
    
    email = "riobudiman@gmail.com"
    
    print(f"=== Manually Verifying Email: {email} ===")
    
    # Find user by email
    user = await db.users.find_one({"email": email})
    if not user:
        print(f"❌ User not found: {email}")
        return
    
    # Update email verification status
    result = await db.users.update_one(
        {"email": email},
        {
            "$set": {"email_verified": True},
            "$unset": {"verification_token": "", "verification_token_expiry": ""}
        }
    )
    
    if result.modified_count > 0:
        print(f"✅ Email verified for: {email}")
    else:
        print(f"❌ Failed to verify email for: {email}")
    
    # Verify the update
    updated_user = await db.users.find_one({"email": email})
    print(f"Email verified status: {updated_user.get('email_verified', False)}")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(verify_email())