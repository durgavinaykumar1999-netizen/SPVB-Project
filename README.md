# SPVB — Smart Private Video Bridge

A WhatsApp-style real-time chat app with end-to-end encryption, group chats, voice/video calls, AI assistant, and QR device linking.

---

## Prerequisites

- Python 3.10+
- Node.js 18+
- pip

---

## Setup (First Time Only)

### 1. Install Python dependencies
```bash
cd backend
pip install -r requirements.txt
```

### 2. Install frontend dependencies
```bash
cd frontend
npm install
```

### 3. Install admin panel dependencies
```bash
cd admin
npm install
```

---

## Running the App (Windows)

Open **3 separate terminals** and run each command:

### Terminal 1 — Backend API (port 1404)
```bash
cd "mas (2)\mas\backend"
uvicorn main:app --host 0.0.0.0 --port 1404 --reload
```

### Terminal 2 — Frontend Chat App (port 1403)
```bash
cd "mas (2)\mas\frontend"
npm run dev
```

### Terminal 3 — Admin Panel (port 1405)
```bash
cd "mas (2)\mas\admin"
npm run dev -- --host 0.0.0.0
```

Then open: **http://localhost:1403**

---

## Running the App (Linux / macOS)

```bash
# Terminal 1 — Backend
cd backend
uvicorn main:app --host 0.0.0.0 --port 1404 --reload

# Terminal 2 — Frontend
cd frontend
npm run dev

# Terminal 3 — Admin
cd admin
npm run dev -- --host 0.0.0.0
```

Or use the provided shell scripts:
```bash
bash start-backend.sh
bash start-frontend.sh
bash start-admin.sh
```

---

## URLs

| Service   | URL                        |
|-----------|----------------------------|
| Chat App  | http://localhost:1403      |
| Backend   | http://localhost:1404      |
| Admin     | http://localhost:1405      |
| API Docs  | http://localhost:1404/docs |

---

## Features

- Real-time messaging via WebSocket
- Group chats with media sharing
- Voice & video calls (WebRTC)
- AI chatbot assistant
- Chat lock with PIN + biometric (fingerprint/face)
- QR code device linking (like WhatsApp Web)
- Status updates (stories)
- Gmail inbox integration
- End-to-end encryption keys
- Messages auto-delete after 24 hours

---

## Environment Variables (optional)

Create `backend/.env`:
```
JWT_SECRET=your_secret_key
JWT_ALGORITHM=HS256
```
