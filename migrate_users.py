#!/usr/bin/env python3
"""
Migration script to update user documents for JWT authentication
"""

import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
from uuid import uuid4
from datetime import datetime

load_dotenv('/app/backend/.env')

async def migrate_users():
    mongo_url = os.environ['MONGO_URL']
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ['DB_NAME']]
    
    print("=== Migrating Users for JWT Authentication ===")
    
    # Get all users
    users = await db.users.find().to_list(length=1000)
    print(f"Found {len(users)} users to migrate")
    
    for user in users:
        # Check if user already has 'id' field
        if 'id' in user:
            print(f"User {user.get('email', 'unknown')} already has 'id' field, skipping")
            continue
            
        # Create new 'id' field using UUID
        user_id = str(uuid4())
        
        # Prepare update document
        update_doc = {
            "id": user_id,
            "updated_at": datetime.utcnow()
        }
        
        # Add missing fields for JWT auth if they don't exist
        if 'name' not in user:
            update_doc['name'] = user.get('email', 'User').split('@')[0] if user.get('email') else 'User'
        
        if 'failed_login_attempts' not in user:
            update_doc['failed_login_attempts'] = 0
            
        if 'locked_until' not in user:
            update_doc['locked_until'] = None
            
        if 'reset_token' not in user:
            update_doc['reset_token'] = None
            
        if 'reset_token_expiry' not in user:
            update_doc['reset_token_expiry'] = None
        
        # Update the user document
        result = await db.users.update_one(
            {"_id": user["_id"]},
            {"$set": update_doc}
        )
        
        if result.modified_count > 0:
            print(f"✅ Migrated user: {user.get('email', 'unknown')} -> ID: {user_id}")
        else:
            print(f"❌ Failed to migrate user: {user.get('email', 'unknown')}")
    
    print("\n=== Migration Complete ===")
    
    # Verify migration
    updated_users = await db.users.find().to_list(length=10)
    print(f"Verification: {len([u for u in updated_users if 'id' in u])}/{len(updated_users)} users have 'id' field")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(migrate_users())