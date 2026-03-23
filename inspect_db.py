#!/usr/bin/env python3
"""
Database inspection script to check user structure
"""

import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv('/app/backend/.env')

async def inspect_database():
    mongo_url = os.environ['MONGO_URL']
    client = AsyncIOMotorClient(mongo_url)
    db = client[os.environ['DB_NAME']]
    
    print("=== Inspecting Users Collection ===")
    users = await db.users.find().to_list(length=10)
    print(f"Found {len(users)} users:")
    
    for i, user in enumerate(users):
        print(f"\nUser {i+1}:")
        for key, value in user.items():
            if key == 'password':
                print(f"  {key}: [HIDDEN]")
            else:
                print(f"  {key}: {value}")
    
    print("\n=== Inspecting Devices Collection ===")
    devices = await db.devices.find().to_list(length=10)
    print(f"Found {len(devices)} devices:")
    
    for i, device in enumerate(devices):
        print(f"\nDevice {i+1}:")
        for key, value in device.items():
            print(f"  {key}: {value}")
    
    print("\n=== Inspecting Sessions Collection ===")
    sessions = await db.sessions.find().to_list(length=10)
    print(f"Found {len(sessions)} sessions:")
    
    for i, session in enumerate(sessions):
        print(f"\nSession {i+1}:")
        for key, value in session.items():
            if key == 'refresh_token':
                print(f"  {key}: [HIDDEN]")
            else:
                print(f"  {key}: {value}")
    
    client.close()

if __name__ == "__main__":
    asyncio.run(inspect_database())