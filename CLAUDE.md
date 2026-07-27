# MemoPad

React Native app (Expo SDK 55, expo-router) + FastAPI backend (Railway) + MongoDB.

- Frontend lives under `frontend/`, NOT the repo root.
- Backend lives under `backend/`, organized as one directory per feature
  (`auth/`, `attachments/`, `canva/`, `dailybrew/`, `textai/`), each with
  `router.py` (HTTP), `service.py` (business logic), `schemas.py` (data
  contracts).

## Clean Architecture rules

These apply to all new and edited code, backend and frontend. The goal is a
one-way dependency arrow: framework/infra code may depend on business logic,
never the other way around.

### 1. Entities and use cases must be framework-agnostic

Business logic — `backend/*/service.py`, and frontend modules that do
domain/calculation work (`frontend/src/crypto/*Core.ts`, `recurrence.ts`,
`textContent.ts`, sync logic) — must not import:

- Backend: `fastapi`, `starlette`, anything from a `router.py` in another
  module. Raise plain Python exceptions (or a project-defined exception
  type), never `fastapi.HTTPException`. Never type a parameter as
  `UploadFile` — accept bytes/streams and let the router unwrap the framework
  type first.
- Frontend: `react`, `react-native`, `expo-*`, `@react-native-*` packages.
  Pure logic files take plain data in and return plain data out; UI-only
  modules like `theme.ts` should never be imported for non-UI constants
  (e.g. `recurrence.ts` should not reach into `theme.ts` for `DAY_NAMES`/
  `MONTH_NAMES` — those belong in a shared constants file).

### 2. Infrastructure lives in the outermost layer

DB drivers, HTTP routers, storage/network clients, and UI components are
infrastructure. They may call into business logic; business logic must not
reach back into them.

- Backend: `motor`/`pymongo` access, `httpx` calls to third parties, and
  `boto3`/S3 calls belong behind a thin data-access function, not sprinkled
  directly through `service.py` with no seam. If a `service.py` needs the DB,
  the collection/DB handle should be passed in (dependency injection), not
  imported and wired up ad hoc alongside HTTP-only concerns.
- Frontend: `AsyncStorage`, `expo-file-system`, `NetInfo`, and other
  device/platform APIs are infrastructure. Sync engines (`offlineSync.ts`,
  `dailyBrew/dailyBrew.ts`) should isolate these calls behind small
  functions so the sync/business rules (what to sync, in what order, conflict
  resolution) can be read and tested without the platform APIs in the way.
- Routers only: parse/validate the HTTP request, call a service function,
  shape the HTTP response. No business rules in `router.py`.

### 3. Data crossing a boundary must be plain DTOs or primitives

- Backend: `schemas.py` (Pydantic models) and `auth/models.py` are the DTOs
  crossing the router ↔ service boundary. Keep them free of `fastapi`/`motor`
  imports — this is already true today and must stay true. Services return
  schema objects, dicts, or primitives — never a raw Motor cursor/document or
  a framework request/response object.
- Frontend: functions crossing the UI ↔ logic boundary pass plain
  objects/types from `types.ts`, not component instances, refs, or
  React-specific types (`JSX.Element`, event objects, etc).

## Known debt (fix opportunistically, don't let it spread)

- `backend/attachments/service.py`, `backend/textai/service.py` import
  `fastapi.HTTPException`/`UploadFile` directly — needs a translation layer
  in the router instead.
- `backend/auth/service.py`, `backend/canva/service.py` import
  `AsyncIOMotorDatabase` directly — acceptable short-term, but don't add more
  direct driver usage in new services without discussing a repository seam.
- `attachments/router.py`, `canva/router.py`, `dailybrew/router.py`,
  `textai/router.py` import `get_current_user`/`get_db` from `auth.router`
  instead of a shared dependency module.
- `frontend/src/recurrence.ts` imports `DAY_NAMES`/`MONTH_NAMES` from the UI
  `theme.ts`.

Do not use these as precedent for new code — they are the exceptions being
tracked down, not the pattern to copy.
