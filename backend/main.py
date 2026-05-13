from fastapi import FastAPI, HTTPException, Depends, status, WebSocket, WebSocketDisconnect, File, UploadFile, Form, Request
from contextlib import asynccontextmanager
from fastapi.responses import JSONResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional, List
from datetime import datetime, timedelta
from jose import jwt
import asyncio
import json
import sqlite3
import os
import hashlib
import re
import shutil
import time
import threading
import traceback
import urllib.request
from collections import defaultdict
from pathlib import Path
from dotenv import load_dotenv

import random as _random

load_dotenv()

def _purge_orphan_uploads(data: dict):
    """Delete any file in uploads/ that is not referenced in the DB and is older than 24 hours."""
    try:
        grace = 24 * 3600  # keep files younger than 24h even if not yet in DB
        now_ts = time.time()
        # Collect every /uploads/ URL still referenced in the database
        referenced = set()
        for u in data.get("users", []):
            for field in ("avatar_url", "cover_url"):
                url = u.get(field, "")
                if url and url.startswith("/uploads/"):
                    referenced.add(url[len("/uploads/"):])
        for m in data.get("messages", []):
            url = m.get("media_url", "")
            if url and url.startswith("/uploads/"):
                referenced.add(url[len("/uploads/"):])
        try:
            for url in db_media_urls():
                if url and url.startswith("/uploads/"):
                    referenced.add(url[len("/uploads/"):])
        except Exception:
            pass
        for s in data.get("statuses", []):
            for field in ("video_url",):
                url = s.get(field, "")
                if url and url.startswith("/uploads/"):
                    referenced.add(url[len("/uploads/"):])
        for m in data.get("group_messages", []):
            url = m.get("media_url", "")
            if url and url.startswith("/uploads/"):
                referenced.add(url[len("/uploads/"):])
        # Delete orphaned files older than the grace period
        deleted = 0
        for fpath in UPLOADS_DIR.iterdir():
            if fpath.name in referenced:
                continue
            try:
                age = now_ts - fpath.stat().st_mtime
                if age > grace:
                    fpath.unlink()
                    deleted += 1
            except Exception:
                pass
        if deleted:
            print(f"[cleanup] Deleted {deleted} orphaned upload files")
    except Exception as e:
        print(f"[cleanup] Orphan scan error: {e}")

async def _periodic_cleanup():
    """Delete expired DB records and orphaned upload files every 30 minutes."""
    await asyncio.sleep(5)  # short delay so server finishes starting up first
    while True:
        try:
            data = load_data()
            before = len(data.get("messages", [])) + len(data.get("statuses", [])) + len(data.get("call_logs", []))
            cleanup_expired(data)
            after = len(data.get("messages", [])) + len(data.get("statuses", [])) + len(data.get("call_logs", []))
            if after < before:
                save_data(data)
                print(f"[cleanup] Purged {before - after} expired records ({after} remain)")
            _purge_orphan_uploads(data)
        except Exception as e:
            print(f"[cleanup] Error: {e}")
        await asyncio.sleep(30 * 60)  # run every 30 minutes

@asynccontextmanager
async def lifespan(_app: FastAPI):
    asyncio.create_task(_periodic_cleanup())
    yield

app = FastAPI(title="SPVB API", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"[500] {request.method} {request.url.path}\n{tb}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error", "path": str(request.url.path)})

# ── WebSocket Connection Manager ──────────────────────────
class WSManager:
    def __init__(self):
        self.connections: dict[str, WebSocket] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        self.connections[str(user_id)] = ws

    def disconnect(self, user_id: str):
        self.connections.pop(str(user_id), None)

    async def send(self, user_id: str, data: dict):
        ws = self.connections.get(str(user_id))
        if ws:
            try:
                await ws.send_json(data)
            except Exception:
                self.disconnect(str(user_id))

ws_manager = WSManager()

DATA_FILE = Path("../data/database.json")
DATA_FILE.parent.mkdir(exist_ok=True)
UPLOADS_DIR = Path("../data/uploads")
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
MESSAGES_DB = Path("../data/messages.db")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
security = HTTPBearer()

def empty_db():
    return {
        "users": [],
        "items": [],
        "messages": [],
        "statuses": [],
        "call_logs": [],
        "user_status": {},
        "login_events": [],
        "password_reset_tokens": {},
        "saved_contacts": {},
        "nicknames": {},
        "blocked": {},
        "groups": [],
        "group_messages": [],
        "qr_tokens": {},
        "linked_devices": [],
        "active_sessions": {},
    }

if not DATA_FILE.exists():
    DATA_FILE.write_text(json.dumps(empty_db(), indent=2))

def load_data() -> dict:
    candidates = [DATA_FILE, DATA_FILE.with_suffix('.json.bak'), DATA_FILE.with_suffix('.json.tmp')]
    best = None
    for path in candidates:
        if path.exists():
            try:
                data = json.loads(path.read_text())
                if not isinstance(data.get("users"), list):
                    continue
                for key, val in empty_db().items():
                    if key not in data:
                        data[key] = val
                # Prefer the candidate with more users
                if best is None or len(data["users"]) >= len(best["users"]):
                    best = data
            except Exception:
                continue
    return best if best is not None else empty_db()

_data_lock = threading.Lock()

def save_data(data: dict):
    with _data_lock:
        tmp = DATA_FILE.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(data, indent=2))
        for attempt in range(5):
            try:
                if DATA_FILE.exists():
                    bak = DATA_FILE.with_suffix('.json.bak')
                    if bak.exists():
                        bak.unlink()
                    DATA_FILE.rename(bak)
                tmp.rename(DATA_FILE)
                return
            except PermissionError:
                time.sleep(0.05 * (attempt + 1))
        tmp.write_text(json.dumps(data, indent=2))
        shutil.copy2(str(tmp), str(DATA_FILE))
        try:
            tmp.unlink()
        except PermissionError:
            pass

_db_lock = threading.Lock()

def _get_db_conn():
    conn = sqlite3.connect(str(MESSAGES_DB))
    conn.row_factory = sqlite3.Row
    return conn

def init_messages_db():
    with _get_db_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS mssg (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                sender    TEXT,
                message   TEXT,
                timestamp TEXT,
                room      TEXT,
                from_user_id   INTEGER,
                recipient_id   INTEGER,
                encrypted      INTEGER DEFAULT 0,
                is_read        INTEGER DEFAULT 0,
                reply_to       INTEGER,
                media_url      TEXT,
                media_type     TEXT,
                file_name      TEXT,
                expires_at     TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mssg_room ON mssg(room)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mssg_expires ON mssg(expires_at)")
        conn.commit()

def _row_to_msg(row) -> dict:
    r = dict(row)
    return {
        "id":           r["id"],
        "from_user_id": r["from_user_id"],
        "from_username": r["sender"],
        "content":      r["message"],
        "room":         r["room"],
        "recipient_id": r["recipient_id"],
        "encrypted":    bool(r["encrypted"]),
        "reply_to":     r["reply_to"],
        "is_read":      bool(r["is_read"]),
        "created_at":   r["timestamp"],
        "expires_at":   r["expires_at"],
        "media_url":    r.get("media_url") or None,
        "media_type":   r.get("media_type") or None,
        "file_name":    r.get("file_name") or None,
    }

def db_save_message(msg: dict) -> dict:
    with _db_lock:
        with _get_db_conn() as conn:
            cur = conn.execute("""
                INSERT INTO mssg
                    (sender, message, timestamp, room, from_user_id, recipient_id,
                     encrypted, is_read, reply_to, media_url, media_type, file_name, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                msg.get("from_username", ""),
                msg.get("content", ""),
                msg.get("created_at", ""),
                msg.get("room", ""),
                msg.get("from_user_id"),
                msg.get("recipient_id"),
                1 if msg.get("encrypted") else 0,
                1 if msg.get("is_read") else 0,
                msg.get("reply_to"),
                msg.get("media_url"),
                msg.get("media_type"),
                msg.get("file_name"),
                msg.get("expires_at", ""),
            ))
            conn.commit()
            new_id = cur.lastrowid
    msg["id"] = new_id
    return msg

def db_get_messages_room(room: str, since_id: int = 0) -> list:
    now = datetime.utcnow().isoformat()
    with _get_db_conn() as conn:
        if since_id > 0:
            rows = conn.execute(
                "SELECT * FROM mssg WHERE room=? AND expires_at > ? AND id > ? ORDER BY id ASC",
                (room, now, since_id)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM mssg WHERE room=? AND expires_at > ? ORDER BY id ASC",
                (room, now)
            ).fetchall()
    return [_row_to_msg(r) for r in rows]

def db_get_all_dm_messages(my_id: int) -> list:
    now = datetime.utcnow().isoformat()
    with _get_db_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM mssg WHERE (from_user_id=? OR recipient_id=?) AND room LIKE 'dm_%' AND expires_at > ? ORDER BY id ASC",
            (my_id, my_id, now)
        ).fetchall()
    return [_row_to_msg(r) for r in rows]

def db_mark_messages_read(contact_id: int, my_id: int) -> list:
    with _db_lock:
        with _get_db_conn() as conn:
            rows = conn.execute(
                "SELECT id FROM mssg WHERE from_user_id=? AND recipient_id=? AND is_read=0",
                (contact_id, my_id)
            ).fetchall()
            ids = [r["id"] for r in rows]
            if ids:
                conn.execute(
                    f"UPDATE mssg SET is_read=1 WHERE id IN ({','.join('?' * len(ids))})",
                    ids
                )
                conn.commit()
    return ids

def db_media_urls() -> set:
    with _get_db_conn() as conn:
        rows = conn.execute("SELECT media_url FROM mssg WHERE media_url IS NOT NULL").fetchall()
    return {r["media_url"] for r in rows}

init_messages_db()

def hash_password(p: str) -> str:
    return hashlib.sha256(p.encode()).hexdigest()

def verify_password(p: str, h: str) -> bool:
    return hash_password(p) == h

def create_jwt_token(data: dict) -> str:
    exp = datetime.utcnow() + timedelta(days=3650)  # ~10 years — expires only on explicit logout
    return jwt.encode({"exp": exp, **data}, os.getenv("JWT_SECRET", "secret"), algorithm=os.getenv("JWT_ALGORITHM", "HS256"))

def decode_jwt_token(token: str) -> dict:
    try:
        return jwt.decode(token, os.getenv("JWT_SECRET", "secret"), algorithms=[os.getenv("JWT_ALGORITHM", "HS256")])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

def validate_password(v: str) -> str:
    if len(v) < 8: raise ValueError("Password must be at least 8 characters")
    if not re.search(r"[A-Z]", v): raise ValueError("Need uppercase letter")
    if not re.search(r"[a-z]", v): raise ValueError("Need lowercase letter")
    if not re.search(r"[0-9]", v): raise ValueError("Need a number")
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", v): raise ValueError("Need a special character")
    return v

def validate_username(v: str) -> str:
    if len(v) < 3: raise ValueError("Username must be at least 3 characters")
    if not re.match(r"^[a-zA-Z0-9_]+$", v): raise ValueError("Letters, numbers, underscores only")
    return v

def _parse_dt(s) -> datetime:
    if not s or not isinstance(s, str):
        return datetime.min
    try:
        return datetime.fromisoformat(s.rstrip("Z"))
    except (ValueError, AttributeError):
        return datetime.min

def _is_expired(item: dict, now: datetime) -> bool:
    try:
        return _parse_dt(item.get("expires_at", "")) <= now
    except Exception:
        return True

def cleanup_expired(data: dict):
    try:
        now = datetime.utcnow()
        try:
            with _db_lock:
                with _get_db_conn() as conn:
                    conn.execute("DELETE FROM mssg WHERE expires_at <= ?", (now.isoformat(),))
                    conn.commit()
        except Exception:
            pass
        data["messages"] = [m for m in data.get("messages", []) if not _is_expired(m, now)]
        data["statuses"] = [s for s in data.get("statuses", []) if not _is_expired(s, now)]
        data["call_logs"] = [c for c in data.get("call_logs", []) if not _is_expired(c, now)]
        data["group_messages"] = [m for m in data.get("group_messages", []) if not _is_expired(m, now)]
        data["password_reset_tokens"] = {
            k: v for k, v in data.get("password_reset_tokens", {}).items()
            if not _is_expired(v, now)
        }
        data["qr_tokens"] = {
            k: v for k, v in data.get("qr_tokens", {}).items()
            if not _is_expired(v, now)
        }
        # Keep login_events lean
        if len(data.get("login_events", [])) > 200:
            data["login_events"] = data["login_events"][-200:]
    except Exception:
        pass

def record_login(data: dict, user_id: int, username: str, email: str, method: str, role: str):
    event = {
        "id": len(data.get("login_events", [])) + 1,
        "user_id": user_id,
        "username": username,
        "email": email,
        "role": role,
        "method": method,
        "timestamp": datetime.now().isoformat(),
    }
    if "login_events" not in data:
        data["login_events"] = []
    data["login_events"].append(event)
    # Keep only last 500 events
    if len(data["login_events"]) > 500:
        data["login_events"] = data["login_events"][-500:]

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    return decode_jwt_token(credentials.credentials)

# ── Models ──────────────────────────────────────────────
class User(BaseModel):
    id: Optional[int] = None
    username: str
    email: EmailStr
    password: str
    role: Optional[str] = "user"
    created_at: Optional[str] = None

    @field_validator("password")
    def vp(cls, v): return validate_password(v)
    @field_validator("username")
    def vu(cls, v): return validate_username(v)

class LoginRequest(BaseModel):
    identifier: str  # email or phone number
    password: str

class RegisterRequest(BaseModel):
    username: str
    email: EmailStr
    password: str
    phone: Optional[str] = None

    @field_validator("password")
    def vp(cls, v): return validate_password(v)
    @field_validator("username")
    def vu(cls, v): return validate_username(v)
    @field_validator("phone")
    def vphone(cls, v):
        if v is None:
            return v
        digits = re.sub(r"[\s\-\+\(\)]", "", v)
        if not re.match(r"^\d{10,15}$", digits):
            raise ValueError("Phone must be 10-15 digits")
        return digits

class GoogleAuthRequest(BaseModel):
    token: str

class SetPasswordRequest(BaseModel):
    password: str
    phone: Optional[str] = None

    @field_validator("password")
    def vp(cls, v): return validate_password(v)
    @field_validator("phone")
    def vphone(cls, v):
        if v is None:
            return v
        digits = re.sub(r"[\s\-\+\(\)]", "", v)
        if not re.match(r"^\d{10,15}$", digits):
            raise ValueError("Phone must be 10-15 digits")
        return digits

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    code: str
    password: str
    @field_validator("password")
    def vp(cls, v): return validate_password(v)

class TokenResponse(BaseModel):
    token: str
    user: dict
    is_new_user: Optional[bool] = None
    needs_setup: Optional[bool] = None

class Item(BaseModel):
    id: Optional[int] = None
    name: str
    description: Optional[str] = None
    created_at: Optional[str] = None

class MessageRequest(BaseModel):
    content: str
    room: Optional[str] = "general"
    recipient_id: Optional[int] = None
    encrypted: Optional[bool] = False
    reply_to: Optional[dict] = None

class StatusRequest(BaseModel):
    content: str
    type: Optional[str] = "text"
    color: Optional[str] = "#00a884"
    video_url: Optional[str] = None

class UserStatusUpdate(BaseModel):
    status: str

# ── WebSocket Signaling ───────────────────────────────────
def _set_status(user_id, username, email, status):
    data = load_data()
    data["user_status"][str(user_id)] = {
        "status": status, "username": username,
        "email": email, "updated_at": datetime.now().isoformat(),
    }
    save_data(data)

@app.websocket("/ws/qr/{token}")
async def qr_ws_endpoint(websocket: WebSocket, token: str):
    """WebSocket for new device to wait for QR approval in real-time."""
    await websocket.accept()
    key = f"qr_{token}"
    ws_manager.connections[key] = websocket
    try:
        while True:
            await asyncio.sleep(1)
            data = load_data()
            rec = data.get("qr_tokens", {}).get(token)
            if not rec or _is_expired(rec, datetime.utcnow()):
                await websocket.send_json({"type": "qr_expired"})
                break
            if rec["status"] == "approved":
                await websocket.send_json({"type": "qr_approved", "jwt": rec.get("jwt", "")})
                break
            if rec["status"] == "rejected":
                await websocket.send_json({"type": "qr_rejected"})
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        ws_manager.connections.pop(key, None)

@app.websocket("/ws/{user_id}")
async def ws_endpoint(websocket: WebSocket, user_id: str, token: str = ""):
    try:
        payload = decode_jwt_token(token)
        if str(payload.get("user_id")) != str(user_id):
            await websocket.close(code=4001)
            return
    except Exception:
        await websocket.close(code=4001)
        return

    await ws_manager.connect(user_id, websocket)
    from_user = payload.get("username", ""), payload.get("email", "")
    _set_status(user_id, from_user[0], from_user[1], "online")
    try:
        while True:
            data = await websocket.receive_json()
            target = str(data.get("target", ""))
            if target:
                await ws_manager.send(target, {**data, "from": str(user_id)})
    except WebSocketDisconnect:
        ws_manager.disconnect(str(user_id))
        _set_status(user_id, from_user[0], from_user[1], "offline")
    except Exception:
        ws_manager.disconnect(str(user_id))
        _set_status(user_id, from_user[0], from_user[1], "offline")

# ── Public Key Exchange (E2E) ─────────────────────────────
@app.put("/users/me/pubkey")
def set_pubkey(body: dict, cu: dict = Depends(get_current_user)):
    pubkey = body.get("pubkey", "")
    data = load_data()
    for u in data["users"]:
        if u["id"] == cu["user_id"]:
            u["pubkey"] = pubkey
            save_data(data)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="User not found")

@app.get("/users/{user_id}/pubkey")
def get_pubkey(user_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    for u in data["users"]:
        if u["id"] == user_id:
            return {"pubkey": u.get("pubkey", ""), "user_id": user_id}
    raise HTTPException(status_code=404, detail="User not found")

# ── Health ───────────────────────────────────────────────
@app.get("/")
def root():
    return {"message": "SPVB API", "version": "1.0.0"}

@app.get("/health")
def health():
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}

# ── Auth ─────────────────────────────────────────────────
@app.post("/auth/register", response_model=TokenResponse)
def register(req: RegisterRequest):
    data = load_data()
    for u in data["users"]:
        if u["email"] == req.email:
            raise HTTPException(status_code=400, detail="Email already registered")
        if u["username"] == req.username:
            raise HTTPException(status_code=400, detail="Username already taken")
    uid = (max((u["id"] for u in data["users"]), default=0)) + 1
    new_user = {"id": uid, "username": req.username, "email": req.email, "phone": req.phone or "", "password": hash_password(req.password), "has_password": True, "role": "user", "created_at": datetime.now().isoformat(), "display_name": req.username, "avatar_url": ""}
    data["users"].append(new_user)
    record_login(data, uid, req.username, req.email, "register", "user")
    save_data(data)
    token = create_jwt_token({"user_id": uid, "username": req.username, "email": req.email, "role": "user", "display_name": req.username, "avatar_url": ""})
    return {"token": token, "user": {"id": uid, "username": req.username, "email": req.email, "phone": req.phone or "", "role": "user", "display_name": req.username, "avatar_url": ""}}

@app.post("/auth/login", response_model=TokenResponse)
def login(req: LoginRequest):
    admin_email = os.getenv("ADMIN_EMAIL")
    admin_password = os.getenv("ADMIN_PASSWORD")
    data = load_data()

    identifier = req.identifier.strip()
    is_email = "@" in identifier

    if is_email and identifier == admin_email and req.password == admin_password:
        record_login(data, 0, "admin", admin_email, "email", "admin")
        save_data(data)
        token = create_jwt_token({"user_id": 0, "username": "admin", "email": admin_email, "role": "admin"})
        return {"token": token, "user": {"id": 0, "username": "admin", "email": admin_email, "role": "admin"}}

    # Match by email or phone
    matched_user = None
    for u in data["users"]:
        if is_email and u["email"] == identifier:
            matched_user = u
            break
        if not is_email and u.get("phone") and u["phone"] == re.sub(r"[\s\-\+\(\)]", "", identifier):
            matched_user = u
            break

    if not matched_user:
        hint = "email" if is_email else "phone number"
        raise HTTPException(status_code=401, detail=f"No account found with this {hint}")

    u = matched_user
    stored_pwd = u.get("password", "")
    if not u.get("has_password") and stored_pwd == "":
        raise HTTPException(status_code=401, detail="This account uses Google Sign-In. Set a password first via Account Setup, or click 'Continue with Google'.")
    if stored_pwd and verify_password(req.password, stored_pwd):
        try:
            record_login(data, u["id"], u["username"], u["email"], "email", u.get("role", "user"))
            save_data(data)
        except Exception:
            pass
        token = create_jwt_token({"user_id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", "")})
        return {"token": token, "user": {"id": u["id"], "username": u["username"], "email": u["email"], "phone": u.get("phone", ""), "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "cover_url": u.get("cover_url", "")}}
    raise HTTPException(status_code=401, detail="Incorrect password")

@app.post("/auth/google", response_model=TokenResponse)
def google_login(req: GoogleAuthRequest):
    try:
        with urllib.request.urlopen(f"https://oauth2.googleapis.com/tokeninfo?id_token={req.token}", timeout=10) as r:
            gd = json.loads(r.read().decode())
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Google token")

    email = gd.get("email")
    name = gd.get("name", "")
    picture = gd.get("picture", "")
    if not email:
        raise HTTPException(status_code=401, detail="Could not get email from Google")

    data = load_data()
    user = next((u for u in data["users"] if u["email"] == email), None)
    is_new_user = False
    if not user:
        is_new_user = True
        uid = (max((u["id"] for u in data["users"]), default=0)) + 1
        base = re.sub(r"[^a-zA-Z0-9_]", "_", name.lower().replace(" ", "_")) or email.split("@")[0]
        username = base
        counter = 1
        while any(u["username"] == username for u in data["users"]):
            username = f"{base}{counter}"; counter += 1
        user = {"id": uid, "username": username, "email": email, "password": "", "has_password": False, "role": "user", "created_at": datetime.now().isoformat(), "google_id": gd.get("sub"), "avatar_url": picture, "display_name": name}
        data["users"].append(user)

    record_login(data, user["id"], user["username"], email, "google", user.get("role", "user"))
    save_data(data)
    tok = create_jwt_token({"user_id": user["id"], "username": user["username"], "email": email, "role": user.get("role", "user"), "display_name": user.get("display_name", name), "avatar_url": user.get("avatar_url", picture)})
    needs_setup = not user.get("has_password") or not user.get("phone")
    return {"token": tok, "user": {"id": user["id"], "username": user["username"], "email": email, "role": user.get("role", "user"), "display_name": user.get("display_name", name), "avatar_url": user.get("avatar_url", picture)}, "is_new_user": is_new_user, "needs_setup": needs_setup}

@app.get("/auth/me")
def get_me(cu: dict = Depends(get_current_user)):
    data = load_data()
    u = next((u for u in data["users"] if u["id"] == cu["user_id"]), None)
    if not u:
        return cu
    return {
        "user_id": u["id"], "id": u["id"],
        "username": u["username"], "email": u["email"],
        "phone": u.get("phone", ""), "role": u.get("role", "user"),
        "display_name": u.get("display_name", u["username"]),
        "avatar_url": u.get("avatar_url", ""),
        "cover_url": u.get("cover_url", ""),
        "about": u.get("about", ""),
    }

@app.post("/auth/set-password")
def set_password(req: SetPasswordRequest, cu: dict = Depends(get_current_user)):
    data = load_data()
    for u in data["users"]:
        if u["id"] == cu["user_id"]:
            u["password"] = hash_password(req.password)
            u["has_password"] = True
            if req.phone:
                u["phone"] = req.phone
            save_data(data)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="User not found")

@app.post("/auth/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    import secrets, string
    data = load_data()
    cleanup_expired(data)
    user = next((u for u in data["users"] if u["email"] == req.email), None)
    if not user:
        return {"ok": True, "message": "If this email exists, a reset code has been sent"}
    code = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
    expires = (datetime.now() + timedelta(minutes=15)).isoformat()
    if "password_reset_tokens" not in data:
        data["password_reset_tokens"] = {}
    data["password_reset_tokens"][req.email] = {"code": code, "expires_at": expires, "user_id": user["id"]}
    save_data(data)
    return {"ok": True, "reset_code": code}

@app.post("/auth/reset-password")
def reset_password_endpoint(req: ResetPasswordRequest):
    data = load_data()
    cleanup_expired(data)
    token_entry = None
    token_email = None
    for email, entry in data.get("password_reset_tokens", {}).items():
        if entry["code"] == req.code:
            token_entry = entry
            token_email = email
            break
    if not token_entry:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    if _parse_dt(token_entry["expires_at"]) < datetime.now():
        raise HTTPException(status_code=400, detail="Reset code has expired")
    for u in data["users"]:
        if u["id"] == token_entry["user_id"]:
            u["password"] = hash_password(req.password)
            u["has_password"] = True
            break
    del data["password_reset_tokens"][token_email]
    save_data(data)
    return {"ok": True}

# ── User Online Status ────────────────────────────────────
@app.post("/users/me/status")
def set_user_status(body: UserStatusUpdate, cu: dict = Depends(get_current_user)):
    data = load_data()
    data["user_status"][str(cu["user_id"])] = {"status": body.status, "username": cu.get("username", ""), "email": cu.get("email", ""), "updated_at": datetime.now().isoformat()}
    save_data(data)
    return {"ok": True}

@app.get("/contacts")
def get_contacts(cu: dict = Depends(get_current_user)):
    data = load_data()
    now = datetime.now()
    result = []
    for u in data["users"]:
        if u["id"] == cu["user_id"]:
            continue
        uid_str = str(u["id"])
        st = data.get("user_status", {}).get(uid_str)
        if st:
            diff = (now - _parse_dt(st["updated_at"])).total_seconds()
            online = "online" if diff < 120 else ("away" if diff < 300 else "offline")
            last_seen = st["updated_at"]
        else:
            online = "offline"
            last_seen = None
        my_nicknames = data.get("nicknames", {}).get(str(cu["user_id"]), {})
        result.append({
            "id": u["id"],
            "username": u["username"],
            "email": u["email"],
            "display_name": u.get("display_name", u["username"]),
            "avatar_url": u.get("avatar_url", ""),
            "cover_url": u.get("cover_url", ""),
            "about": u.get("about", "Hey there! I am using SPVB."),
            "phone": u.get("phone", ""),
            "online_status": online,
            "last_seen": last_seen,
            "nickname": my_nicknames.get(str(u["id"]), ""),
        })
    return result

@app.get("/contacts/saved")
def get_saved_contacts(cu: dict = Depends(get_current_user)):
    data = load_data()
    saved = data.get("saved_contacts", {}).get(str(cu["user_id"]), [])
    return {"saved_contact_ids": saved}

@app.post("/contacts/{contact_id}/save")
def save_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    uid = str(cu["user_id"])
    sc = data.setdefault("saved_contacts", {})
    sc.setdefault(uid, [])
    if contact_id not in sc[uid]:
        sc[uid].append(contact_id)
    save_data(data)
    return {"ok": True}

@app.get("/users/find-by-phone")
def find_user_by_phone(phone: str, cu: dict = Depends(get_current_user)):
    raw = re.sub(r"[^\d]", "", phone)  # digits only
    if not raw:
        raise HTTPException(status_code=400, detail="Phone number required")
    # Normalise to last 10 digits so +91XXXXXXXXXX matches XXXXXXXXXX
    search = raw[-10:] if len(raw) >= 10 else raw
    data = load_data()
    for u in data["users"]:
        stored_raw = re.sub(r"[^\d]", "", u.get("phone", ""))
        if not stored_raw:
            continue
        stored = stored_raw[-10:] if len(stored_raw) >= 10 else stored_raw
        if stored == search:
            if u["id"] == cu["user_id"]:
                raise HTTPException(status_code=400, detail="That's your own number")
            return {
                "id": u["id"],
                "username": u["username"],
                "display_name": u.get("display_name", u["username"]),
                "avatar_url": u.get("avatar_url", ""),
                "about": u.get("about", "Hey there! I am using SPVB."),
            }
    raise HTTPException(status_code=404, detail="No SPVB user found with this phone number")

@app.delete("/contacts/{contact_id}/save")
def unsave_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    uid = str(cu["user_id"])
    sc = data.get("saved_contacts", {})
    if uid in sc:
        sc[uid] = [c for c in sc[uid] if c != contact_id]
    save_data(data)
    return {"ok": True}

@app.put("/contacts/{contact_id}/nickname")
def set_nickname(contact_id: int, body: dict, cu: dict = Depends(get_current_user)):
    data = load_data()
    nicknames = data.setdefault("nicknames", {})
    my_map = nicknames.setdefault(str(cu["user_id"]), {})
    nick = str(body.get("nickname", "")).strip()[:50]
    if nick:
        my_map[str(contact_id)] = nick
    else:
        my_map.pop(str(contact_id), None)
    save_data(data)
    return {"ok": True, "nickname": nick}

@app.post("/contacts/{contact_id}/block")
def block_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    blocked = data.setdefault("blocked", {})
    my_list = blocked.setdefault(str(cu["user_id"]), [])
    if contact_id not in my_list:
        my_list.append(contact_id)
    save_data(data)
    return {"ok": True}

@app.delete("/contacts/{contact_id}/block")
def unblock_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    blocked = data.setdefault("blocked", {})
    my_list = blocked.get(str(cu["user_id"]), [])
    blocked[str(cu["user_id"])] = [x for x in my_list if x != contact_id]
    save_data(data)
    return {"ok": True}

@app.get("/contacts/blocked")
def get_blocked(cu: dict = Depends(get_current_user)):
    data = load_data()
    my_list = data.get("blocked", {}).get(str(cu["user_id"]), [])
    result = []
    for uid in my_list:
        u = next((u for u in data["users"] if u["id"] == uid), None)
        if u:
            result.append({"id": u["id"], "username": u["username"], "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", "")})
    return result

@app.put("/auth/me")
def update_me(body: dict, cu: dict = Depends(get_current_user)):
    data = load_data()
    for u in data["users"]:
        if u["id"] == cu["user_id"]:
            if "display_name" in body:
                u["display_name"] = str(body["display_name"])[:50]
            if "about" in body:
                u["about"] = str(body["about"])[:140]
            if "phone" in body:
                raw = re.sub(r"[^\d]", "", str(body["phone"]))
                if len(raw) > 15:
                    raise HTTPException(status_code=400, detail="Invalid phone number")
                u["phone"] = raw
            if "cover_url" in body:
                u["cover_url"] = str(body["cover_url"])[:500]
            if "avatar_url" in body:
                u["avatar_url"] = str(body["avatar_url"])[:500]
            save_data(data)
            return {"ok": True, "user": {
                "id": u["id"], "username": u["username"], "email": u["email"],
                "phone": u.get("phone", ""),
                "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]),
                "avatar_url": u.get("avatar_url", ""), "cover_url": u.get("cover_url", ""),
                "about": u.get("about", ""),
            }}
    raise HTTPException(status_code=404, detail="User not found")

@app.get("/messages/recent")
def get_recent_conversations(cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    conversations = {}
    unread_per_contact = {}
    sent_any_unread = {}
    sent_any_msg = {}
    for msg in db_get_all_dm_messages(my_id):
        room = msg.get("room", "")
        parts = room[3:].split("_")
        if len(parts) != 2:
            continue
        try:
            id1, id2 = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        contact_id = id2 if id1 == my_id else id1
        if msg.get("from_user_id") == contact_id and msg.get("recipient_id") == my_id and not msg.get("is_read", False):
            unread_per_contact[contact_id] = unread_per_contact.get(contact_id, 0) + 1
        if msg.get("from_user_id") == my_id and msg.get("recipient_id") == contact_id:
            sent_any_msg[contact_id] = True
            if not msg.get("is_read", False):
                sent_any_unread[contact_id] = True
        prev = conversations.get(contact_id)
        if prev is None or msg["created_at"] > prev["created_at"]:
            conversations[contact_id] = {
                "contact_id": contact_id,
                "last_message": msg["content"],
                "created_at": msg["created_at"],
                "from_me": msg["from_user_id"] == my_id,
            }
    for cid, conv in conversations.items():
        conv["unread_count"] = unread_per_contact.get(cid, 0)
        if sent_any_msg.get(cid):
            conv["all_sent_read"] = not sent_any_unread.get(cid, False)
        else:
            conv["all_sent_read"] = False
    return conversations

@app.put("/messages/read/{contact_id}")
async def mark_messages_read(contact_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    marked_ids = db_mark_messages_read(contact_id, my_id)
    if marked_ids:
        await ws_manager.send(str(contact_id), {
            "type": "read_receipt",
            "by": my_id,
            "message_ids": marked_ids,
        })
    return {"ok": True, "count": len(marked_ids)}

@app.get("/messages/conversation/{contact_id}")
def get_conversation(contact_id: int, since_id: int = 0, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    room = f"dm_{min(my_id, contact_id)}_{max(my_id, contact_id)}"
    return db_get_messages_room(room, since_id)

@app.get("/users/online")
def get_online_users(cu: dict = Depends(get_current_user)):
    data = load_data()
    now = datetime.now()  # match local time used in user_status.updated_at
    result = {}
    for uid, info in data.get("user_status", {}).items():
        diff = (now - _parse_dt(info["updated_at"])).total_seconds()
        if diff < 60:
            result[uid] = {**info, "online_status": "online"}
        elif diff < 300:
            result[uid] = {**info, "online_status": "away"}
        else:
            result[uid] = {**info, "online_status": "offline"}
    return result

# ── Admin Stats ───────────────────────────────────────────
@app.get("/admin/stats")
def admin_stats(cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    data = load_data()
    now = datetime.now()
    today = now.date().isoformat()

    # Online users (heartbeat within 2 min)
    online_users = []
    for uid, info in data.get("user_status", {}).items():
        diff = (now - _parse_dt(info["updated_at"])).total_seconds()
        online_users.append({
            "user_id": uid,
            "username": info.get("username", ""),
            "email": info.get("email", ""),
            "online_status": "online" if diff < 120 else ("away" if diff < 300 else "offline"),
            "last_seen": info["updated_at"],
        })
    online_users.sort(key=lambda x: x["online_status"])

    # Login events
    events = data.get("login_events", [])
    logins_today = [e for e in events if e["timestamp"].startswith(today)]
    logins_week = [e for e in events if _parse_dt(e["timestamp"]) > now - timedelta(days=7)]

    # Unique active users (logged in within 7 days)
    active_user_ids = {e["user_id"] for e in logins_week}

    # Method breakdown
    email_logins = sum(1 for e in events if e.get("method") == "email")
    google_logins = sum(1 for e in events if e.get("method") == "google")
    register_events = sum(1 for e in events if e.get("method") == "register")

    return {
        "total_users": len(data["users"]),
        "total_items": len(data["items"]),
        "online_now": sum(1 for u in online_users if u["online_status"] == "online"),
        "away_now": sum(1 for u in online_users if u["online_status"] == "away"),
        "logins_today": len(logins_today),
        "logins_week": len(logins_week),
        "active_users_week": len(active_user_ids),
        "total_logins": len(events),
        "email_logins": email_logins,
        "google_logins": google_logins,
        "register_events": register_events,
        "online_users": online_users,
        "recent_logins": list(reversed(events[-50:])),  # last 50 login events
    }

# ── Messages (24hr TTL) ───────────────────────────────────
@app.post("/messages")
async def create_message(msg: MessageRequest, cu: dict = Depends(get_current_user)):
    _now = datetime.utcnow()
    message = {
        "from_user_id": cu["user_id"],
        "from_username": cu.get("username", ""),
        "content": msg.content,
        "room": msg.room,
        "recipient_id": msg.recipient_id,
        "encrypted": msg.encrypted or False,
        "reply_to": msg.reply_to or None,
        "is_read": False,
        "created_at": _now.isoformat() + "Z",
        "expires_at": (_now + timedelta(hours=24)).isoformat() + "Z",
    }
    message = db_save_message(message)
    if msg.recipient_id:
        await ws_manager.send(str(msg.recipient_id), {"type": "chat_message", "message": message})
    return message

@app.get("/messages/{room}")
def get_messages(room: str, cu: dict = Depends(get_current_user)):
    return db_get_messages_room(room)

# ── Statuses (24hr TTL) ───────────────────────────────────
@app.post("/upload")
async def upload_file(file: UploadFile = File(...), cu: dict = Depends(get_current_user)):
    ext = Path(file.filename).suffix.lower() if file.filename else '.mp4'
    allowed = {'.mp4', '.webm', '.mov', '.ogg', '.mkv', '.jpg', '.jpeg', '.png', '.gif', '.webp'}
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="Invalid file type")
    filename = f"{cu['user_id']}_{int(datetime.now().timestamp())}{ext}"
    dest = UPLOADS_DIR / filename
    with dest.open('wb') as f:
        shutil.copyfileobj(file.file, f)
    return {"url": f"/uploads/{filename}"}

@app.post("/messages/media")
async def send_media_message(
    file: UploadFile = File(...),
    recipient_id: int = Form(...),
    caption: str = Form(""),
    cu: dict = Depends(get_current_user)
):
    ext = Path(file.filename).suffix.lower() if file.filename else '.jpg'
    img_exts = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
    vid_exts = {'.mp4', '.mov', '.mkv'}
    aud_exts = {'.webm', '.ogg', '.mp3', '.m4a', '.wav', '.aac'}
    doc_exts = {'.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls', '.pptx', '.ppt', '.zip', '.rar', '.csv'}
    allowed = img_exts | vid_exts | aud_exts | doc_exts
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="Invalid file type")
    media_type = "image" if ext in img_exts else "video" if ext in vid_exts else "audio" if ext in aud_exts else "document"
    filename = f"msg_{cu['user_id']}_{int(datetime.now().timestamp())}{ext}"
    dest = UPLOADS_DIR / filename
    with dest.open('wb') as f:
        shutil.copyfileobj(file.file, f)
    media_url = f"/uploads/{filename}"
    _now = datetime.utcnow()
    my_id = cu["user_id"]
    room = f"dm_{min(my_id, recipient_id)}_{max(my_id, recipient_id)}"
    message = {
        "from_user_id": my_id,
        "from_username": cu.get("username", ""),
        "content": caption or "",
        "media_url": media_url,
        "media_type": media_type,
        "file_name": file.filename or "",
        "room": room,
        "recipient_id": recipient_id,
        "encrypted": False,
        "is_read": False,
        "created_at": _now.isoformat() + "Z",
        "expires_at": (_now + timedelta(hours=24)).isoformat() + "Z",
    }
    message = db_save_message(message)
    await ws_manager.send(str(recipient_id), {"type": "chat_message", "message": message})
    return message

@app.post("/statuses")
async def create_status(body: StatusRequest, cu: dict = Depends(get_current_user)):
    data = load_data()
    cleanup_expired(data)
    user = next((u for u in data["users"] if u["id"] == cu["user_id"]), {})
    s = {
        "id": len(data["statuses"]) + 1,
        "user_id": cu["user_id"],
        "username": cu.get("username", ""),
        "display_name": user.get("display_name", cu.get("username", "")),
        "avatar_url": user.get("avatar_url", ""),
        "content": body.content,
        "type": body.type,
        "color": body.color or "#00a884",
        "video_url": body.video_url or None,
        "created_at": datetime.utcnow().isoformat(),
        "expires_at": (datetime.utcnow() + timedelta(hours=24)).isoformat(),
    }
    s["view_count"] = 0
    s["viewed_by"] = []
    s["reactions"] = []
    data["statuses"].append(s)
    save_data(data)
    for uid in list(ws_manager.connections.keys()):
        if int(uid) != cu["user_id"]:
            await ws_manager.send(uid, {"type": "new_status", "status": s})
    return s

@app.get("/statuses")
def get_statuses(cu: dict = Depends(get_current_user)):
    data = load_data()
    now = datetime.utcnow()
    # Only save if cleanup actually removed something (avoids unnecessary writes)
    before = len(data.get("messages", [])) + len(data.get("statuses", []))
    cleanup_expired(data)
    after = len(data.get("messages", [])) + len(data.get("statuses", []))
    if after < before:
        save_data(data)
    result = []
    for s in data.get("statuses", []):
        if _parse_dt(s["expires_at"]) <= now:
            continue
        entry = dict(s)
        if s["user_id"] == cu["user_id"]:
            viewers = []
            for uid in s.get("viewed_by", []):
                u = next((u for u in data["users"] if u["id"] == uid), None)
                if u:
                    viewers.append({"id": uid, "name": u.get("display_name") or u.get("username", f"User {uid}")})
            entry["viewers"] = viewers
        result.append(entry)
    return result

@app.delete("/statuses/{status_id}")
def delete_status(status_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    idx = next((i for i, s in enumerate(data["statuses"]) if s["id"] == status_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Status not found")
    if data["statuses"][idx]["user_id"] != cu["user_id"]:
        raise HTTPException(status_code=403, detail="Not your status")
    s = data["statuses"].pop(idx)
    # Delete video file from disk
    if s.get("video_url"):
        try:
            fname = s["video_url"].replace("/uploads/", "")
            fpath = UPLOADS_DIR / fname
            if fpath.exists():
                fpath.unlink()
        except Exception:
            pass
    save_data(data)
    return {"ok": True}

@app.post("/statuses/{status_id}/view")
def view_status(status_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    s = next((s for s in data["statuses"] if s["id"] == status_id), None)
    if not s:
        return {"ok": True}
    viewer_id = cu["user_id"]
    if viewer_id not in s.get("viewed_by", []) and viewer_id != s["user_id"]:
        s.setdefault("viewed_by", []).append(viewer_id)
        s["view_count"] = len(s["viewed_by"])
        save_data(data)
    return {"view_count": s.get("view_count", 0)}

@app.post("/statuses/{status_id}/react")
async def react_status(status_id: int, body: dict, cu: dict = Depends(get_current_user)):
    data = load_data()
    s = next((s for s in data["statuses"] if s["id"] == status_id), None)
    if not s:
        return {"ok": True}
    emoji = str(body.get("emoji", "")).strip()
    user_obj = next((u for u in data["users"] if u["id"] == cu["user_id"]), {})
    reactor_name = user_obj.get("display_name") or user_obj.get("username", f"User {cu['user_id']}")
    reactions = s.setdefault("reactions", [])
    # Remove existing reaction from this user
    s["reactions"] = [r for r in reactions if r["user_id"] != cu["user_id"]]
    if emoji:  # empty emoji = remove reaction
        s["reactions"].append({"user_id": cu["user_id"], "name": reactor_name, "emoji": emoji})
    save_data(data)
    # Notify status owner via WS
    await ws_manager.send(str(s["user_id"]), {
        "type": "status_reaction",
        "status_id": status_id,
        "reactions": s["reactions"],
        "reactor_name": reactor_name,
        "emoji": emoji,
    })
    return {"ok": True, "reactions": s["reactions"]}

# ── Call Logs (24hr TTL) ─────────────────────────────────
@app.post("/call-logs")
def save_call_log(body: dict, cu: dict = Depends(get_current_user)):
    data = load_data()
    cleanup_expired(data)
    contact_id = int(body.get("contact_id", 0))
    contact = next((u for u in data["users"] if u["id"] == contact_id), None)
    now = datetime.utcnow()
    log = {
        "id": (max((c["id"] for c in data.get("call_logs", [])), default=0)) + 1,
        "user_id": cu["user_id"],
        "contact_id": contact_id,
        "contact_username": contact.get("username", "") if contact else "",
        "contact_display_name": contact.get("display_name", "") if contact else "",
        "contact_avatar_url": contact.get("avatar_url", "") if contact else "",
        "call_type": str(body.get("call_type", "voice")),
        "direction": str(body.get("direction", "outgoing")),
        "status": str(body.get("status", "completed")),
        "duration": int(body.get("duration", 0)),
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=24)).isoformat(),
    }
    data.setdefault("call_logs", []).append(log)
    save_data(data)
    return log

@app.get("/call-logs")
def get_call_logs(cu: dict = Depends(get_current_user)):
    data = load_data()
    now = datetime.utcnow()
    my_id = cu["user_id"]
    logs = [
        c for c in data.get("call_logs", [])
        if c.get("user_id") == my_id and _parse_dt(c["expires_at"]) > now
    ]
    return sorted(logs, key=lambda x: x["created_at"], reverse=True)

# ── Phone Contact Sync ────────────────────────────────────
@app.post("/contacts/sync-phones")
def sync_phone_contacts(body: dict, cu: dict = Depends(get_current_user)):
    phones = body.get("phones", [])
    if not isinstance(phones, list):
        raise HTTPException(status_code=400, detail="phones must be a list")
    data = load_data()
    my_id = cu["user_id"]
    matched = []
    seen_ids = set()
    for phone in phones[:500]:
        raw = re.sub(r"[^\d]", "", str(phone))
        if not raw:
            continue
        raw10 = raw[-10:]
        for u in data["users"]:
            if u["id"] == my_id or u["id"] in seen_ids:
                continue
            stored = re.sub(r"[^\d]", "", u.get("phone", ""))
            if stored and (stored[-10:] == raw10):
                matched.append({
                    "id": u["id"],
                    "username": u["username"],
                    "display_name": u.get("display_name", u["username"]),
                    "avatar_url": u.get("avatar_url", ""),
                    "phone": u.get("phone", ""),
                })
                seen_ids.add(u["id"])
                break
    return matched

# ── Users CRUD ────────────────────────────────────────────
@app.post("/users", response_model=dict)
def create_user(user: User, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    data = load_data()
    uid = (max((u["id"] for u in data["users"]), default=0)) + 1
    user.id = uid; user.created_at = datetime.now().isoformat(); user.password = hash_password(user.password)
    data["users"].append(user.model_dump(mode="json"))
    save_data(data)
    return {"id": uid, "message": "User created"}

@app.get("/users")
def get_users(cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    data = load_data()
    now = datetime.now()
    user_status_map = data.get("user_status", {})

    result = []
    for u in data["users"]:
        uid_str = str(u["id"])
        st = user_status_map.get(uid_str)
        if st:
            diff = (now - _parse_dt(st["updated_at"])).total_seconds()
            online = "online" if diff < 120 else ("away" if diff < 300 else "offline")
            last_seen = st["updated_at"]
        else:
            online = "never"
            last_seen = None

        # Count logins for this user
        login_count = sum(1 for e in data.get("login_events", []) if e["user_id"] == u["id"])
        last_login = next((e["timestamp"] for e in reversed(data.get("login_events", [])) if e["user_id"] == u["id"]), None)

        result.append({
            "id": u["id"],
            "username": u["username"],
            "email": u["email"],
            "role": u.get("role", "user"),
            "created_at": u.get("created_at"),
            "avatar_url": u.get("avatar_url", ""),
            "display_name": u.get("display_name", ""),
            "online_status": online,
            "last_seen": last_seen,
            "login_count": login_count,
            "last_login": last_login,
        })
    return result

@app.get("/users/{user_id}")
def get_user(user_id: int, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    data = load_data()
    for u in data["users"]:
        if u["id"] == user_id:
            return {"id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "created_at": u.get("created_at")}
    raise HTTPException(status_code=404, detail="User not found")

@app.put("/users/{user_id}")
def update_user(user_id: int, user: User, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    data = load_data()
    for i, u in enumerate(data["users"]):
        if u["id"] == user_id:
            data["users"][i] = {"id": user_id, "username": user.username, "email": user.email, "password": hash_password(user.password), "role": u.get("role", "user"), "created_at": u.get("created_at")}
            save_data(data)
            return {"id": user_id, "message": "User updated"}
    raise HTTPException(status_code=404, detail="User not found")

@app.delete("/users/{user_id}")
def delete_user(user_id: int, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    data = load_data()
    data["users"] = [u for u in data["users"] if u["id"] != user_id]
    save_data(data)
    return {"message": "User deleted"}

# ── Items CRUD ────────────────────────────────────────────
@app.post("/items")
def create_item(item: Item, cu: dict = Depends(get_current_user)):
    data = load_data()
    iid = (max((i["id"] for i in data["items"]), default=0)) + 1
    item.id = iid; item.created_at = datetime.now().isoformat()
    data["items"].append(item.model_dump(mode="json"))
    save_data(data)
    return {"id": iid, "message": "Item created"}

@app.get("/items")
def get_items(cu: dict = Depends(get_current_user)):
    return load_data().get("items", [])

@app.get("/items/{item_id}")
def get_item(item_id: int, cu: dict = Depends(get_current_user)):
    for item in load_data().get("items", []):
        if item["id"] == item_id:
            return item
    raise HTTPException(status_code=404, detail="Item not found")

@app.put("/items/{item_id}")
def update_item(item_id: int, item: Item, cu: dict = Depends(get_current_user)):
    data = load_data()
    for i, it in enumerate(data["items"]):
        if it["id"] == item_id:
            data["items"][i] = {"id": item_id, **item.model_dump(mode="json"), "created_at": it.get("created_at")}
            save_data(data)
            return {"id": item_id, "message": "Item updated"}
    raise HTTPException(status_code=404, detail="Item not found")

@app.delete("/items/{item_id}")
def delete_item(item_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    data["items"] = [i for i in data["items"] if i["id"] != item_id]
    save_data(data)
    return {"message": "Item deleted"}

# ── Smart Reply (local ML-Kit-style engine, no external API) ──
class SmartReplyRequest(BaseModel):
    messages: List[dict]  # [{"role": "user"|"bot", "text": str}]

def _compute_smart_replies(last_bot: str, last_user: str) -> list:
    b = last_bot.lower()
    u = last_user.lower()

    # ── Bot message analysis ──
    if re.search(r'how are you|how r u|doing well|feeling', b):
        return ["I'm good, thanks! 😊", "Could be better", "Pretty great! 🎉"]
    if re.search(r'\banother joke\b|tell another|more joke', b):
        return ["Yes please! 😄", "That was enough 😂", "One more! 🤣"]
    if re.search(r'joke|funny|lol|haha|😂|😄|humor|bugs|atoms|microchip', b):
        return ["😂 Hilarious!", "Tell another one! 😄", "Good one! 👏"]
    if re.search(r'\btime\b|clock|pm|am|o\'clock|right now', b):
        return ["Thanks! ⏰", "Time flies!", "Already? ⌚"]
    if re.search(r'today is|date|monday|tuesday|wednesday|thursday|friday|saturday|sunday', b):
        return ["Thanks! 📅", "Already that day?", "Time flies! 🗓️"]
    if re.search(r'hello|hi there|hey|great to see you|welcome', b):
        return ["Hello! 👋", "Hey! How are you?", "Hi there! 😊"]
    if re.search(r'goodbye|bye|take care|see you|come back anytime|stay awesome', b):
        return ["Bye! 👋", "See you soon!", "Take care! 😊"]
    if re.search(r'encrypt|secure|privacy|aes|e2e|256.bit|key', b):
        return ["That's impressive! 🔒", "How secure exactly?", "Good to know! 👍"]
    if re.search(r'voice call|video call|hd voice|tap the call', b):
        return ["Cool! Let me try 📞", "Does it work well?", "Nice feature! 😎"]
    if re.search(r'feature|gmail|chatbot|spvb|status update|contact sync', b):
        return ["Wow, that's cool! 😎", "Tell me more!", "How do I use it?"]
    if re.search(r'tip|advice|suggestion|try|set a status|use end.to.end', b):
        return ["Thanks! 💡", "Good to know!", "I'll try that 👍"]
    if re.search(r'sorry|feel down|storm passes|deep breath|i\'m here for you', b):
        return ["Thank you 🙏", "That helps a lot!", "Appreciate it ❤️"]
    if re.search(r'what can i do|how can i help|ask me|try asking|what.*need', b):
        return ["Tell me a joke 😄", "What's the time? ⏰", "Give me a tip 💡"]
    if re.search(r'interesting|fascinating|amazing|great|wonderful|awesome', b):
        return ["Tell me more! 🤔", "That's cool!", "Really? 😮"]
    if re.search(r'weather|temperature|can\'t check', b):
        return ["That's fine! 😊", "I'll check online", "Thanks anyway!"]
    if re.search(r'bored|challenge|hardest question', b):
        return ["What is AI? 🤖", "Tell me a joke! 😄", "Give me a tip 💡"]
    if re.search(r'love|amazing|you\'re amazing|makes me happy', b):
        return ["You too! 😊", "Aww thanks! 🥰", "You're the best! ⭐"]
    if re.search(r'\?', b):  # Bot asked something
        return ["Yes! 👍", "Not really...", "Tell me more 💬"]

    # ── User message analysis (fallback) ──
    if re.search(r'thank|thanks|ty\b', u):
        return ["You're welcome! 😊", "Anytime! 🌟", "Happy to help!"]
    if re.search(r'\b(hi|hello|hey)\b', u):
        return ["How are you? 😊", "Tell me a joke! 😄", "What can you do?"]
    if re.search(r'joke|funny', u):
        return ["😂 Again please!", "That was great!", "More jokes! 😄"]
    if re.search(r'bye|goodbye', u):
        return ["Bye! 👋", "See you!", "Take care 😊"]
    if re.search(r'help|support|assist', u):
        return ["Tell me a joke 😄", "Give me a tip 💡", "SPVB features? 🚀"]
    if re.search(r'time|date|day', u):
        return ["Thanks! ⏰", "Wow!", "That's right ✅"]
    if re.search(r'encrypt|safe|secure|private', u):
        return ["Tell me more 🔒", "That's great!", "How exactly?"]
    if re.search(r'call|video|voice', u):
        return ["Let's try it! 📞", "How does it work?", "That's useful 📹"]
    if re.search(r'sad|bad|upset|depressed', u):
        return ["I'm here 🙏", "Thanks for sharing", "You'll be okay 💪"]
    if re.search(r'love|like|great|amazing|awesome', u):
        return ["Thank you! 🥰", "That's sweet!", "You're awesome too! 🌟"]

    # ── Generic smart fallback with variety ──
    pools = [
        ["Got it! 👍", "Tell me more 💬", "Interesting! 🤔"],
        ["Sounds good! ✅", "Really? 😮", "Nice! 😊"],
        ["That's great! 🎉", "I see 🤔", "Continue... 💬"],
        ["Okay! 👍", "What else? 🤔", "Thanks 😊"],
        ["Noted! ✅", "Tell me more!", "Wow! 😮"],
    ]
    return _random.choice(pools)

# ── Group Chat ──────────────────────────────────────────────

class CreateGroupRequest(BaseModel):
    name: str
    member_ids: List[int]

class GroupMessageRequest(BaseModel):
    content: str
    reply_to: Optional[dict] = None

def _group_member_details(members: list, user_map: dict) -> list:
    return [
        {"id": m, "display_name": user_map[m].get("display_name", user_map[m]["username"]) if m in user_map else str(m), "avatar_url": user_map[m].get("avatar_url", "") if m in user_map else ""}
        for m in members
    ]

@app.post("/groups")
async def create_group(body: CreateGroupRequest, cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    user_map = {u["id"]: u for u in data["users"]}
    members = [my_id] + [m for m in body.member_ids if m != my_id and m in user_map]
    members = list(dict.fromkeys(members))
    groups = data.setdefault("groups", [])
    new_id = max((g["id"] for g in groups), default=0) + 1
    group = {"id": new_id, "name": body.name[:100], "creator_id": my_id, "members": members, "created_at": datetime.utcnow().isoformat() + "Z", "avatar_url": ""}
    groups.append(group)
    save_data(data)
    for mid in members:
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_created", "group": {**group, "member_details": _group_member_details(members, user_map)}})
    return {**group, "member_details": _group_member_details(members, user_map)}

@app.get("/groups")
def get_groups(cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    user_map = {u["id"]: u for u in data["users"]}
    result = []
    for g in data.get("groups", []):
        if my_id not in g.get("members", []):
            continue
        gmsgs = [m for m in data.get("group_messages", []) if m.get("group_id") == g["id"]]
        last = gmsgs[-1] if gmsgs else None
        result.append({**g, "member_details": _group_member_details(g.get("members", []), user_map), "last_message": last.get("content", "") if last else "", "last_message_time": last.get("created_at", "") if last else ""})
    return result

@app.get("/groups/{group_id}/messages")
def get_group_messages(group_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    group = next((g for g in data.get("groups", []) if g["id"] == group_id), None)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    user_map = {u["id"]: u for u in data["users"]}
    return [{**m, "sender_name": user_map[m["from_user_id"]].get("display_name", user_map[m["from_user_id"]]["username"]) if m["from_user_id"] in user_map else str(m["from_user_id"]), "sender_avatar": user_map[m["from_user_id"]].get("avatar_url", "") if m["from_user_id"] in user_map else ""} for m in data.get("group_messages", []) if m.get("group_id") == group_id]

@app.post("/groups/{group_id}/messages")
async def send_group_message(group_id: int, body: GroupMessageRequest, cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    group = next((g for g in data.get("groups", []) if g["id"] == group_id), None)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    user_map = {u["id"]: u for u in data["users"]}
    msgs = data.setdefault("group_messages", [])
    new_id = max((m["id"] for m in msgs), default=0) + 1
    now = datetime.utcnow()
    msg = {"id": new_id, "group_id": group_id, "from_user_id": my_id, "content": body.content[:4000], "media_url": None, "media_type": None, "file_name": None, "reply_to": body.reply_to, "created_at": now.isoformat() + "Z", "expires_at": (now + timedelta(hours=24)).isoformat() + "Z"}
    msgs.append(msg)
    save_data(data)
    sender_name = user_map[my_id].get("display_name", user_map[my_id]["username"]) if my_id in user_map else str(my_id)
    sender_avatar = user_map[my_id].get("avatar_url", "") if my_id in user_map else ""
    broadcast = {**msg, "sender_name": sender_name, "sender_avatar": sender_avatar}
    for mid in group.get("members", []):
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_message", "message": broadcast, "group_id": group_id, "group_name": group["name"]})
    return broadcast

@app.post("/groups/{group_id}/media")
async def send_group_media(group_id: int, file: UploadFile = File(...), cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    group = next((g for g in data.get("groups", []) if g["id"] == group_id), None)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    ext = Path(file.filename or "file").suffix.lower() or ".bin"
    fname = f"grp_{group_id}_{my_id}_{int(time.time())}{ext}"
    fpath = UPLOADS_DIR / fname
    with open(fpath, "wb") as f_out:
        f_out.write(await file.read())
    url = f"/uploads/{fname}"
    ct = file.content_type or ""
    mtype = "image" if ct.startswith("image/") else "video" if ct.startswith("video/") else "audio" if ct.startswith("audio/") else "document"
    user_map = {u["id"]: u for u in data["users"]}
    msgs = data.setdefault("group_messages", [])
    new_id = max((m["id"] for m in msgs), default=0) + 1
    now = datetime.utcnow()
    msg = {"id": new_id, "group_id": group_id, "from_user_id": my_id, "content": "", "media_url": url, "media_type": mtype, "file_name": file.filename, "reply_to": None, "created_at": now.isoformat() + "Z", "expires_at": (now + timedelta(hours=24)).isoformat() + "Z"}
    msgs.append(msg)
    save_data(data)
    sender_name = user_map[my_id].get("display_name", user_map[my_id]["username"]) if my_id in user_map else str(my_id)
    sender_avatar = user_map[my_id].get("avatar_url", "") if my_id in user_map else ""
    broadcast = {**msg, "sender_name": sender_name, "sender_avatar": sender_avatar}
    for mid in group.get("members", []):
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_message", "message": broadcast, "group_id": group_id, "group_name": group["name"]})
    return broadcast

@app.put("/groups/{group_id}")
def update_group(group_id: int, body: dict, cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    group = next((g for g in data.get("groups", []) if g["id"] == group_id), None)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    if "name" in body: group["name"] = str(body["name"])[:100]
    if "avatar_url" in body: group["avatar_url"] = str(body["avatar_url"])
    save_data(data)
    return group

@app.delete("/groups/{group_id}/members/{user_id}")
def remove_group_member(group_id: int, user_id: int, cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    group = next((g for g in data.get("groups", []) if g["id"] == group_id), None)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    if user_id != my_id and group.get("creator_id") != my_id:
        raise HTTPException(status_code=403, detail="Only creator can remove others")
    group["members"] = [m for m in group["members"] if m != user_id]
    save_data(data)
    return group

@app.post("/groups/{group_id}/members")
def add_group_member(group_id: int, body: dict, cu: dict = Depends(get_current_user)):
    data = load_data()
    my_id = cu["user_id"]
    group = next((g for g in data.get("groups", []) if g["id"] == group_id), None)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    uid = int(body.get("user_id", 0))
    user_exists = any(u["id"] == uid for u in data["users"])
    if uid and uid not in group["members"] and user_exists:
        group["members"].append(uid)
        save_data(data)
    return group

import secrets as _secrets

# ── QR Device Linking ──────────────────────────────────────

@app.post("/devices/qr/generate")
async def generate_qr_token(cu: dict = Depends(get_current_user)):
    """Generate a one-time QR token for linking another device."""
    data = load_data()
    user_id = cu["user_id"]
    token = _secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(minutes=10)).isoformat()
    data["qr_tokens"][token] = {
        "user_id": user_id,
        "status": "pending",
        "created_at": datetime.utcnow().isoformat(),
        "expires_at": expires_at,
        "approved": False,
    }
    save_data(data)
    return {"token": token, "expires_at": expires_at}

@app.get("/devices/qr/{token}/status")
async def qr_token_status(token: str):
    """Poll this to check if QR token has been approved."""
    data = load_data()
    rec = data.get("qr_tokens", {}).get(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found or expired")
    if _is_expired(rec, datetime.utcnow()):
        raise HTTPException(status_code=410, detail="Token expired")
    return {"status": rec["status"], "approved": rec.get("approved", False)}

@app.post("/devices/qr/{token}/scan")
async def scan_qr_token(token: str, request: Request):
    """
    Called by the NEW device (the one scanning the QR) — NO auth required.
    The QR token itself identifies the account. Primary device approves.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    data = load_data()
    rec = data.get("qr_tokens", {}).get(token)
    if not rec:
        raise HTTPException(status_code=404, detail="QR code not found. Please generate a new one.")
    if _is_expired(rec, datetime.utcnow()):
        raise HTTPException(status_code=410, detail="QR code expired. Please generate a new one.")
    if rec["status"] == "scanned":
        # Already scanned — just re-notify in case the WS missed it
        pass
    elif rec["status"] != "pending":
        raise HTTPException(status_code=409, detail="QR code already used.")
    device_name = body.get("device_name", "Unknown Device")
    rec["status"] = "scanned"
    rec["scanner_device"] = device_name
    rec["scanner_user_agent"] = body.get("user_agent", "")
    save_data(data)
    # Notify primary device via WebSocket
    await ws_manager.send(str(rec["user_id"]), {
        "type": "qr_link_request",
        "token": token,
        "device_name": device_name,
        "user_agent": body.get("user_agent", ""),
    })
    return {"status": "scanned", "message": "Approval request sent to primary device"}

@app.post("/devices/qr/{token}/approve")
async def approve_qr_token(token: str, cu: dict = Depends(get_current_user)):
    """Primary device approves the QR link request."""
    data = load_data()
    rec = data.get("qr_tokens", {}).get(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found or expired")
    if _is_expired(rec, datetime.utcnow()):
        raise HTTPException(status_code=410, detail="Token expired")
    if cu["user_id"] != rec["user_id"]:
        raise HTTPException(status_code=403, detail="Not your token")
    user = next((u for u in data["users"] if u["id"] == rec["user_id"]), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    # Create JWT for the new device
    token_data = {
        "user_id": user["id"],
        "username": user["username"],
        "email": user["email"],
        "role": user.get("role", "user"),
        "display_name": user.get("display_name", user["username"]),
        "avatar_url": user.get("avatar_url", ""),
    }
    new_jwt = create_jwt_token(token_data)
    # Register linked device
    device_id = _secrets.token_urlsafe(16)
    device_entry = {
        "id": device_id,
        "user_id": user["id"],
        "device_name": rec.get("scanner_device", "Linked Device"),
        "user_agent": rec.get("scanner_user_agent", ""),
        "linked_at": datetime.utcnow().isoformat(),
    }
    if "linked_devices" not in data:
        data["linked_devices"] = []
    data["linked_devices"].append(device_entry)
    rec["status"] = "approved"
    rec["approved"] = True
    rec["jwt"] = new_jwt
    save_data(data)
    # Notify the scanning device
    await ws_manager.send(f"qr_{token}", {
        "type": "qr_approved",
        "token": token,
        "jwt": new_jwt,
        "user": token_data,
    })
    return {"status": "approved"}

@app.post("/devices/qr/{token}/reject")
async def reject_qr_token(token: str, cu: dict = Depends(get_current_user)):
    """Primary device rejects the QR link request."""
    data = load_data()
    rec = data.get("qr_tokens", {}).get(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found")
    if cu["user_id"] != rec["user_id"]:
        raise HTTPException(status_code=403, detail="Not your token")
    rec["status"] = "rejected"
    save_data(data)
    await ws_manager.send(f"qr_{token}", {"type": "qr_rejected", "token": token})
    return {"status": "rejected"}

@app.get("/devices/qr/{token}/await")
async def await_qr_approval(token: str):
    """
    Long-poll endpoint: new device waits here until approved/rejected/expired.
    Returns immediately if a decision has been made.
    """
    for _ in range(30):  # wait up to 30s
        data = load_data()
        rec = data.get("qr_tokens", {}).get(token)
        if not rec:
            raise HTTPException(status_code=404, detail="Token not found")
        if _is_expired(rec, datetime.utcnow()):
            raise HTTPException(status_code=410, detail="Token expired")
        if rec["status"] == "approved":
            return {"status": "approved", "jwt": rec.get("jwt", "")}
        if rec["status"] == "rejected":
            return {"status": "rejected"}
        await asyncio.sleep(1)
    return {"status": "pending"}

@app.get("/devices")
async def list_devices(cu: dict = Depends(get_current_user)):
    """List all linked devices for the current user."""
    data = load_data()
    my_devices = [d for d in data.get("linked_devices", []) if d["user_id"] == cu["user_id"]]
    return my_devices

@app.delete("/devices/{device_id}")
async def remove_device(device_id: str, cu: dict = Depends(get_current_user)):
    """Remove a linked device."""
    data = load_data()
    before = len(data.get("linked_devices", []))
    data["linked_devices"] = [
        d for d in data.get("linked_devices", [])
        if not (d["id"] == device_id and d["user_id"] == cu["user_id"])
    ]
    if len(data["linked_devices"]) == before:
        raise HTTPException(status_code=404, detail="Device not found")
    save_data(data)
    return {"status": "removed"}


@app.post("/smart-reply")
async def smart_reply(req: SmartReplyRequest, cu: dict = Depends(get_current_user)):
    msgs = req.messages or []
    last_bot, last_user = "", ""
    for m in reversed(msgs):
        txt = (m.get("text") or "").strip()
        if not txt or txt.startswith("__location__|") or txt.startswith("__contact__|"):
            continue
        if m.get("role") == "bot" and not last_bot:
            last_bot = txt
        elif m.get("role") == "user" and not last_user:
            last_user = txt
        if last_bot and last_user:
            break
    suggestions = _compute_smart_replies(last_bot, last_user)
    return {"suggestions": suggestions[:3]}
