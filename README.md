# Nueco

> An end-to-end encrypted voice-first notebook: capture thoughts by voice, let AI organize them, and keep every note, event, and trip private by default.

<!-- Badge placeholders — replace <USER>/<REPO> and enable once CI is public -->
<!--
![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Web-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![E2EE](https://img.shields.io/badge/encryption-E2EE-orange)
-->

## Table of Contents

- [About The Project](#about-the-project)
- [Features](#features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Backend Setup](#backend-setup)
  - [Frontend Setup](#frontend-setup)
- [Usage Example](#usage-example)
- [Testing](#testing)
- [Project Layout](#project-layout)
- [Contributing](#contributing)
- [License](#license)

## About The Project

Nueco exists because note-taking apps force a trade-off: either your content lives on a server
that can read it, or the capture experience is so slow you stop capturing. Nueco resolves both:

- **Capture is frictionless.** One tap records voice; on-device VAD segments speech, transcripts
  arrive with speaker labels, and AI files the result into structured notes, events, or trips.
- **Privacy is structural.** Notes, events, and trips are encrypted on the device with AES-GCM
  before they ever touch the network. The backend stores ciphertext it cannot decrypt — key
  escrow is wrapped so only the user's device holds the unwrap path. E2EE is enabled for every
  build and is irreversible by design.
- **Offline is the default state.** A file-backed sync queue keeps the full working set local,
  merges conflicts deterministically, and syncs opportunistically when a connection returns.

Technical decisions worth calling out:

- **Transport-only plaintext for AI features.** Voice transcription and text organisation send
  plaintext to AI subprocessors by necessity; this boundary is explicit, opt-in per feature, and
  documented in `docs/data-flow.md`.
- **Region enforcement at boot.** `backend/core/regions.py` validates every external service
  endpoint and region declaration against an Australian-region allowlist before the server will
  accept traffic (Australian Privacy Act alignment).
- **Clean dependency arrow.** Backend services raise plain Python exceptions and never import
  FastAPI; frontend pure-logic modules (`crypto/*Core.ts`, sync, recurrence) never import React
  or React Native.

## Features

- **End-to-end encryption** for notes, events, and trips (AES-GCM, WebCrypto, Keystore-backed DEK) with an on-device self-check route (`/crypto-check`)
- **Voice capture pipeline** — VAD segmentation, diarised transcription (OpenAI Whisper / Speechmatics), voice intent classification into notes vs. events
- **AI text tools** — organize, summarize, and format note content with per-user quota management
- **Two-way Google Calendar sync** with OAuth PKCE and conflict-aware event mapping
- **Reminders** with scheduled local notifications and Expo push delivery
- **Daily Brew** — a personalised, location-aware news digest from curated and user-added RSS feeds
- **Attachments** — E2EE file attachments stored as ciphertext in S3 via presigned URLs
- **Offline-first sync engine** — file-backed queue, deterministic conflict resolution, background sync
- **Fail-closed data residency** — server refuses to boot unless every external endpoint declares an approved AU region

## Architecture

| Layer | Stack |
|---|---|
| Mobile app | Expo SDK 55, React Native (new architecture), expo-router, TypeScript |
| Backend | FastAPI + Uvicorn, Pydantic v2, hosted on Railway |
| Database | MongoDB Atlas via Motor (async) |
| Storage | AWS S3 (presigned uploads, ciphertext only) |
| AI providers | OpenAI (Whisper + GPT-4o-mini), Speechmatics (diarisation) |
| Messaging | Expo Push (FCM), Resend (transactional email) |
| Analytics | PostHog (strictly opt-in, feature flags) |

## Getting Started

### Prerequisites

- **Node.js ≥ 20** and **Yarn** (frontend)
- **Python 3.11+** (backend)
- A **MongoDB Atlas** connection string
- API keys for the services you intend to exercise: OpenAI, Resend, AWS, PostHog (all optional for basic local runs except MongoDB)

### Backend Setup

```bash
git clone https://github.com/riostudio/nueco.git
cd nueco/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r ../requirements-dev.txt
cp .env.example .env   # then fill in MONGO_URL, DB_NAME, JWT secret, provider keys
uvicorn server:app --host 0.0.0.0 --port 8000
```

> **Important:** Every outbound service endpoint and its region must be declared in the
> environment (e.g. `OPENAI_BASE_URL` + `OPENAI_REGION`, `AWS_REGION`, `POSTHOG_HOST`).
> The server **fails closed at boot** if any declaration is missing or outside the approved
> Australian regions — see `backend/core/regions.py` for the full list.

### Frontend Setup

```bash
cd frontend
yarn install
cp .env.example .env   # set EXPO_PUBLIC_BACKEND_URL to your backend origin
npx expo start
```

Press `a` to launch on a connected Android device, or use a dev build via EAS:

```bash
eas build --platform android --profile preview --local
```

## Usage Example

With the backend running, create an account and sync a note:

```bash
# Sign up
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "s3cret-pass", "name": "You"}'

# Verify via the emailed link, then log in
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "password": "s3cret-pass"}'

# Push an already-encrypted note (payload is opaque ciphertext to the server)
curl -X POST http://localhost:8000/api/notes/sync \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"type": "upsert", "note": {"id": "…", "encrypted_content": "…", "wrapped_keys": {"…": "…"}}}]}'
```

## Testing

```bash
# Backend (from repo root) — simulation eval suite only
pytest

# Backend region enforcement
pytest backend/tests/test_regions.py

# Frontend E2EE + sync unit tests (from frontend/)
npm run test:crypto
npm run test:share
npm run test:sync
```

> **Note:** Legacy `*_test.py` scripts at the repo root are stale and hit live infrastructure —
> do not run them. Frontend test scripts use a custom Node resolver; do not run them with Jest
> or `tsx`.

## Project Layout

```
├── backend/               # FastAPI app (mounted under /api)
│   ├── core/              # shared deps + region enforcement
│   ├── auth/ notes/ events/ reminders/ trips/
│   ├── textai/ attachments/ dailybrew/ canva/
│   └── static/            # privacy policy, terms, assetlinks.json
├── frontend/              # Expo app
│   ├── app/               # expo-router screens
│   └── src/               # api, crypto, sync, google, audio modules
├── tests/evals/           # pytest simulation suite
└── docs/                  # data-flow map, residency gap analysis
```

## Contributing

Contributions are welcome. Branch naming: `feat/<slug>` or `fix/<slug>`; commit messages in the
imperative mood without conventional-commit prefixes. Please keep the architecture rules in
`AGENTS.md` intact: services stay framework-free, routers stay thin, and pure-logic frontend
modules stay free of React imports.

1. Fork the repository
2. Create your branch (`git checkout -b feat/your-feature`)
3. Commit your changes (`git commit -m "Add your feature"`)
4. Push to the branch (`git push origin feat/your-feature`)
5. Open a Pull Request

## License

Distributed under the MIT License. See `LICENSE` for more information.
