# AGENTS.md

This file provides guidance to the AI agent when working with code in this repository.

## Project

Nueco — React Native (Expo SDK 55, expo-router) + FastAPI backend (Railway) + MongoDB.
End-to-end encrypted notes, events, reminders, and trips. E2EE is ON for all builds and irreversible.

## Layout

- `frontend/` — Expo app. Run `npx expo start` from there.
- `backend/` — FastAPI server. Run `uvicorn server:app --host 0.0.0.0 --port 8000` from `backend/`. `.env` lives in `backend/`.
- `tests/` — Simulation eval suite. Legacy `*_test.py` scripts at repo root are stale and should NOT be run (they hit live infra).

## Build & test commands

```
# Frontend (run from frontend/)
npx expo start
npm run lint                          # eslint via expo
npm run test:crypto                   # E2EE unit tests (node --import resolver)
npm run test:share                    # text/share unit tests
npm run test:sync                     # sync/merge unit tests
npm run build:web-editor              # vite build for rich-text editor webview
npm run build:pdf-extractor           # vite build for PDF extractor webview

# Backend (run from backend/)
uvicorn server:app --host 0.0.0.0 --port 8000

# Tests (run from repo root)
pytest                                # runs tests/evals/ only (see pytest.ini)
```

Frontend test scripts use `node --import ./src/crypto/_ts-resolver.mjs` to run `.ts` files directly. Do not run them with `jest` or `npx tsx`.

## Clean architecture rules

One-way dependency arrow: infrastructure depends on business logic, never the reverse.

- **Backend `service.py`** must not import `fastapi`, `starlette`, `UploadFile`, or any `router.py` from another module. Raise plain Python exceptions, never `HTTPException`. Accept bytes/streams, not framework types.
- **Frontend pure-logic files** (`crypto/*Core.ts`, `recurrence.ts`, `textContent.ts`, sync logic) must not import `react`, `react-native`, `expo-*`, or `@react-native-*`.
- **Routers only**: parse request, call service, shape response. No business logic in `router.py`.
- **Cross-boundary data**: Pydantic models (`schemas.py`) or plain dicts/primitives. Never pass raw Motor cursors or framework request/response objects. Frontend UI ↔ logic boundaries pass plain types from `types.ts` — never component instances, refs, `JSX.Element`, or React event objects.
- `backend/core/deps.py` holds shared FastAPI dependencies (`get_current_user`, `get_db`) — import from there.

## Backend module structure

Each feature (`auth/`, `notes/`, `events/`, `reminders/`, `accounts/`, `feedback/`, `canva/`, `dailybrew/`, `textai/`, `attachments/`, `trips/`) has:
- `router.py` — HTTP endpoints
- `service.py` — business logic
- `schemas.py` — data contracts (where the module has its own request/response bodies)

Routers are registered in `backend/server.py` and mounted under `/api`.

## Git conventions

- Branch naming: `feat/<slug>`, `fix/<slug>`
- Commit messages: imperative mood, concise. e.g. "Add event detail view, all-day events, skeletons"
- No conventional commit prefixes (`feat:`, `fix:`, etc.)

## Known debt (fix opportunistically, don't spread)

- `backend/auth/service.py` and `backend/canva/service.py` import `AsyncIOMotorDatabase` directly — don't copy this pattern into new services.
