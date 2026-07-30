---
name: verify
description: How to actually run the Nueco backend locally and drive it end-to-end (not just typecheck/import).
---

# Running the backend for real

`requirements.txt` is a full production freeze (includes google-genai/grpc deps for a
feature `server.py` doesn't even import) and is **not directly pip-installable** —
`google-api-core[grpc]==2.30.0` conflicts with pinned `grpcio-status`/`protobuf`. Don't
fight the resolver. `server.py`'s actual top-level imports are just: fastapi, uvicorn,
python-dotenv, motor, pydantic, email-validator, bcrypt, httpx, pymongo, openai,
python-dateutil, boto3, pyjwt, requests, cryptography, python-multipart. Install those
directly into a venv instead of `-r requirements.txt`.

```bash
python3 -m venv /tmp/nueco_venv && source /tmp/nueco_venv/bin/activate
pip install fastapi==0.110.1 uvicorn python-dotenv motor pydantic email-validator \
  bcrypt httpx pymongo openai python-dateutil boto3 pyjwt requests cryptography \
  python-multipart mongomock mongomock-motor
```

## Mongo

`backend/.env`'s `MONGO_URL` points at the real Atlas cluster and its credentials were
**auth-failing** as of 2026-07-16 (`bad auth: authentication failed`) — don't rely on it
being reachable/writable for local verification. No local mongod/docker available in this
environment either. Instead, monkeypatch Motor to an in-process fake before importing
`server`, so real HTTP requests exercise real routes/dependencies/DB reads-writes without
touching Atlas:

```python
import motor.motor_asyncio
from mongomock_motor import AsyncMongoMockClient
motor.motor_asyncio.AsyncIOMotorClient = lambda *a, **k: AsyncMongoMockClient()
import server  # now server.db is the mock
```

## Driving it end-to-end

Don't `import` and call service functions directly — go through the real ASGI app with
`httpx.ASGITransport(app=server.app)` so routing/auth deps/validation all actually run.
Auth flow needs care:

- Signup is `/api/auth/signup` (not `/register`). Fields: `name`, `email`, `password`,
  `confirm_password`.
- Signup always tries to email a verification link via Resend (`auth/email_service.py`,
  keyed off `SMTP_PASS`). Run with `SMTP_PASS=""` in the env so it dev-mode-logs instead
  of hitting the real Resend API with the production key from `.env`.
- No SMTP_PASS means no real email, so grab the token directly:
  `(await server.db.users.find_one({"email": ...}))["verification_token"]`, then
  `GET /api/auth/verify-email/{token}` before `/api/auth/login` will succeed.
- News prefs endpoint is `PUT /api/auth/me/news-preferences` with body
  `{country, outlet_ids, show_verse}` (not `news_country`/`news_outlet_ids` — those are
  the *response* field names on `UserResponse`, different from the request schema).

## Daily Brew specifics

- `backend/dailybrew/catalog.py` only has curated outlets for **AU** and **ID** —
  every other country code (including `US`) legitimately returns `{"outlets": []}`, not
  a bug.
- `GET /api/dailybrew/news` fetches **real live RSS feeds** over the network
  (e.g. `theguardian.com/au/rss`, `abc.net.au/news/feed/...`) — expect real external
  HTTP calls when you hit this endpoint with valid outlet_ids set.
- `outlet_ids` is resolved against the *entire* outlet pool (country catalog + topic
  pool), not filtered by the user's `news_country` — that's intentional (see comment in
  `get_headlines_for_user`), so a mismatched country/outlet_ids combo or an unknown
  outlet id is silently tolerated, not an error.

## Frontend

There's no working native runtime in this environment (no full Xcode/simctl, no Android
emulator). `expo start --web` bundles fine but the app **crashes at runtime** with
`Cannot read properties of undefined (reading 'getEnforcing')` — a native module with no
web shim — so the web target cannot be used to verify UI either. Frontend UI changes are
effectively unverifiable end-to-end in this environment; say so rather than faking it.
