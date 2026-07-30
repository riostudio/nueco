# Nueco — Product Requirements Document

*Reverse-engineered from the current codebase. Reflects what is actually built and shipping, not the roadmap.*

---

## 📋 Executive Summary

**Nueco** is a **privacy-first, offline-first** note-taking and personal
organization app for mobile, built with **Expo/React Native** on the
frontend and **FastAPI + MongoDB** on the backend, deployed on **Railway**.

It is aimed at people who want one fast, always-available place to **capture
thoughts, voice memos, and reminders** — without trusting a server to read
their notes. Every note is **end-to-end encrypted** on-device before it ever
reaches Nueco's servers.

Beyond note-taking, Nueco doubles as a **lightweight personal
scheduler** (recurring reminders, two-way native calendar sync) and a
**daily briefing tool** — a "Daily Brew" card that greets the user each
morning with weather, today's events, and a few chosen news headlines, right
on top of their notes list.

The app is designed to **never block on the network**: notes save locally
instantly and sync in the background, so it works the same whether the user
has a full signal or none at all.

---

## 🧩 Feature Inventory

| Feature | User Benefit | Technical Implementation File |
|---|---|---|
| Email/password signup & login | Create a private account in seconds | `frontend/app/signup.tsx` |
| End-to-end encrypted notes | Only the user can read their notes — not even Nueco's own servers | `frontend/src/crypto/noteCrypto.ts` |
| Recovery code | Resetting your password never permanently locks you out of encrypted notes | `frontend/app/recovery-code.tsx`, `recover-key.tsx` |
| In-app password change | Change your password without losing access to your notes | `frontend/app/change-password.tsx` |
| Rich text editor | Format notes with **bold**, *italic*, bullet lists, and undo/redo | `frontend/app/editor.tsx` |
| Voice dictation | Speak a note instead of typing it | `frontend/app/editor.tsx` (recording), `backend/textai/service.py` (transcription) |
| Language-accurate transcription | A dictated note transcribes in the language actually spoken, not a guess | `backend/textai/service.py`, `frontend/src/api.ts` |
| AI note cleanup | One tap to **organize** a rambling dictation or **summarize** it down | `backend/textai/service.py` |
| Smart note formatting (recipe / checklist / meeting notes) | Auto-detects note type and restructures it cleanly | `backend/textai/service.py` (`smart_format`) |
| Photo & file attachments | Attach pictures or documents (PDF, Word, Excel…) to any note | `backend/attachments/service.py` |
| Note ↔ event linking | Keep a note (e.g. meeting notes) tied to its date and time | `frontend/app/event-editor.tsx` |
| Recurring reminders | Reminders repeat daily, weekly, monthly, or yearly, with an end date | `frontend/app/event-editor.tsx` |
| Two-way device calendar sync | Reminders also show up in the phone's own calendar app, and vice versa | `frontend/src/calendarSync.ts` |
| Local & push notifications | Get reminded even if the app is closed | `frontend/src/notifications.ts` |
| Offline-first sync engine | The whole app works with **zero signal**, and catches up once reconnected | `frontend/src/offlineSync.ts` |
| Share-to-app capture | Send a link, photo, or video from another app straight into a note | `frontend/app/share-target.tsx` |
| Social link preview cards | A shared Instagram/TikTok/YouTube/Reddit link becomes a real preview card, not a bare URL | `frontend/src/share/unfurl.ts` |
| Canva design import | Drop a Canva design into a note without exporting and re-uploading it | `frontend/app/canva-settings.tsx` |
| Daily Brew briefing card | One glance at weather, today's events, and the news — right above the notes list | `frontend/src/components/DailyBrewCard.tsx` |
| Curated & custom news feeds | Follow up to 3 news sources (curated, topic-searched, or your own RSS link) | `frontend/app/news-source-settings.tsx`, `backend/dailybrew/service.py` |
| Daily inspirational verse | An optional daily Bible verse alongside the morning briefing | `frontend/src/dailyBrew/verses.ts` |
| Post-note feedback prompt | A light thumbs-up/down check-in after your 5th note — never interrupts mid-edit | `frontend/src/feedbackToast.ts` |
| Opt-in usage analytics | The user decides, GDPR-style, whether anonymous usage data is collected | `frontend/app/analytics-consent.tsx` |
| Data export & account deletion | Export your data or permanently delete your account, on your terms | `frontend/app/settings.tsx` |

---

## 🚶 User Journeys

### Onboarding
- User lands on **Welcome**, taps **Get Started**.
- Signs up with name, email, and password.
- Verifies email via a link.
- Logs in for the first time.
- App **silently generates an encryption key** for their notes.
- **Recovery code** is shown once — user must confirm it's saved.
- One-time **analytics consent** prompt (accept or decline).
- One-time **Daily Brew intro** preview, if the feature is enabled.
- Picks up to **3 news sources** for the Daily Brew card.
- Lands on **My Notes**, ready to go.

### Core action: capture a note by voice
- Taps **New Note**.
- Taps the **mic**, speaks naturally.
- Speech **transcribes automatically** in the correct language.
- Chooses **Organize**, **Summarize**, or **Keep as is**.
- Note **saves locally instantly** — no waiting on the network.
- Syncs to the server quietly, in the background.

### Core action: set a reminder
- Opens a note, or the **Events** tab.
- Taps **Schedule** / **Add Reminder**.
- Picks a date, time, and optional recurrence.
- Optionally adds it to the **device's native calendar**.
- Gets a **push or local notification** when it's due.

### Core action: recover access after a forgotten password
- Taps **Forgot password**, gets a reset link by email.
- Sets a new password.
- Next login, the app detects the old encryption key **no longer matches**.
- User enters their saved **recovery code**.
- Notes unlock again — nothing is lost.

### Core action: share content from another app
- User shares a link, photo, or video from Instagram, TikTok, Reddit, etc.
- Nueco asks: **new note**, or **append to an existing one**?
- The shared link **unfurls** into a real preview card — thumbnail and title, not a raw URL.

### Daily habit: the morning briefing
- Opens **My Notes**.
- **Daily Brew card** shows today's weather, events, and 3 news headlines (plus an optional verse).
- Taps **Done for today** to dismiss it until tomorrow — or pins it permanently from Settings.

---

*This document describes current, shipped behavior only. Features discussed but not yet built (e.g. password-protected individual notes) are intentionally omitted.*
