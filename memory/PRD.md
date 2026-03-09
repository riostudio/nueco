# MemoPad - Product Requirements Document

## Overview
MemoPad is a senior-friendly note-taking mobile app built with Expo React Native, FastAPI backend, and MongoDB. Designed for Google Play Store deployment.

## Core Features (MVP)
1. **Note CRUD** - Create, read, update, delete notes with auto-save (2s debounce)
2. **Search** - Real-time search across note titles, content, and tag names (400ms debounce)
3. **Pinned Notes** - Pin/unpin notes; pinned appear in dedicated section at top
4. **Color-coded Tags** - Max 3 tags per note; 6 preset colors (Red, Blue, Green, Orange, Purple, Teal)
5. **Basic Formatting** - Bold (**text**), Italic (*text*), Bullet lists (- item) via toolbar buttons
6. **Voice-to-Text** - Record audio via device mic → OpenAI Whisper transcription → appended to note
7. **Calendar Integration** - Monthly calendar grid, create/edit/delete events, link events to notes
8. **Scheduling** - Senior-friendly date picker (+/- day buttons) and time picker (+/- hour/minute buttons)

## Senior-First Design
- 18pt+ body fonts, 22pt+ primary actions, 34pt headers
- 56px+ touch targets (all buttons, inputs, tab icons)
- WCAG AAA 7:1 contrast ratio (#121212 on #FDFBF7 background)
- Warm color palette: #D84315 primary, #1565C0 secondary
- No hidden gestures; all icons labeled
- Voice input for hands-free note creation

## Architecture
- **Frontend**: Expo SDK 54, expo-router (file-based routing), expo-audio
- **Backend**: FastAPI + Motor (async MongoDB driver)
- **Database**: MongoDB (notes, events collections)
- **Voice**: OpenAI Whisper via emergentintegrations library

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/notes | List all notes (search query param) |
| POST | /api/notes | Create note |
| GET | /api/notes/:id | Get single note |
| PUT | /api/notes/:id | Update note |
| DELETE | /api/notes/:id | Delete note |
| POST | /api/notes/:id/toggle-pin | Toggle pin status |
| GET | /api/events | List events (month/year query params) |
| POST | /api/events | Create event |
| GET | /api/events/:id | Get single event |
| PUT | /api/events/:id | Update event |
| DELETE | /api/events/:id | Delete event |
| POST | /api/transcribe | Voice-to-text transcription |

## Screens
1. **Notes List** (tabs/index) - Search, pinned section, note cards, FAB
2. **Calendar** (tabs/calendar) - Month grid, event list, FAB
3. **Settings** (tabs/settings) - About, features, accessibility info
4. **Note Editor** (editor) - Title, content, format bar, tags, voice, calendar link
5. **Event Editor** (event-editor) - Title, date picker, time pickers, description

## Future Enhancements
- AI-powered recall ("Ask MemoPad")
- Authentication (passkeys, email magic link)
- Device calendar sync (expo-calendar)
- Note sharing & collaboration
- Offline-first with sync
- Premium subscription for advanced features
