# SPVB Bug Tracker

**Last updated:** 2026-07-02 (after git pull — includes scheduled messages code)  
**Total open:** 11 bugs (8 original + 3 new from scheduled messages feature)

Fix in order — top is most critical.

---

## BUG 1 — Google OAuth Account Takeover 🔴 CRITICAL

**File:** `backend/main.py` · **Line:** 2076  
**Status:** ☐ Open

### What's wrong
`/api/auth/google` finds an existing email/password account and issues a JWT with **zero password check**. Anyone with a Google account matching a user's email can log in as that user.

### How to reproduce
1. Register normally with `email@gmail.com` + password
2. POST to `/api/auth/google` with a valid Google token for `email@gmail.com`
3. Get full session — no password asked

### Fix
```python
# In /api/auth/google endpoint, after finding existing user (~line 2076):
if user and user.get("password"):
    raise HTTPException(
        status_code=403,
        detail="This email is registered with a password. Please log in with your password."
    )
```

---

## BUG 2 — `from_user` NameError on WebSocket Disconnect 🔴 CRITICAL

**File:** `backend/main.py` · **Lines:** 1739, 1745  
**Status:** ☐ Open

### What's wrong
Both disconnect handlers call `mdb_set_status(user_id, from_user[0], from_user[1], "offline")` but `from_user` is **never defined** anywhere in `ws_endpoint`. Every disconnect silently throws `NameError` → user is never marked offline → presence stays "online" forever.

### How to reproduce
1. Open the app (you appear online)
2. Close the browser tab
3. Other users still see you as online indefinitely

### Fix
```python
# BEFORE (broken) — lines 1739 and 1745:
mdb_set_status(user_id, from_user[0], from_user[1], "offline")

# AFTER (fixed) — username and email already exist at lines 1635-1636:
mdb_set_status(user_id, username, email, "offline")
```
Apply to **both** line 1739 and line 1745.

---

## BUG 3 — Scheduled Message Inserted into `col_messages` With Wrong Fields 🔴 CRITICAL

**File:** `backend/main.py` · **Lines:** 1026–1037  
**Status:** ☐ Open  
**⭐ NEW — from scheduled messages feature**

### What's wrong
`_process_scheduled_messages` builds `actual_msg` and inserts it into `col_messages` but is missing **4 required fields** that every other message has:

| Missing field | Effect |
|---|---|
| `room` | Message never appears in any chat — `db_get_messages_room` filters by room |
| `sender` | `_row_to_msg` reads `doc.get("sender")` → shows empty username |
| `timestamp` | `_row_to_msg` reads `doc.get("timestamp")` → created_at shows blank |
| `is_read` | Defaults to missing → unread badge never clears |

Also uses `"content"` key but `_row_to_msg` reads `"message"` key (line 486).

### Fix
```python
# In _process_scheduled_messages, replace actual_msg block (lines 1026-1036):
room = f"dm_{min(msg['from_user_id'], msg['contact_id'])}_{max(msg['from_user_id'], msg['contact_id'])}"
now_iso = datetime.utcnow().isoformat() + "Z"
expires_iso = (datetime.utcnow() + timedelta(days=7)).isoformat() + "Z"

actual_msg = {
    "id":           _next_id(col_messages),
    "from_user_id": msg["from_user_id"],
    "recipient_id": msg["contact_id"],
    "sender":       sender.get("username", ""),        # ← was missing
    "message":      msg["message"],                    # ← was "content"
    "room":         room,                              # ← was missing
    "timestamp":    now_iso,                           # ← was missing
    "created_at":   now_iso,
    "expires_at":   expires_iso,
    "is_read":      0,                                 # ← was missing
    "status":       "sent",
    "encrypted":    0,
    "file_url":     msg.get("file_url"),
    "file_name":    msg.get("file_name"),
}
```

---

## BUG 4 — Scheduled Message Sent Even If Recipient Blocked the Sender 🟠 HIGH

**File:** `backend/main.py` · **Line:** 1019  
**Status:** ☐ Open  
**⭐ NEW — from scheduled messages feature**

### What's wrong
`_process_scheduled_messages` never checks if the recipient has blocked the sender. A scheduled message will be delivered even if User B blocked User A between the time A scheduled it and the time it fires.

### Fix
```python
# In _process_scheduled_messages, inside the for loop after line 1024:
# Add block check before inserting the message
blocked = mdb_get_blocked(str(msg["contact_id"]))
if str(msg["from_user_id"]) in [str(b) for b in blocked]:
    # Silently skip — mark as sent so it doesn't retry
    col_scheduled_messages.update_one(
        {"id": msg["id"]},
        {"$set": {"sent": True, "skipped_reason": "blocked"}}
    )
    continue
```

---

## BUG 5 — `get_scheduled_messages` Returns Raw MongoDB `_id` to Frontend 🟠 HIGH

**File:** `backend/main.py` · **Line:** 2791–2796  
**Status:** ☐ Open  
**⭐ NEW — from scheduled messages feature**

### What's wrong
`get_scheduled_messages` returns `list(col_scheduled_messages.find(...))` directly without calling `_strip_id()`. MongoDB's `_id` (ObjectId) is not JSON-serialisable — FastAPI will crash with `TypeError: ObjectId is not JSON serializable` on any MongoDB (non-mongita) deployment.

### How to reproduce
Run with a real MongoDB Atlas connection → open any chat with scheduled messages → frontend gets a 500 error.

### Fix
```python
# In get_scheduled_messages (~line 2791):

# BEFORE:
messages = list(col_scheduled_messages.find({
    "from_user_id": cu["user_id"],
    "contact_id": contact_id,
    "sent": False
}).sort("scheduled_time", ASCENDING))
return {"scheduled_messages": messages}

# AFTER:
messages = [_strip_id(dict(m)) for m in col_scheduled_messages.find({
    "from_user_id": cu["user_id"],
    "contact_id": contact_id,
    "sent": False
}).sort("scheduled_time", ASCENDING)]
return {"scheduled_messages": messages}
```

---

## BUG 6 — `col_fcm_tokens` Used Before It Is Defined 🟠 HIGH

**File:** `backend/main.py` · **Lines:** 850, 961, 967 (defined at 1174)  
**Status:** ☐ Open

### What's wrong
`mdb_delete_session` (line 846) and `_run_cleanup` (line 886) reference `col_fcm_tokens` which is only assigned at line 1174. Works today by accident but will crash with `NameError` if code is reorganised or tested in isolation.

### Fix
```python
# Move these 3 lines from line 1174 UP to the collections block (~line 392):
col_fcm_tokens = mdb["fcm_tokens"]
_idx(col_fcm_tokens, "user_id")
_idx(col_fcm_tokens, "session_id")
```

---

## BUG 7 — Camera Flip Doesn't Update Remote Peer 🟠 HIGH

**File:** `frontend/src/components/CallScreen.jsx` · **Line:** 475  
**Status:** ☐ Open

### What's wrong
`switchCamera` replaces `localStreamRef` and canvas loop source but **never calls `sender.replaceTrack()`** on the RTCPeerConnection. Remote peer keeps seeing the original camera — only your own preview switches.

### How to reproduce
1. Start a video call → Click "Flip"
2. Your preview flips ✓ but the other person sees no change ✗

### Fix
```javascript
const switchCamera = async () => {
  const newFacing = facingMode === 'user' ? 'environment' : 'user'
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing }, audio: false })
    const newVT = newStream.getVideoTracks()[0]

    // ✅ ADD THIS LINE — update WebRTC sender so remote peer sees new camera
    const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video')
    if (sender) await sender.replaceTrack(newVT)

    if (rawVideoElRef.current) { rawVideoElRef.current.srcObject = new MediaStream([newVT]); rawVideoElRef.current.play().catch(() => {}) }
    localStreamRef.current?.getVideoTracks().forEach(t => t.stop())
    const audio = localStreamRef.current?.getAudioTracks() || []
    localStreamRef.current = new MediaStream([...audio, newVT])
    setFacingMode(newFacing)
  } catch (err) { console.error('Camera switch failed:', err) }
}
```

---

## BUG 8 — False "Delivered" Receipt When Target Is Offline 🟡 MEDIUM

**File:** `backend/main.py` · **Lines:** 1715–1723  
**Status:** ☐ Open

### What's wrong
When the target user is **offline**, the server still marks the message as `delivered` and sends double grey ticks to sender. The message was only queued as a push notification — not actually received.

### Fix
```python
# Remove db_mark_messages_delivered and message_delivered send from the
# `if not target_online:` block (lines 1715-1723).
# Delivered status should ONLY be set in the target_online=True branch (lines 1659-1666).
```

---

## BUG 9 — Reading a Message Resets Its Disappearing Timer to +24h 🟡 MEDIUM

**File:** `backend/main.py` · **Line:** 608  
**Status:** ☐ Open

### What's wrong
`db_mark_messages_read` unconditionally sets `expires_at = now + 24h`. A 5-minute disappearing message becomes a 24-hour message the moment it is read.

### Fix
```python
# BEFORE — overwrites any existing TTL:
col_messages.update_many(
    {"id": {"$in": ids}},
    {"$set": {"is_read": 1, "status": "seen", "seen_at": seen_at, "expires_at": expires_24h}}
)

# AFTER — set status fields first, then only shorten TTL never extend it:
col_messages.update_many(
    {"id": {"$in": ids}},
    {"$set": {"is_read": 1, "status": "seen", "seen_at": seen_at}}
)
col_messages.update_many(
    {"id": {"$in": ids}, "expires_at": {"$gt": expires_24h}},
    {"$set": {"expires_at": expires_24h}}
)
```

---

## BUG 10 — Race Condition: Call Offer Can Arrive Before Listener Is Added 🟡 MEDIUM

**File:** `frontend/src/components/CallScreen.jsx` · **Line:** 403  
**Status:** ☐ Open

### What's wrong
Callee adds the `call_offer` listener only after several `await` calls. If the offer arrives during those awaits it is missed → 12-second timeout fires → call ends silently.

### Fix
```javascript
// Add early-capture listener BEFORE any await in setup():
let earlyOffer = null
const earlyOfferListener = (ev) => {
  try {
    const d = JSON.parse(ev.data)
    if (d.type === 'call_offer' && String(d.from) === targetId) earlyOffer = d.sdp
  } catch {}
}
wsRef.current?.addEventListener('message', earlyOfferListener)

// Then when you need the SDP (replace the existing wait):
let sdp = offerSdp || earlyOffer
if (!sdp) {
  // existing 12s Promise wait...
}
wsRef.current?.removeEventListener('message', earlyOfferListener)
```

---

## BUG 11 — E2E Private Key Persists in IndexedDB After Logout 🟡 MEDIUM

**File:** `frontend/src/pages/Dashboard.jsx` · **Line:** 3325  
**Status:** ☐ Open

### What's wrong
Logout explicitly skips deleting the E2E private key from IndexedDB (`NEVER delete spvb_e2e` comment). On a shared/public computer the next person can read the previous user's private key from DevTools.

### Fix
```javascript
// In logout() function — add before clearing localStorage:
try {
  if (user?.id) await deleteStoredKeyPair(user.id)
} catch (e) {
  console.warn('[logout] Could not clear E2E key:', e)
}
// Key is safely restored from server backup on next login via fetchBackup()
```

---

## Progress Tracker

| # | Severity | File | Bug | Status |
|---|----------|------|-----|--------|
| 1 | 🔴 Critical | `main.py:2076` | Google OAuth account takeover | ☐ Open |
| 2 | 🔴 Critical | `main.py:1739` | `from_user` NameError → presence broken | ☐ Open |
| 3 | 🔴 Critical | `main.py:1026` | Scheduled msg missing room/sender/timestamp/is_read | ☐ Open |
| 4 | 🟠 High | `main.py:1019` | Scheduled msg sent even if recipient blocked sender | ☐ Open |
| 5 | 🟠 High | `main.py:2791` | `get_scheduled_messages` returns raw `_id` → 500 crash | ☐ Open |
| 6 | 🟠 High | `main.py:850` | `col_fcm_tokens` used before defined | ☐ Open |
| 7 | 🟠 High | `CallScreen.jsx:475` | Camera flip doesn't update WebRTC sender | ☐ Open |
| 8 | 🟡 Medium | `main.py:1715` | False delivered receipt when offline | ☐ Open |
| 9 | 🟡 Medium | `main.py:608` | Read resets disappearing message TTL to +24h | ☐ Open |
| 10 | 🟡 Medium | `CallScreen.jsx:403` | Race: call offer arrives before listener | ☐ Open |
| 11 | 🟡 Medium | `Dashboard.jsx:3325` | Private key persists in IndexedDB after logout | ☐ Open |

---

*Updated 2026-07-02 — includes 3 new bugs from scheduled messages feature (bugs 3, 4, 5)*
