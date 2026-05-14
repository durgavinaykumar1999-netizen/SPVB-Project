# SPVB — Smart Private Video Bridge
### Complete Feature Reference & Project Structure

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [Directory Structure](#3-directory-structure)
4. [Setup & Running](#4-setup--running)
5. [Architecture](#5-architecture)
6. [Completed Features](#6-completed-features)
7. [Backend API Reference](#7-backend-api-reference)
8. [Database Schema](#8-database-schema)
9. [Frontend Pages & Components](#9-frontend-pages--components)
10. [Real-Time System](#10-real-time-system)
11. [Security Model](#11-security-model)
12. [Admin Panel](#12-admin-panel)

---

## 1. Project Overview

SPVB is a WhatsApp-style private messaging application with end-to-end encryption, real-time messaging, group chats, voice/video calls, AI smart replies, QR device linking, and status stories.

| Service      | URL                        | Port |
|--------------|----------------------------|------|
| Chat App     | http://localhost:1403      | 1403 |
| Backend API  | http://localhost:1404      | 1404 |
| Admin Panel  | http://localhost:1405      | 1405 |
| API Docs     | http://localhost:1404/docs | 1404 |

---

## 2. Tech Stack

### Backend
| Component       | Technology                            |
|-----------------|---------------------------------------|
| Framework       | FastAPI (Python 3.10+)                |
| Server          | Uvicorn (ASGI)                        |
| Auth            | JWT via python-jose (HS256)           |
| Messages DB     | SQLite (`data/messages.db`)           |
| App Data        | JSON flat-file (`data/database.json`) |
| Real-time       | WebSocket (native FastAPI)            |
| File Storage    | Local disk (`data/uploads/`)          |
| AI Feature      | Smart reply endpoint                  |
| Env Config      | python-dotenv                         |

### Frontend (Chat App)
| Component       | Technology                  |
|-----------------|-----------------------------|
| Framework       | React 18.2                  |
| Bundler         | Vite 5                      |
| Routing         | React Router DOM v7         |
| QR Generation   | qrcode npm package          |
| Calls           | WebRTC (browser native)     |
| Auth Storage    | localStorage (JWT token)    |
| Styling         | Inline styles (no CSS lib)  |

### Admin Panel
| Component   | Technology           |
|-------------|----------------------|
| Framework   | React 18.2           |
| Bundler     | Vite 5               |
| Routing     | React Router DOM v6  |

---

## 3. Directory Structure

```
mas/
├── README.md                        # Quick-start run commands
├── FEATURES.md                      # This file — full feature reference
│
├── backend/
│   ├── main.py                      # FastAPI app — all routes & logic (~1860 lines)
│   ├── .env                         # JWT_SECRET, JWT_ALGORITHM
│   ├── test_all.py                  # Integration tests
│   ├── test_auth.py                 # Auth flow tests
│   ├── test_500.py                  # Error handling tests
│   └── test_login.py                # Login tests
│
├── frontend/
│   ├── index.html
│   ├── vite.config.js               # Proxy: /api → localhost:1404, /ws → localhost:1404
│   ├── package.json
│   ├── public/
│   │   ├── splash.mp4               # Splash screen video
│   │   └── spvb-logo.jpeg
│   └── src/
│       ├── App.jsx                  # Router, auth guard, splash gate
│       ├── main.jsx                 # React entry point
│       ├── index.css
│       ├── pages/
│       │   ├── Dashboard.jsx        # Main chat UI (~4450 lines)
│       │   ├── Login.jsx            # Email/password + Google OAuth login
│       │   ├── Register.jsx         # Registration
│       │   ├── ForgotPassword.jsx   # Password recovery
│       │   ├── SetPassword.jsx      # Set new password
│       │   └── LinkDevice.jsx       # QR device link landing page
│       ├── components/
│       │   ├── SplashScreen.jsx     # Animated intro with speed-adaptive duration
│       │   ├── CallScreen.jsx       # WebRTC voice/video call UI
│       │   ├── IncomingCallBanner.jsx  # Incoming call overlay
│       │   ├── StatusViewer.jsx     # Story/status viewer (24h TTL)
│       │   └── AddContactModal.jsx  # Add contact by phone/email
│       └── utils/
│           └── googleTokens.js      # Google OAuth + Gmail inbox
│
├── admin/
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   ├── public/
│   │   └── spvb-logo.jpeg
│   └── src/
│       ├── App.jsx                  # Admin dashboard (~680 lines)
│       ├── main.jsx
│       └── index.css
│
├── data/                            # Runtime data — gitignored
│   ├── database.json                # Users, groups, statuses, QR tokens, etc.
│   ├── database.json.bak            # Auto-backup of database.json
│   ├── messages.db                  # SQLite — all DM messages
│   ├── uploads/                     # User-uploaded media files
│   └── assets/                     # App assets (logo, splash video)
│
└── Shell scripts (Linux/macOS)
    ├── start-backend.sh
    ├── start-frontend.sh
    └── start-admin.sh
```

---

## 4. Setup & Running

### Prerequisites
- Python 3.10+
- Node.js 18+
- pip

### First-Time Setup

```bash
# Backend
cd backend
pip install fastapi uvicorn python-jose python-multipart python-dotenv pydantic[email] email-validator

# Frontend
cd frontend
npm install

# Admin
cd admin
npm install
```

### Running (Windows — 3 terminals)

```bash
# Terminal 1 — Backend (port 1404)
cd "mas (2)\mas\backend"
uvicorn main:app --host 0.0.0.0 --port 1404 --reload

# Terminal 2 — Frontend (port 1403)
cd "mas (2)\mas\frontend"
npm run dev

# Terminal 3 — Admin (port 1405)
cd "mas (2)\mas\admin"
npm run dev -- --host 0.0.0.0
```

### Running (Linux / macOS)

```bash
bash start-backend.sh
bash start-frontend.sh
bash start-admin.sh
```

### Environment Variables (`backend/.env`)

```env
JWT_SECRET=your_secret_key_here
JWT_ALGORITHM=HS256
```

---

## 5. Architecture

### Data Flow

```
Browser (React)
    │
    ├─── HTTP /api/*  ──► Vite Proxy (strips /api) ──► FastAPI :1404
    │
    └─── WS  /ws/*   ──► Vite Proxy               ──► FastAPI :1404
                                                         │
                                                    ┌────┴────┐
                                                    │  JSON   │  ← Users, Groups,
                                                    │  File   │    Statuses, QR tokens
                                                    └─────────┘
                                                    ┌─────────┐
                                                    │ SQLite  │  ← DM Messages
                                                    │messages │    (mssg table)
                                                    └─────────┘
                                                    ┌─────────┐
                                                    │ uploads/│  ← Media files
                                                    └─────────┘
```

### WebSocket Architecture

```
User A ──WS──► WSManager.connections["A"]
                     │
                     ├── chat_message      → push to User B
                     ├── read_receipt      → push to User A (sender)
                     ├── call_offer        → push to callee
                     ├── call_answer       → push to caller
                     ├── call_end          → push to both
                     ├── ice_candidate     → push to peer
                     ├── qr_link_request   → push to QR owner
                     └── qr_link_result    → push to scanning device
```

### Message Polling Strategy

```
Chat open
    │
    ├── Full load once   → GET /messages/conversation/{id}
    │   (stable merge — reuses object references, no blink)
    │
    └── Incremental poll (every 4s) → GET /messages/conversation/{id}?since_id={lastId}
        ├── Empty response → NO state update, NO re-render
        └── New messages   → APPEND only (no existing messages touched)
```

---

## 6. Completed Features

### 6.1 Authentication

| Feature | Details |
|---------|---------|
| Email + Password Login | SHA-256 hashed passwords, JWT issued on success |
| Google OAuth Login | Google ID token verified, account auto-created |
| JWT Auth Guard | All protected routes use `Authorization: Bearer <token>` |
| Token Expiry | 7-day JWT expiry |
| Forgot Password | Reset link flow via email token |
| Set Password | For social-login users who want a password |
| Session Security | One active session enforced (QR linking for multi-device) |
| Logout | Clears localStorage, marks status offline, locks all chats |

---

### 6.2 Real-Time Messaging

| Feature | Details |
|---------|---------|
| WebSocket connection | Persistent per-user WS on `/ws/{user_id}` |
| Send/Receive DMs | Instant delivery via WS push to recipient |
| Message persistence | SQLite `mssg` table — survives server restart |
| 24-hour auto-delete | `expires_at` field; expired rows deleted on cleanup |
| Optimistic send | Message appears instantly with `pending` state, confirmed on server response |
| Read receipts | Blue ticks — WS `read_receipt` event updates sender's UI |
| Reply-to / quote | `reply_to` field stored and shown in UI thread |
| Unread count badge | Per-contact unread count from `GET /messages/recent` |
| Blink-free updates | Incremental poll with `?since_id=N` — only new messages appended |
| Wake-up sync | `visibilitychange` + `window.online` + `focus` events trigger sync on return from background |
| Reconnect sync | WS `onopen` triggers message re-fetch to catch messages missed during disconnect |

---

### 6.3 Media Sharing

| Feature | Details |
|---------|---------|
| Image send | JPG, JPEG, PNG, GIF, WEBP |
| Video send | MP4, MOV, MKV |
| Audio messages | WEBM, OGG, MP3, M4A, WAV, AAC (voice notes included) |
| Document send | PDF, DOC, DOCX, TXT, XLSX, XLS, PPTX, PPT, ZIP, RAR, CSV |
| Voice recording | In-app mic recording → WEBM → uploaded as audio message |
| Camera capture | Direct camera → image message |
| Media preview | Inline preview in chat bubble (image/video/audio player) |
| File storage | Saved to `data/uploads/`, served as static files |
| Orphan cleanup | Files not referenced in DB and older than 24h are purged |

---

### 6.4 Group Chats

| Feature | Details |
|---------|---------|
| Create group | Name, icon (emoji or uploaded image), initial members |
| Group messaging | Real-time via WS broadcast to all members |
| Group media | Images, videos, audio, documents in group chats |
| Add/remove members | Admin-only; member list shown in group info |
| Group settings | Edit name and icon |
| Member details | Avatars, display names shown in member list |
| Leave group | User can leave; admin can remove others |

---

### 6.5 Voice & Video Calls

| Feature | Details |
|---------|---------|
| 1-on-1 voice call | WebRTC audio-only, no server relay needed |
| 1-on-1 video call | WebRTC with local + remote video feeds |
| Incoming call banner | Toast at top of screen with accept/reject buttons |
| Call screen UI | Full-screen with mute, camera toggle, end-call |
| Call signaling | WS events: `call_offer`, `call_answer`, `call_end`, `ice_candidate` |
| Call logs | Duration, direction (in/out), status (answered/missed) stored in DB |
| Call history tab | Displayed in Calls tab with timestamps |

---

### 6.6 Status / Stories

| Feature | Details |
|---------|---------|
| Post text status | Colored background, custom text |
| Post video status | Upload MP4/MOV video story |
| 24-hour TTL | Statuses auto-expire after 24 hours |
| Story viewer | Full-screen viewer with progress bar (StatusViewer component) |
| View tracking | `POST /statuses/{id}/view` — viewers list stored |
| Reactions | Emoji reaction on stories, stored in DB |
| My status | Shown separately in status tab |

---

### 6.7 Chat Lock (Security)

| Feature | Details |
|---------|---------|
| Per-chat lock | Each conversation can be locked independently |
| PIN entry | iPhone-style 4-dot indicator + 3×4 numpad overlay |
| Blurred background | `backdropFilter: blur(18px)` — chat content hidden until unlocked |
| PIN storage | DJB2-variant hash stored in `localStorage` per user |
| Biometric unlock | WebAuthn `navigator.credentials.get` with `userVerification: required` |
| Face ID / Touch ID | Works with any platform authenticator (Face ID, Touch ID, fingerprint) |
| Auto-lock on switch | Switching to another chat re-locks the previous one |
| Logout locks all | `chatUnlocked` Set cleared on logout; no mid-attack persistence |
| Wrong PIN shake | 600ms shake animation on incorrect entry, digits reset |

---

### 6.8 QR Device Linking

| Feature | Details |
|---------|---------|
| Generate QR | Primary device: Settings → Linked Devices → Link Device |
| QR content | `{origin}/link-device?token={token}` |
| Token TTL | 10-minute one-time token |
| Scan flow | New device opens QR URL → auto-scans token (no login needed) |
| Approval toast | Primary device receives bottom-right toast: Approve / Deny |
| WS notification | `qr_link_request` event pushed to QR owner in real-time |
| On approve | JWT issued for new device via WS `qr_link_result` |
| No auth on scan | Scan endpoint requires NO JWT — token itself is authentication |
| Linked devices list | Settings → Linked Devices shows all linked devices |
| Remove device | Delete any linked device from the list |

---

### 6.9 Contacts

| Feature | Details |
|---------|---------|
| Contact list | All SPVB users (auto-loaded) |
| Add by phone | Search and add by phone number |
| Save contacts | Star/save specific contacts to saved list |
| Block/Unblock | Block contacts — blocked users cannot message you |
| Nicknames | Set custom display names per contact |
| Phone sync | `POST /contacts/sync-phones` — match device contacts to SPVB users |
| Online indicator | Green dot — live status from `GET /users/online` (polled every 10s) |
| Last seen | Shown in chat header when user is offline |

---

### 6.10 AI Assistant (Bot)

| Feature | Details |
|---------|---------|
| AI chat | Built-in bot contact for conversational AI |
| Smart reply | `POST /smart-reply` — suggests replies for incoming messages |
| Local processing | Bot responses processed in backend |

---

### 6.11 Gmail Integration

| Feature | Details |
|---------|---------|
| Gmail inbox | View recent Gmail messages inside the app |
| OAuth token | `utils/googleTokens.js` — manages Google OAuth refresh tokens |
| In-app viewer | Email list view from authenticated Gmail API |

---

### 6.12 User Profile

| Feature | Details |
|---------|---------|
| Display name | Editable name shown to contacts |
| Username | Unique identifier |
| Phone number | Optional, used for contact sync |
| Avatar | Upload profile photo |
| Cover photo | Upload profile cover/banner |
| About / Bio | Short description field |
| Public key | E2E encryption key pair, public key stored in DB |

---

### 6.13 End-to-End Encryption

| Feature | Details |
|---------|---------|
| Key generation | Each user generates a keypair on register |
| Public key storage | `PUT /users/me/pubkey` stores server-side |
| Key retrieval | `GET /users/{id}/pubkey` — fetch contact's public key |
| Encrypted flag | `encrypted: true` on messages indicates E2E encrypted content |

---

### 6.14 Splash Screen

| Feature | Details |
|---------|---------|
| Video intro | Plays `splash.mp4` from `/public` |
| Speed-adaptive | Fast connection: 3s max, slow: 12s max |
| Progress bar | Animated progress indicator |
| Logo reveal | Animated SPVB logo with fade-in |
| Auto-skip | Calls `onDone()` callback on finish or timeout |

---

### 6.15 Offline / Background Resilience

| Feature | Details |
|---------|---------|
| `visibilitychange` | Screen-on triggers immediate sync + retry at 1.5s and 4s |
| `window.online` | Network reconnect triggers full message sync |
| `window.focus` | App foreground on mobile triggers sync |
| WS reconnect | `onopen` re-fetches missed messages automatically |
| Incremental poll | `?since_id=N` — only new messages fetched, no blink |
| localStorage cache | Messages cached per-user, loaded immediately on app start |

---

### 6.16 App Version Auto-Update

| Feature | Details |
|---------|---------|
| ETag check | `HEAD /` every 5 minutes — if ETag changes, auto-reload |
| Seamless update | User gets latest version without manual refresh |

---

## 7. Backend API Reference

### Authentication

| Method | Endpoint              | Auth | Description                        |
|--------|-----------------------|------|------------------------------------|
| POST   | `/auth/register`      | No   | Create account (email + password)  |
| POST   | `/auth/login`         | No   | Login, returns JWT                 |
| POST   | `/auth/google`        | No   | Google OAuth login/register        |
| GET    | `/auth/me`            | Yes  | Get current user profile           |
| PUT    | `/auth/me`            | Yes  | Update profile (name, bio, avatar) |
| POST   | `/auth/set-password`  | Yes  | Set password for OAuth accounts    |
| POST   | `/auth/forgot-password` | No | Request password reset token      |
| POST   | `/auth/reset-password`| No   | Reset password with token          |

### Users

| Method | Endpoint                  | Auth  | Description                 |
|--------|---------------------------|-------|-----------------------------|
| GET    | `/users`                  | Yes   | List all users              |
| GET    | `/users/{id}`             | Yes   | Get user by ID              |
| PUT    | `/users/{id}`             | Admin | Update user (admin)         |
| DELETE | `/users/{id}`             | Admin | Delete user (admin)         |
| POST   | `/users/me/status`        | Yes   | Set online/offline status   |
| GET    | `/users/online`           | Yes   | Get map of online user IDs  |
| GET    | `/users/find-by-phone`    | Yes   | Find user by phone number   |
| PUT    | `/users/me/pubkey`        | Yes   | Store E2E public key        |
| GET    | `/users/{id}/pubkey`      | Yes   | Get user's public key       |

### Messages (DM)

| Method | Endpoint                          | Auth | Description                               |
|--------|-----------------------------------|------|-------------------------------------------|
| POST   | `/messages`                       | Yes  | Send text message                         |
| GET    | `/messages/recent`                | Yes  | Recent conversations with last message    |
| GET    | `/messages/conversation/{id}`     | Yes  | Full conversation history (supports `?since_id=N`) |
| GET    | `/messages/{room}`                | Yes  | Messages by room ID                       |
| PUT    | `/messages/read/{contact_id}`     | Yes  | Mark messages as read (triggers WS receipt) |
| POST   | `/messages/media`                 | Yes  | Send media message (multipart/form-data)  |
| POST   | `/upload`                         | Yes  | Upload file, returns URL                  |

### Contacts

| Method | Endpoint                          | Auth | Description            |
|--------|-----------------------------------|------|------------------------|
| GET    | `/contacts`                       | Yes  | All SPVB users         |
| GET    | `/contacts/saved`                 | Yes  | Saved contacts list    |
| POST   | `/contacts/{id}/save`             | Yes  | Save a contact         |
| DELETE | `/contacts/{id}/save`             | Yes  | Unsave a contact       |
| GET    | `/contacts/blocked`               | Yes  | Blocked contacts       |
| POST   | `/contacts/{id}/block`            | Yes  | Block a user           |
| DELETE | `/contacts/{id}/block`            | Yes  | Unblock a user         |
| PUT    | `/contacts/{id}/nickname`         | Yes  | Set nickname           |
| POST   | `/contacts/sync-phones`           | Yes  | Match phone numbers    |

### Groups

| Method | Endpoint                          | Auth | Description                  |
|--------|-----------------------------------|------|------------------------------|
| POST   | `/groups`                         | Yes  | Create group                 |
| GET    | `/groups`                         | Yes  | My groups list               |
| GET    | `/groups/{id}/messages`           | Yes  | Group message history        |
| POST   | `/groups/{id}/messages`           | Yes  | Send group text message      |
| POST   | `/groups/{id}/media`              | Yes  | Send group media message     |
| PUT    | `/groups/{id}`                    | Yes  | Edit group name/icon         |
| POST   | `/groups/{id}/members`            | Yes  | Add member                   |
| DELETE | `/groups/{id}/members/{user_id}`  | Yes  | Remove member                |

### Statuses / Stories

| Method | Endpoint                      | Auth | Description              |
|--------|-------------------------------|------|--------------------------|
| POST   | `/statuses`                   | Yes  | Post status/story        |
| GET    | `/statuses`                   | Yes  | All active statuses      |
| DELETE | `/statuses/{id}`              | Yes  | Delete own status        |
| POST   | `/statuses/{id}/view`         | Yes  | Record view              |
| POST   | `/statuses/{id}/react`        | Yes  | Add emoji reaction       |

### Calls

| Method | Endpoint      | Auth | Description              |
|--------|---------------|------|--------------------------|
| POST   | `/call-logs`  | Yes  | Save call log entry      |
| GET    | `/call-logs`  | Yes  | My call history          |

### QR Device Linking

| Method | Endpoint                      | Auth       | Description                               |
|--------|-------------------------------|------------|-------------------------------------------|
| POST   | `/devices/qr/generate`        | Yes        | Generate QR token (10-min TTL)            |
| GET    | `/devices/qr/{token}/status`  | Yes        | Poll token status                         |
| POST   | `/devices/qr/{token}/scan`    | **No auth**| New device scans (token = authentication) |
| POST   | `/devices/qr/{token}/approve` | Yes        | Approve → issue JWT for new device        |
| POST   | `/devices/qr/{token}/reject`  | Yes        | Reject linking request                    |
| GET    | `/devices/qr/{token}/await`   | No         | Long-poll (30s) for decision              |
| GET    | `/devices`                    | Yes        | List linked devices                       |
| DELETE | `/devices/{device_id}`        | Yes        | Remove linked device                      |

### WebSockets

| Endpoint              | Description                                    |
|-----------------------|------------------------------------------------|
| `/ws/{user_id}`       | Main real-time channel (messages, calls, etc.) |
| `/ws/qr/{token}`      | QR link real-time approval channel             |

### Admin

| Method | Endpoint         | Auth | Description                           |
|--------|------------------|------|---------------------------------------|
| GET    | `/admin/stats`   | Yes  | Users, messages, logins, active stats |

### AI

| Method | Endpoint        | Auth | Description            |
|--------|-----------------|------|------------------------|
| POST   | `/smart-reply`  | Yes  | AI-suggested reply     |

---

## 8. Database Schema

### JSON Store (`data/database.json`)

```
users[]           — id, username, email, phone, display_name, password_hash,
                    avatar_url, cover_url, about, pubkey, created_at
groups[]          — id, name, icon, created_by, members[], created_at
group_messages[]  — id, group_id, from_user_id, content, media_url, created_at, expires_at
statuses[]        — id, user_id, text, bg_color, video_url, viewers[], reactions{}, created_at, expires_at
call_logs[]       — id, caller_id, callee_id, call_type, direction, status, duration, created_at
login_events[]    — user_id, method, timestamp
password_reset_tokens{}  — token → {user_id, expires_at}
saved_contacts{}  — user_id → [contact_id, ...]
nicknames{}       — user_id → {contact_id → nickname}
blocked{}         — user_id → [blocked_id, ...]
qr_tokens{}       — token → {user_id, status, expires_at, scanner_device, scanner_user_agent}
linked_devices[]  — id, user_id, device_name, user_agent, linked_at
active_sessions{} — user_id → session info
user_status{}     — user_id → {status, last_seen}
```

### SQLite (`data/messages.db`)

#### Table: `mssg`

```sql
CREATE TABLE mssg (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sender        TEXT,          -- from_username (display name)
    message       TEXT,          -- message content
    timestamp     TEXT,          -- ISO timestamp (created_at)
    room          TEXT,          -- e.g. "dm_1_2" (dm_{min_id}_{max_id})
    from_user_id  INTEGER,
    recipient_id  INTEGER,
    encrypted     INTEGER DEFAULT 0,   -- 0/1 boolean
    is_read       INTEGER DEFAULT 0,   -- 0/1 boolean
    reply_to      INTEGER,             -- id of quoted message
    media_url     TEXT,                -- /uploads/filename.ext
    media_type    TEXT,                -- image|video|audio|document
    file_name     TEXT,                -- original filename
    expires_at    TEXT                 -- ISO timestamp (24h TTL)
);

CREATE INDEX idx_mssg_room    ON mssg(room);
CREATE INDEX idx_mssg_expires ON mssg(expires_at);
```

**Room naming convention:**
```
Direct message between user 3 and user 7 → room = "dm_3_7"  (min first)
```

---

## 9. Frontend Pages & Components

### Pages

#### `Login.jsx`
- Email/password login form
- Google OAuth button
- Link to Register and Forgot Password
- On success: stores JWT + user in localStorage, calls `onLogin()`

#### `Register.jsx`
- Username, email, password, phone fields
- Google OAuth register path
- Validates email format and password length

#### `ForgotPassword.jsx`
- Email entry → sends reset token
- Token entry + new password form
- Redirect to login on success

#### `SetPassword.jsx`
- For users who signed up via Google and want a password
- Requires current auth token

#### `Dashboard.jsx` (main app — ~4450 lines)
Key state:
```
contacts, groups             — sidebar lists
activeId                     — number=DM, 'g_{id}'=group, 'bot'=AI, 'gmail'=inbox
liveMessages{}               — per-contactId message arrays (localStorage-persisted)
recentConversations{}        — last message + unread count per contact
lockedChats (Set)            — chat IDs with lock enabled
chatUnlocked (Set)           — in-memory only, cleared on logout
chatPins{}                   — hashed PINs per chat (localStorage)
qrLinkRequest                — pending device link approval
linkedDevices[]              — linked device list
onlineMap{}                  — {userId: true} for green dots
```

Key refs:
```
wsRef            — WebSocket connection
wsHandlerRef     — WS message handler (avoids stale closure)
fetchMsgsRef     — Active DM fetch function (called on reconnect/wake)
fetchRecentRef   — Recent conversations fetch function
pollRef          — setInterval handle for incremental message poll
lastMsgIdRef{}   — Per-contact last confirmed server message ID
activeIdRef      — activeId mirror for WS handler closure
```

#### `LinkDevice.jsx`
- No auth required
- Reads `?token=` from URL
- Calls `/api/devices/qr/{token}/scan` with device name
- Long-polls `/api/devices/qr/{token}/await` every 2s
- On approval: stores JWT, fetches user info, redirects to dashboard
- States: idle → scanning → waiting → approved/rejected/error

### Components

#### `SplashScreen.jsx`
- Plays `splash.mp4` video
- Falls back to animated logo if video unavailable
- Speed-adaptive: 3s on fast connection, up to 12s on slow
- Progress bar tracks video/animation progress

#### `CallScreen.jsx`
- Full-screen WebRTC call UI
- Local video (small, corner) + remote video (full-screen)
- Controls: mute, camera on/off, end call
- WebRTC ICE candidate exchange via WS
- Handles `call_offer`, `call_answer`, `ice_candidate` WS events

#### `IncomingCallBanner.jsx`
- Appears at top of screen on incoming call
- Accept (green) / Reject (red) buttons
- Shows caller name and call type (voice/video)

#### `StatusViewer.jsx`
- Full-screen story viewer (WhatsApp-style)
- Horizontal story progress bars
- Auto-advances through stories
- Tap left/right to navigate
- Shows viewer count, reactions
- Post reaction from viewer

#### `AddContactModal.jsx`
- Search by phone number or email
- Shows matching SPVB users
- One-tap add to contacts

---

## 10. Real-Time System

### WebSocket Event Types

#### Server → Client (pushed by backend)

| Event Type          | Payload                                          | Trigger                         |
|---------------------|--------------------------------------------------|---------------------------------|
| `chat_message`      | `{message: {id, content, room, from_user_id, ...}}` | New DM received              |
| `read_receipt`      | `{by: userId, message_ids: [...]}`               | Recipient opened chat           |
| `call_offer`        | `{from, callType, sdp}`                          | Incoming call                   |
| `call_answer`       | `{from, sdp}`                                    | Call accepted                   |
| `call_end`          | `{from}`                                         | Call ended/rejected             |
| `ice_candidate`     | `{from, candidate}`                              | WebRTC ICE exchange             |
| `group_message`     | `{message: {...}}`                               | New group message               |
| `qr_link_request`   | `{token, device_name, user_agent}`               | New device scanned QR           |
| `qr_link_result`    | `{status: 'approved', jwt: '...'}`               | QR approval decision            |

#### Client → Server (via HTTP, triggers WS push)

| Action              | HTTP Endpoint            | WS Effect                        |
|---------------------|--------------------------|----------------------------------|
| Send DM             | `POST /messages`         | Pushes `chat_message` to recipient |
| Read messages       | `PUT /messages/read/{id}`| Pushes `read_receipt` to sender  |
| Send media          | `POST /messages/media`   | Pushes `chat_message` to recipient |
| Approve QR          | `POST /devices/qr/{t}/approve` | Pushes `qr_link_result` to scanner |
| Reject QR           | `POST /devices/qr/{t}/reject`  | Pushes `qr_link_result` to scanner |

### Message Sync on Reconnect / Wake

```
Screen turns ON (visibilitychange: visible)
  │
  ├── Immediate:  fetchMsgsRef.current?.()  + fetchRecentRef.current?.()
  ├── +1.5s:      retry (in case network radio wasn't ready)
  └── +4.0s:      retry (for slow mobile radio wake)

Network comes back (window.online)
  └── syncAll() → fetchRecent + fetchMsgs

App gets focus (window.focus)
  └── syncAll() → fetchRecent + fetchMsgs

WebSocket reconnects (onopen)
  └── fetchMsgsRef.current?.() + fetchRecentRef.current?.()
```

---

## 11. Security Model

### Authentication
- Passwords hashed with SHA-256
- JWTs signed with `JWT_SECRET` (HS256)
- 7-day token expiry
- `Authorization: Bearer <token>` header required on all protected routes

### Chat Lock
- PIN never stored in plaintext — DJB2-variant hash in localStorage
- Biometric: WebAuthn `userVerification: required` — OS-level verification
- Lock state (`chatUnlocked`) lives only in React memory — never persisted to localStorage
- Logout explicitly clears `chatUnlocked` Set

### QR Device Linking
- QR token is a 32-byte cryptographically random secret (`secrets.token_urlsafe(32)`)
- 10-minute TTL — expired tokens rejected with HTTP 410
- Primary device must be online and actively approve
- JWT for new device is never transmitted over HTTP — only via encrypted WS connection
- Scan endpoint requires NO prior auth — token itself IS the authentication credential

### Message Security
- `encrypted: true` flag indicates client-side E2E encrypted content
- Public keys stored per user for key exchange
- Media files served from `/uploads/` — not guessable (include user ID + timestamp in filename)
- Orphan media files (no DB reference, >24h old) are purged automatically

---

## 12. Admin Panel

### Access
URL: `http://localhost:1405`
Uses same JWT auth as main app (must be a registered user).

### Capabilities

| Feature              | Description                                    |
|----------------------|------------------------------------------------|
| Dashboard stats      | Total users, messages, calls, active sessions  |
| User list            | All registered users with details              |
| Edit user            | Change display name, email, phone (admin only) |
| Delete user          | Hard delete user and their data                |
| Login events         | Recent login history (last 50 events)          |
| Weekly active users  | Users active in the last 7 days                |
| Online users         | Currently online users count                  |
| Email vs Google      | Login method breakdown                         |

---

## Changelog (Session History)

| Date       | Change                                                              |
|------------|---------------------------------------------------------------------|
| 2026-05-13 | Added SQLite `mssg` table for DM message storage                    |
| 2026-05-13 | `GET /messages/conversation/{id}?since_id=N` incremental fetch      |
| 2026-05-13 | Frontend: blink-free polling — append-only, no full-list replace    |
| 2026-05-13 | Wake/offline resilience: `window.online`, `visibilitychange` retry  |
| 2026-05-13 | Chat lock: blur overlay, PIN numpad, WebAuthn biometric             |
| 2026-05-13 | QR device linking: generate → scan → approve → JWT flow             |
| 2026-05-13 | Fixed QR scan auth: removed JWT requirement from scan endpoint      |
| 2026-05-13 | `LinkDevice.jsx` — landing page for QR link on new device           |
| 2026-05-13 | Auto-lock on chat switch; logout clears all unlock state            |
| 2026-05-13 | README.md with setup and run commands                               |
