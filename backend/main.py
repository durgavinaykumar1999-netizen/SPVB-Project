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
from pymongo import MongoClient, ASCENDING, DESCENDING
import asyncio
import json
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

# ── MongoDB Setup ─────────────────────────────────────────
def _fix_mongo_uri(uri: str) -> str:
    """URL-encode special characters in MongoDB URI username/password."""
    import urllib.parse
    try:
        # Extract scheme + credentials + host portion
        # Format: scheme://user:pass@host/db
        scheme, rest = uri.split("://", 1)
        if "@" not in rest:
            return uri
        # Find the last @ that separates credentials from host
        creds, hostpart = rest.rsplit("@", 1)
        if ":" in creds:
            user, passwd = creds.split(":", 1)
            passwd = passwd.strip("<>")  # strip display-formatting brackets if present
            encoded = f"{urllib.parse.quote_plus(user)}:{urllib.parse.quote_plus(passwd)}"
        else:
            encoded = urllib.parse.quote_plus(creds)
        return f"{scheme}://{encoded}@{hostpart}"
    except Exception:
        return uri

_MONGO_URI = _fix_mongo_uri(os.getenv("MONGODB_URI", ""))
_mongo_client = MongoClient(_MONGO_URI)
# Use the database name from the URI, fallback to "spvb"
try:
    _db_name = _MONGO_URI.rsplit("/", 1)[-1].split("?")[0].strip() or "spvb"
except Exception:
    _db_name = "spvb"
mdb = _mongo_client[_db_name]

# Collections — users/auth separate from chat messages
col_users          = mdb["users"]
col_messages       = mdb["messages"]        # chat messages
col_login_events   = mdb["login_events"]    # user login history
col_statuses       = mdb["statuses"]
col_groups         = mdb["groups"]
col_group_messages = mdb["group_messages"]
col_call_logs      = mdb["call_logs"]
col_user_status    = mdb["user_status"]
col_saved_contacts = mdb["saved_contacts"]
col_nicknames      = mdb["nicknames"]
col_blocked        = mdb["blocked"]
col_qr_tokens      = mdb["qr_tokens"]
col_linked_devices = mdb["linked_devices"]
col_password_reset = mdb["password_reset_tokens"]

# Indexes
col_users.create_index("id", unique=True)
col_users.create_index("email", unique=True)
col_messages.create_index([("room", ASCENDING), ("expires_at", ASCENDING)])
col_messages.create_index("id", unique=True)
col_login_events.create_index("id")
col_statuses.create_index("id")
col_groups.create_index("id", unique=True)
col_group_messages.create_index("id", unique=True)
col_call_logs.create_index("id", unique=True)
col_user_status.create_index("user_id", unique=True)
col_qr_tokens.create_index("token", unique=True)
col_linked_devices.create_index("id", unique=True)

# ── MongoDB Helpers ───────────────────────────────────────

def _strip_id(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc

def _next_id(collection) -> int:
    docs = list(collection.find({}, {"id": 1, "_id": 0}).sort("id", DESCENDING).limit(1))
    return (docs[0]["id"] + 1) if docs else 1

_data_lock = threading.Lock()

# ── User helpers ──────────────────────────────────────────

def mdb_get_users() -> list:
    return [_strip_id(u) for u in col_users.find({}, {"_id": 0})]

def mdb_get_user_by_id(uid: int) -> Optional[dict]:
    doc = col_users.find_one({"id": uid}, {"_id": 0})
    return _strip_id(doc) if doc else None

def mdb_get_user_by_email(email: str) -> Optional[dict]:
    doc = col_users.find_one({"email": email}, {"_id": 0})
    return _strip_id(doc) if doc else None

def mdb_get_user_by_username(username: str) -> Optional[dict]:
    doc = col_users.find_one({"username": username}, {"_id": 0})
    return _strip_id(doc) if doc else None

def mdb_get_user_by_phone(phone: str) -> Optional[dict]:
    doc = col_users.find_one({"phone": phone}, {"_id": 0})
    return _strip_id(doc) if doc else None

def mdb_save_user(user: dict):
    col_users.replace_one({"id": user["id"]}, user, upsert=True)

def mdb_delete_user(uid: int):
    col_users.delete_one({"id": uid})

def mdb_update_user(uid: int, fields: dict):
    col_users.update_one({"id": uid}, {"$set": fields})

# ── Message helpers (MongoDB replaces SQLite) ─────────────

def _row_to_msg(doc: dict) -> dict:
    _strip_id(doc)
    return {
        "id":           doc.get("id"),
        "from_user_id": doc.get("from_user_id"),
        "from_username": doc.get("sender", ""),
        "content":      doc.get("message", ""),
        "room":         doc.get("room", ""),
        "recipient_id": doc.get("recipient_id"),
        "encrypted":    bool(doc.get("encrypted")),
        "reply_to":     doc.get("reply_to"),
        "is_read":      bool(doc.get("is_read")),
        "created_at":   doc.get("timestamp", ""),
        "expires_at":   doc.get("expires_at", ""),
        "media_url":    doc.get("media_url") or None,
        "media_type":   doc.get("media_type") or None,
        "file_name":    doc.get("file_name") or None,
    }

def db_save_message(msg: dict) -> dict:
    with _data_lock:
        new_id = _next_id(col_messages)
        doc = {
            "id":           new_id,
            "sender":       msg.get("from_username", ""),
            "message":      msg.get("content", ""),
            "timestamp":    msg.get("created_at", ""),
            "room":         msg.get("room", ""),
            "from_user_id": msg.get("from_user_id"),
            "recipient_id": msg.get("recipient_id"),
            "encrypted":    1 if msg.get("encrypted") else 0,
            "is_read":      1 if msg.get("is_read") else 0,
            "reply_to":     msg.get("reply_to"),
            "media_url":    msg.get("media_url"),
            "media_type":   msg.get("media_type"),
            "file_name":    msg.get("file_name"),
            "expires_at":   msg.get("expires_at", ""),
        }
        col_messages.insert_one(doc)
    msg["id"] = new_id
    return msg

def db_get_messages_room(room: str, since_id: int = 0) -> list:
    now = datetime.utcnow().isoformat()
    query = {"room": room, "expires_at": {"$gt": now}}
    if since_id > 0:
        query["id"] = {"$gt": since_id}
    docs = col_messages.find(query, {"_id": 0}).sort("id", ASCENDING)
    return [_row_to_msg(dict(d)) for d in docs]

def db_get_all_dm_messages(my_id: int) -> list:
    now = datetime.utcnow().isoformat()
    query = {
        "$or": [{"from_user_id": my_id}, {"recipient_id": my_id}],
        "room": {"$regex": "^dm_"},
        "expires_at": {"$gt": now},
    }
    docs = col_messages.find(query, {"_id": 0}).sort("id", ASCENDING)
    return [_row_to_msg(dict(d)) for d in docs]

def db_mark_messages_read(contact_id: int, my_id: int) -> list:
    with _data_lock:
        docs = list(col_messages.find(
            {"from_user_id": contact_id, "recipient_id": my_id, "is_read": 0},
            {"id": 1, "_id": 0}
        ))
        ids = [d["id"] for d in docs]
        if ids:
            col_messages.update_many(
                {"id": {"$in": ids}},
                {"$set": {"is_read": 1}}
            )
    return ids

def db_media_urls() -> set:
    docs = col_messages.find({"media_url": {"$ne": None}}, {"media_url": 1, "_id": 0})
    return {d["media_url"] for d in docs}

# ── Login events helpers ──────────────────────────────────

def mdb_record_login(user_id: int, username: str, email: str, method: str, role: str):
    event_id = _next_id(col_login_events)
    col_login_events.insert_one({
        "id": event_id,
        "user_id": user_id,
        "username": username,
        "email": email,
        "role": role,
        "method": method,
        "timestamp": datetime.now().isoformat(),
    })
    # Keep only last 500 events
    total = col_login_events.count_documents({})
    if total > 500:
        oldest = list(col_login_events.find({}, {"id": 1, "_id": 0}).sort("id", ASCENDING).limit(total - 500))
        if oldest:
            col_login_events.delete_many({"id": {"$in": [d["id"] for d in oldest]}})

def mdb_get_login_events() -> list:
    return [_strip_id(dict(d)) for d in col_login_events.find({}, {"_id": 0}).sort("id", ASCENDING)]

# ── User status helpers ───────────────────────────────────

def mdb_set_status(user_id, username, email, st):
    col_user_status.replace_one(
        {"user_id": str(user_id)},
        {"user_id": str(user_id), "status": st, "username": username, "email": email, "updated_at": datetime.now().isoformat()},
        upsert=True
    )

def mdb_get_user_status() -> dict:
    result = {}
    for doc in col_user_status.find({}, {"_id": 0}):
        uid = doc.pop("user_id")
        result[str(uid)] = doc
    return result

# ── Saved contacts helpers ────────────────────────────────

def mdb_get_saved_contacts(uid: str) -> list:
    doc = col_saved_contacts.find_one({"user_id": uid}, {"_id": 0})
    return doc.get("contact_ids", []) if doc else []

def mdb_save_saved_contacts(uid: str, ids: list):
    col_saved_contacts.replace_one({"user_id": uid}, {"user_id": uid, "contact_ids": ids}, upsert=True)

# ── Nicknames helpers ─────────────────────────────────────

def mdb_get_nicknames(uid: str) -> dict:
    doc = col_nicknames.find_one({"user_id": uid}, {"_id": 0})
    return doc.get("map", {}) if doc else {}

def mdb_save_nicknames(uid: str, mapping: dict):
    col_nicknames.replace_one({"user_id": uid}, {"user_id": uid, "map": mapping}, upsert=True)

# ── Blocked helpers ───────────────────────────────────────

def mdb_get_blocked(uid: str) -> list:
    doc = col_blocked.find_one({"user_id": uid}, {"_id": 0})
    return doc.get("ids", []) if doc else []

def mdb_save_blocked(uid: str, ids: list):
    col_blocked.replace_one({"user_id": uid}, {"user_id": uid, "ids": ids}, upsert=True)

# ── QR token helpers ──────────────────────────────────────

def mdb_get_qr_token(token: str) -> Optional[dict]:
    doc = col_qr_tokens.find_one({"token": token}, {"_id": 0})
    return _strip_id(dict(doc)) if doc else None

def mdb_save_qr_token(token: str, rec: dict):
    col_qr_tokens.replace_one({"token": token}, {"token": token, **rec}, upsert=True)

def mdb_delete_expired_qr():
    col_qr_tokens.delete_many({"expires_at": {"$lt": datetime.utcnow().isoformat()}})

# ── Password reset helpers ────────────────────────────────

def mdb_get_reset_token(email: str) -> Optional[dict]:
    doc = col_password_reset.find_one({"email": email}, {"_id": 0})
    return _strip_id(dict(doc)) if doc else None

def mdb_save_reset_token(email: str, rec: dict):
    col_password_reset.replace_one({"email": email}, {"email": email, **rec}, upsert=True)

def mdb_delete_reset_token(email: str):
    col_password_reset.delete_one({"email": email})

def mdb_find_reset_token_by_code(code: str) -> tuple:
    doc = col_password_reset.find_one({"code": code}, {"_id": 0})
    if not doc:
        return None, None
    email = doc.get("email")
    return email, _strip_id(dict(doc))

# ── Statuses helpers ──────────────────────────────────────

def mdb_get_statuses() -> list:
    return [_strip_id(dict(d)) for d in col_statuses.find({}, {"_id": 0})]

def mdb_save_status(s: dict):
    col_statuses.replace_one({"id": s["id"]}, s, upsert=True)

def mdb_delete_status(status_id: int):
    col_statuses.delete_one({"id": status_id})

def mdb_get_status_by_id(status_id: int) -> Optional[dict]:
    doc = col_statuses.find_one({"id": status_id}, {"_id": 0})
    return _strip_id(dict(doc)) if doc else None

def mdb_next_status_id() -> int:
    return _next_id(col_statuses)

def mdb_cleanup_expired_statuses():
    col_statuses.delete_many({"expires_at": {"$lt": datetime.utcnow().isoformat()}})

# ── Groups helpers ────────────────────────────────────────

def mdb_get_groups() -> list:
    return [_strip_id(dict(d)) for d in col_groups.find({}, {"_id": 0})]

def mdb_get_group(group_id: int) -> Optional[dict]:
    doc = col_groups.find_one({"id": group_id}, {"_id": 0})
    return _strip_id(dict(doc)) if doc else None

def mdb_save_group(g: dict):
    col_groups.replace_one({"id": g["id"]}, g, upsert=True)

def mdb_next_group_id() -> int:
    return _next_id(col_groups)

def mdb_get_group_messages(group_id: int) -> list:
    now = datetime.utcnow().isoformat()
    docs = col_group_messages.find(
        {"group_id": group_id, "expires_at": {"$gt": now}},
        {"_id": 0}
    ).sort("id", ASCENDING)
    return [_strip_id(dict(d)) for d in docs]

def mdb_save_group_message(msg: dict) -> dict:
    with _data_lock:
        new_id = _next_id(col_group_messages)
        msg["id"] = new_id
        col_group_messages.insert_one({**msg})
    return msg

# ── Call log helpers ──────────────────────────────────────

def mdb_get_call_logs(user_id: int) -> list:
    now = datetime.utcnow().isoformat()
    docs = col_call_logs.find(
        {"user_id": user_id, "expires_at": {"$gt": now}},
        {"_id": 0}
    ).sort("created_at", DESCENDING)
    return [_strip_id(dict(d)) for d in docs]

def mdb_save_call_log(log: dict) -> dict:
    with _data_lock:
        new_id = _next_id(col_call_logs)
        log["id"] = new_id
        col_call_logs.insert_one({**log})
    return log

# ── Linked devices helpers ────────────────────────────────

def mdb_get_devices(user_id: int) -> list:
    docs = col_linked_devices.find({"user_id": user_id}, {"_id": 0})
    return [_strip_id(dict(d)) for d in docs]

def mdb_save_device(device: dict):
    col_linked_devices.insert_one({**device})

def mdb_delete_device(device_id: str, user_id: int) -> bool:
    res = col_linked_devices.delete_one({"id": device_id, "user_id": user_id})
    return res.deleted_count > 0

# ── Periodic cleanup ──────────────────────────────────────

def _purge_orphan_uploads():
    try:
        grace = 24 * 3600
        now_ts = time.time()
        referenced = set()
        for u in mdb_get_users():
            for field in ("avatar_url", "cover_url"):
                url = u.get(field, "")
                if url and url.startswith("/uploads/"):
                    referenced.add(url[len("/uploads/"):])
        for url in db_media_urls():
            if url and url.startswith("/uploads/"):
                referenced.add(url[len("/uploads/"):])
        for s in mdb_get_statuses():
            url = s.get("video_url", "")
            if url and url.startswith("/uploads/"):
                referenced.add(url[len("/uploads/"):])
        for fpath in UPLOADS_DIR.iterdir():
            if fpath.name in referenced:
                continue
            try:
                if now_ts - fpath.stat().st_mtime > grace:
                    fpath.unlink()
            except Exception:
                pass
    except Exception as e:
        print(f"[cleanup] Orphan scan error: {e}")

async def _periodic_cleanup():
    await asyncio.sleep(5)
    while True:
        try:
            mdb_cleanup_expired_statuses()
            col_messages.delete_many({"expires_at": {"$lt": datetime.utcnow().isoformat()}})
            col_call_logs.delete_many({"expires_at": {"$lt": datetime.utcnow().isoformat()}})
            col_group_messages.delete_many({"expires_at": {"$lt": datetime.utcnow().isoformat()}})
            mdb_delete_expired_qr()
            col_password_reset.delete_many({"expires_at": {"$lt": datetime.utcnow().isoformat()}})
            _purge_orphan_uploads()
        except Exception as e:
            print(f"[cleanup] Error: {e}")
        await asyncio.sleep(30 * 60)

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

UPLOADS_DIR = Path("../data/uploads")
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
security = HTTPBearer()

# ── Auth helpers ──────────────────────────────────────────

def hash_password(p: str) -> str:
    return hashlib.sha256(p.encode()).hexdigest()

def verify_password(p: str, h: str) -> bool:
    return hash_password(p) == h

def create_jwt_token(data: dict) -> str:
    exp = datetime.utcnow() + timedelta(days=3650)
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

def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    return decode_jwt_token(credentials.credentials)

# ── Models ────────────────────────────────────────────────

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
    identifier: str
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

# ── WebSocket Endpoints ───────────────────────────────────

@app.websocket("/ws/qr/{token}")
async def qr_ws_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    key = f"qr_{token}"
    ws_manager.connections[key] = websocket
    try:
        while True:
            await asyncio.sleep(1)
            rec = mdb_get_qr_token(token)
            if not rec or _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
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
    mdb_set_status(user_id, from_user[0], from_user[1], "online")
    try:
        while True:
            data = await websocket.receive_json()
            target = str(data.get("target", ""))
            if target:
                await ws_manager.send(target, {**data, "from": str(user_id)})
    except WebSocketDisconnect:
        ws_manager.disconnect(str(user_id))
        mdb_set_status(user_id, from_user[0], from_user[1], "offline")
    except Exception:
        ws_manager.disconnect(str(user_id))
        mdb_set_status(user_id, from_user[0], from_user[1], "offline")

# ── Public Key Exchange (E2E) ─────────────────────────────

@app.put("/users/me/pubkey")
def set_pubkey(body: dict, cu: dict = Depends(get_current_user)):
    mdb_update_user(cu["user_id"], {"pubkey": body.get("pubkey", "")})
    return {"ok": True}

@app.get("/users/{user_id}/pubkey")
def get_pubkey(user_id: int, cu: dict = Depends(get_current_user)):
    u = mdb_get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return {"pubkey": u.get("pubkey", ""), "user_id": user_id}

# ── Health ────────────────────────────────────────────────

@app.get("/")
def root():
    return {"message": "SPVB API", "version": "1.0.0"}

@app.get("/health")
def health():
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}

# ── Auth ──────────────────────────────────────────────────

@app.post("/auth/register", response_model=TokenResponse)
def register(req: RegisterRequest):
    if mdb_get_user_by_email(req.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    if mdb_get_user_by_username(req.username):
        raise HTTPException(status_code=400, detail="Username already taken")
    uid = _next_id(col_users)
    new_user = {
        "id": uid, "username": req.username, "email": req.email,
        "phone": req.phone or "", "password": hash_password(req.password),
        "has_password": True, "role": "user",
        "created_at": datetime.now().isoformat(),
        "display_name": req.username, "avatar_url": "",
    }
    mdb_save_user(new_user)
    mdb_record_login(uid, req.username, req.email, "register", "user")
    token = create_jwt_token({"user_id": uid, "username": req.username, "email": req.email, "role": "user", "display_name": req.username, "avatar_url": ""})
    return {"token": token, "user": {"id": uid, "username": req.username, "email": req.email, "phone": req.phone or "", "role": "user", "display_name": req.username, "avatar_url": ""}}

@app.post("/auth/login", response_model=TokenResponse)
def login(req: LoginRequest):
    admin_email = os.getenv("ADMIN_EMAIL")
    admin_password = os.getenv("ADMIN_PASSWORD")
    identifier = req.identifier.strip()
    is_email = "@" in identifier

    if is_email and identifier == admin_email and req.password == admin_password:
        mdb_record_login(0, "admin", admin_email, "email", "admin")
        token = create_jwt_token({"user_id": 0, "username": "admin", "email": admin_email, "role": "admin"})
        return {"token": token, "user": {"id": 0, "username": "admin", "email": admin_email, "role": "admin"}}

    matched_user = None
    if is_email:
        matched_user = mdb_get_user_by_email(identifier)
    else:
        phone_clean = re.sub(r"[\s\-\+\(\)]", "", identifier)
        matched_user = mdb_get_user_by_phone(phone_clean)

    if not matched_user:
        hint = "email" if is_email else "phone number"
        raise HTTPException(status_code=401, detail=f"No account found with this {hint}")

    u = matched_user
    stored_pwd = u.get("password", "")
    if not u.get("has_password") and stored_pwd == "":
        raise HTTPException(status_code=401, detail="This account uses Google Sign-In. Set a password first via Account Setup, or click 'Continue with Google'.")
    if stored_pwd and verify_password(req.password, stored_pwd):
        mdb_record_login(u["id"], u["username"], u["email"], "email", u.get("role", "user"))
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

    user = mdb_get_user_by_email(email)
    is_new_user = False
    if not user:
        is_new_user = True
        uid = _next_id(col_users)
        base = re.sub(r"[^a-zA-Z0-9_]", "_", name.lower().replace(" ", "_")) or email.split("@")[0]
        username = base
        counter = 1
        while mdb_get_user_by_username(username):
            username = f"{base}{counter}"; counter += 1
        user = {"id": uid, "username": username, "email": email, "password": "", "has_password": False, "role": "user", "created_at": datetime.now().isoformat(), "google_id": gd.get("sub"), "avatar_url": picture, "display_name": name, "phone": ""}
        mdb_save_user(user)

    mdb_record_login(user["id"], user["username"], email, "google", user.get("role", "user"))
    tok = create_jwt_token({"user_id": user["id"], "username": user["username"], "email": email, "role": user.get("role", "user"), "display_name": user.get("display_name", name), "avatar_url": user.get("avatar_url", picture)})
    needs_setup = not user.get("has_password") or not user.get("phone")
    return {"token": tok, "user": {"id": user["id"], "username": user["username"], "email": email, "role": user.get("role", "user"), "display_name": user.get("display_name", name), "avatar_url": user.get("avatar_url", picture)}, "is_new_user": is_new_user, "needs_setup": needs_setup}

@app.get("/auth/me")
def get_me(cu: dict = Depends(get_current_user)):
    u = mdb_get_user_by_id(cu["user_id"])
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
    fields = {"password": hash_password(req.password), "has_password": True}
    if req.phone:
        fields["phone"] = req.phone
    mdb_update_user(cu["user_id"], fields)
    return {"ok": True}

@app.post("/auth/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    import secrets, string
    user = mdb_get_user_by_email(req.email)
    if not user:
        return {"ok": True, "message": "If this email exists, a reset code has been sent"}
    code = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(6))
    expires = (datetime.now() + timedelta(minutes=15)).isoformat()
    mdb_save_reset_token(req.email, {"code": code, "expires_at": expires, "user_id": user["id"]})
    return {"ok": True, "reset_code": code}

@app.post("/auth/reset-password")
def reset_password_endpoint(req: ResetPasswordRequest):
    email, entry = mdb_find_reset_token_by_code(req.code)
    if not entry:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    if _parse_dt(entry["expires_at"]) < datetime.now():
        raise HTTPException(status_code=400, detail="Reset code has expired")
    mdb_update_user(entry["user_id"], {"password": hash_password(req.password), "has_password": True})
    mdb_delete_reset_token(email)
    return {"ok": True}

# ── User Online Status ────────────────────────────────────

@app.post("/users/me/status")
def set_user_status(body: UserStatusUpdate, cu: dict = Depends(get_current_user)):
    mdb_set_status(cu["user_id"], cu.get("username", ""), cu.get("email", ""), body.status)
    return {"ok": True}

@app.get("/contacts")
def get_contacts(cu: dict = Depends(get_current_user)):
    users = mdb_get_users()
    user_status = mdb_get_user_status()
    my_nicknames = mdb_get_nicknames(str(cu["user_id"]))
    now = datetime.now()
    result = []
    for u in users:
        if u["id"] == cu["user_id"]:
            continue
        uid_str = str(u["id"])
        st = user_status.get(uid_str)
        if st:
            diff = (now - _parse_dt(st["updated_at"])).total_seconds()
            online = "online" if diff < 120 else ("away" if diff < 300 else "offline")
            last_seen = st["updated_at"]
        else:
            online = "offline"
            last_seen = None
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
    saved = mdb_get_saved_contacts(str(cu["user_id"]))
    return {"saved_contact_ids": saved}

@app.post("/contacts/{contact_id}/save")
def save_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    saved = mdb_get_saved_contacts(uid)
    if contact_id not in saved:
        saved.append(contact_id)
    mdb_save_saved_contacts(uid, saved)
    return {"ok": True}

@app.delete("/contacts/{contact_id}/save")
def unsave_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    saved = mdb_get_saved_contacts(uid)
    mdb_save_saved_contacts(uid, [c for c in saved if c != contact_id])
    return {"ok": True}

@app.get("/users/find-by-phone")
def find_user_by_phone(phone: str, cu: dict = Depends(get_current_user)):
    raw = re.sub(r"[^\d]", "", phone)
    if not raw:
        raise HTTPException(status_code=400, detail="Phone number required")
    search = raw[-10:] if len(raw) >= 10 else raw
    for u in mdb_get_users():
        stored_raw = re.sub(r"[^\d]", "", u.get("phone", ""))
        if not stored_raw:
            continue
        stored = stored_raw[-10:] if len(stored_raw) >= 10 else stored_raw
        if stored == search:
            if u["id"] == cu["user_id"]:
                raise HTTPException(status_code=400, detail="That's your own number")
            return {"id": u["id"], "username": u["username"], "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "about": u.get("about", "Hey there! I am using SPVB.")}
    raise HTTPException(status_code=404, detail="No SPVB user found with this phone number")

@app.put("/contacts/{contact_id}/nickname")
def set_nickname(contact_id: int, body: dict, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    mapping = mdb_get_nicknames(uid)
    nick = str(body.get("nickname", "")).strip()[:50]
    if nick:
        mapping[str(contact_id)] = nick
    else:
        mapping.pop(str(contact_id), None)
    mdb_save_nicknames(uid, mapping)
    return {"ok": True, "nickname": nick}

@app.post("/contacts/{contact_id}/block")
def block_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    ids = mdb_get_blocked(uid)
    if contact_id not in ids:
        ids.append(contact_id)
    mdb_save_blocked(uid, ids)
    return {"ok": True}

@app.delete("/contacts/{contact_id}/block")
def unblock_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    ids = mdb_get_blocked(uid)
    mdb_save_blocked(uid, [x for x in ids if x != contact_id])
    return {"ok": True}

@app.get("/contacts/blocked")
def get_blocked_contacts(cu: dict = Depends(get_current_user)):
    ids = mdb_get_blocked(str(cu["user_id"]))
    result = []
    for uid in ids:
        u = mdb_get_user_by_id(uid)
        if u:
            result.append({"id": u["id"], "username": u["username"], "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", "")})
    return result

@app.put("/auth/me")
def update_me(body: dict, cu: dict = Depends(get_current_user)):
    u = mdb_get_user_by_id(cu["user_id"])
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    fields = {}
    if "display_name" in body:
        fields["display_name"] = str(body["display_name"])[:50]
    if "about" in body:
        fields["about"] = str(body["about"])[:140]
    if "phone" in body:
        raw = re.sub(r"[^\d]", "", str(body["phone"]))
        if len(raw) > 15:
            raise HTTPException(status_code=400, detail="Invalid phone number")
        fields["phone"] = raw
    if "cover_url" in body:
        fields["cover_url"] = str(body["cover_url"])[:500]
    if "avatar_url" in body:
        fields["avatar_url"] = str(body["avatar_url"])[:500]
    mdb_update_user(cu["user_id"], fields)
    u.update(fields)
    return {"ok": True, "user": {"id": u["id"], "username": u["username"], "email": u["email"], "phone": u.get("phone", ""), "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "cover_url": u.get("cover_url", ""), "about": u.get("about", "")}}

# ── Messages ──────────────────────────────────────────────

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
            conversations[contact_id] = {"contact_id": contact_id, "last_message": msg["content"], "created_at": msg["created_at"], "from_me": msg["from_user_id"] == my_id}
    for cid, conv in conversations.items():
        conv["unread_count"] = unread_per_contact.get(cid, 0)
        conv["all_sent_read"] = not sent_any_unread.get(cid, False) if sent_any_msg.get(cid) else False
    return conversations

@app.put("/messages/read/{contact_id}")
async def mark_messages_read(contact_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    marked_ids = db_mark_messages_read(contact_id, my_id)
    if marked_ids:
        await ws_manager.send(str(contact_id), {"type": "read_receipt", "by": my_id, "message_ids": marked_ids})
    return {"ok": True, "count": len(marked_ids)}

@app.get("/messages/conversation/{contact_id}")
def get_conversation(contact_id: int, since_id: int = 0, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    room = f"dm_{min(my_id, contact_id)}_{max(my_id, contact_id)}"
    return db_get_messages_room(room, since_id)

@app.get("/users/online")
def get_online_users(cu: dict = Depends(get_current_user)):
    user_status = mdb_get_user_status()
    now = datetime.now()
    result = {}
    for uid, info in user_status.items():
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

    users = mdb_get_users()
    user_status = mdb_get_user_status()
    events = mdb_get_login_events()
    now = datetime.now()
    today = now.date().isoformat()

    online_users = []
    for uid, info in user_status.items():
        diff = (now - _parse_dt(info["updated_at"])).total_seconds()
        online_users.append({"user_id": uid, "username": info.get("username", ""), "email": info.get("email", ""), "online_status": "online" if diff < 120 else ("away" if diff < 300 else "offline"), "last_seen": info["updated_at"]})
    online_users.sort(key=lambda x: x["online_status"])

    logins_today = [e for e in events if e["timestamp"].startswith(today)]
    logins_week = [e for e in events if _parse_dt(e["timestamp"]) > now - timedelta(days=7)]
    active_user_ids = {e["user_id"] for e in logins_week}
    email_logins = sum(1 for e in events if e.get("method") == "email")
    google_logins = sum(1 for e in events if e.get("method") == "google")
    register_events = sum(1 for e in events if e.get("method") == "register")

    return {
        "total_users": len(users),
        "total_items": 0,
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
        "recent_logins": list(reversed(events[-50:])),
    }

# ── Messages POST ─────────────────────────────────────────

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

# ── Upload ────────────────────────────────────────────────

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

# ── Statuses ──────────────────────────────────────────────

@app.post("/statuses")
async def create_status(body: StatusRequest, cu: dict = Depends(get_current_user)):
    mdb_cleanup_expired_statuses()
    user = mdb_get_user_by_id(cu["user_id"]) or {}
    new_id = mdb_next_status_id()
    s = {
        "id": new_id,
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
        "view_count": 0,
        "viewed_by": [],
        "reactions": [],
    }
    mdb_save_status(s)
    for uid in list(ws_manager.connections.keys()):
        if int(uid) != cu["user_id"]:
            await ws_manager.send(uid, {"type": "new_status", "status": s})
    return s

@app.get("/statuses")
def get_statuses(cu: dict = Depends(get_current_user)):
    mdb_cleanup_expired_statuses()
    now = datetime.utcnow()
    all_statuses = mdb_get_statuses()
    users = {u["id"]: u for u in mdb_get_users()}
    result = []
    for s in all_statuses:
        if _parse_dt(s["expires_at"]) <= now:
            continue
        entry = dict(s)
        if s["user_id"] == cu["user_id"]:
            viewers = []
            for uid in s.get("viewed_by", []):
                u = users.get(uid)
                if u:
                    viewers.append({"id": uid, "name": u.get("display_name") or u.get("username", f"User {uid}")})
            entry["viewers"] = viewers
        result.append(entry)
    return result

@app.delete("/statuses/{status_id}")
def delete_status(status_id: int, cu: dict = Depends(get_current_user)):
    s = mdb_get_status_by_id(status_id)
    if not s:
        raise HTTPException(status_code=404, detail="Status not found")
    if s["user_id"] != cu["user_id"]:
        raise HTTPException(status_code=403, detail="Not your status")
    if s.get("video_url"):
        try:
            fname = s["video_url"].replace("/uploads/", "")
            fpath = UPLOADS_DIR / fname
            if fpath.exists():
                fpath.unlink()
        except Exception:
            pass
    mdb_delete_status(status_id)
    return {"ok": True}

@app.post("/statuses/{status_id}/view")
def view_status(status_id: int, cu: dict = Depends(get_current_user)):
    s = mdb_get_status_by_id(status_id)
    if not s:
        return {"ok": True}
    viewer_id = cu["user_id"]
    if viewer_id not in s.get("viewed_by", []) and viewer_id != s["user_id"]:
        viewed_by = s.get("viewed_by", []) + [viewer_id]
        mdb_save_status({**s, "viewed_by": viewed_by, "view_count": len(viewed_by)})
        return {"view_count": len(viewed_by)}
    return {"view_count": s.get("view_count", 0)}

@app.post("/statuses/{status_id}/react")
async def react_status(status_id: int, body: dict, cu: dict = Depends(get_current_user)):
    s = mdb_get_status_by_id(status_id)
    if not s:
        return {"ok": True}
    emoji = str(body.get("emoji", "")).strip()
    user_obj = mdb_get_user_by_id(cu["user_id"]) or {}
    reactor_name = user_obj.get("display_name") or user_obj.get("username", f"User {cu['user_id']}")
    reactions = [r for r in s.get("reactions", []) if r["user_id"] != cu["user_id"]]
    if emoji:
        reactions.append({"user_id": cu["user_id"], "name": reactor_name, "emoji": emoji})
    mdb_save_status({**s, "reactions": reactions})
    await ws_manager.send(str(s["user_id"]), {"type": "status_reaction", "status_id": status_id, "reactions": reactions, "reactor_name": reactor_name, "emoji": emoji})
    return {"ok": True, "reactions": reactions}

# ── Call Logs ─────────────────────────────────────────────

@app.post("/call-logs")
def save_call_log(body: dict, cu: dict = Depends(get_current_user)):
    contact_id = int(body.get("contact_id", 0))
    contact = mdb_get_user_by_id(contact_id)
    now = datetime.utcnow()
    log = {
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
    return mdb_save_call_log(log)

@app.get("/call-logs")
def get_call_logs(cu: dict = Depends(get_current_user)):
    return mdb_get_call_logs(cu["user_id"])

# ── Phone Contact Sync ────────────────────────────────────

@app.post("/contacts/sync-phones")
def sync_phone_contacts(body: dict, cu: dict = Depends(get_current_user)):
    phones = body.get("phones", [])
    if not isinstance(phones, list):
        raise HTTPException(status_code=400, detail="phones must be a list")
    my_id = cu["user_id"]
    users = mdb_get_users()
    matched = []
    seen_ids = set()
    for phone in phones[:500]:
        raw = re.sub(r"[^\d]", "", str(phone))
        if not raw:
            continue
        raw10 = raw[-10:]
        for u in users:
            if u["id"] == my_id or u["id"] in seen_ids:
                continue
            stored = re.sub(r"[^\d]", "", u.get("phone", ""))
            if stored and (stored[-10:] == raw10):
                matched.append({"id": u["id"], "username": u["username"], "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "phone": u.get("phone", "")})
                seen_ids.add(u["id"])
                break
    return matched

# ── Users CRUD ────────────────────────────────────────────

@app.post("/users", response_model=dict)
def create_user(user: User, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    uid = _next_id(col_users)
    new_user = {**user.model_dump(mode="json"), "id": uid, "created_at": datetime.now().isoformat(), "password": hash_password(user.password)}
    mdb_save_user(new_user)
    return {"id": uid, "message": "User created"}

@app.get("/users")
def get_users(cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    users = mdb_get_users()
    user_status = mdb_get_user_status()
    events = mdb_get_login_events()
    now = datetime.now()
    result = []
    for u in users:
        uid_str = str(u["id"])
        st = user_status.get(uid_str)
        if st:
            diff = (now - _parse_dt(st["updated_at"])).total_seconds()
            online = "online" if diff < 120 else ("away" if diff < 300 else "offline")
            last_seen = st["updated_at"]
        else:
            online = "never"
            last_seen = None
        login_count = sum(1 for e in events if e["user_id"] == u["id"])
        last_login = next((e["timestamp"] for e in reversed(events) if e["user_id"] == u["id"]), None)
        result.append({"id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "created_at": u.get("created_at"), "avatar_url": u.get("avatar_url", ""), "display_name": u.get("display_name", ""), "online_status": online, "last_seen": last_seen, "login_count": login_count, "last_login": last_login})
    return result

@app.get("/users/{user_id}")
def get_user(user_id: int, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    u = mdb_get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return {"id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "created_at": u.get("created_at")}

@app.put("/users/{user_id}")
def update_user(user_id: int, user: User, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    existing = mdb_get_user_by_id(user_id)
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")
    updated = {**existing, "username": user.username, "email": user.email, "password": hash_password(user.password)}
    mdb_save_user(updated)
    return {"id": user_id, "message": "User updated"}

@app.delete("/users/{user_id}")
def delete_user(user_id: int, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    mdb_delete_user(user_id)
    return {"message": "User deleted"}

# ── Items CRUD ────────────────────────────────────────────

col_items = mdb["items"]
col_items.create_index("id", unique=True)

@app.post("/items")
def create_item(item: Item, cu: dict = Depends(get_current_user)):
    iid = _next_id(col_items)
    doc = item.model_dump(mode="json")
    doc["id"] = iid
    doc["created_at"] = datetime.now().isoformat()
    col_items.insert_one(doc)
    return {"id": iid, "message": "Item created"}

@app.get("/items")
def get_items(cu: dict = Depends(get_current_user)):
    return [{k: v for k, v in i.items() if k != "_id"} for i in col_items.find()]

@app.get("/items/{item_id}")
def get_item(item_id: int, cu: dict = Depends(get_current_user)):
    item = col_items.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item

@app.put("/items/{item_id}")
def update_item(item_id: int, item: Item, cu: dict = Depends(get_current_user)):
    existing = col_items.find_one({"id": item_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Item not found")
    doc = item.model_dump(mode="json")
    doc["id"] = item_id
    doc["created_at"] = existing.get("created_at")
    col_items.replace_one({"id": item_id}, doc)
    return {"id": item_id, "message": "Item updated"}

@app.delete("/items/{item_id}")
def delete_item(item_id: int, cu: dict = Depends(get_current_user)):
    col_items.delete_one({"id": item_id})
    return {"message": "Item deleted"}

# ── Smart Reply ───────────────────────────────────────────

class SmartReplyRequest(BaseModel):
    messages: List[dict]

def _compute_smart_replies(last_bot: str, last_user: str) -> list:
    b = last_bot.lower()
    u = last_user.lower()
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
    if re.search(r'\?', b):
        return ["Yes! 👍", "Not really...", "Tell me more 💬"]
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
    pools = [
        ["Got it! 👍", "Tell me more 💬", "Interesting! 🤔"],
        ["Sounds good! ✅", "Really? 😮", "Nice! 😊"],
        ["That's great! 🎉", "I see 🤔", "Continue... 💬"],
        ["Okay! 👍", "What else? 🤔", "Thanks 😊"],
        ["Noted! ✅", "Tell me more!", "Wow! 😮"],
    ]
    return _random.choice(pools)

# ── Group Chat ────────────────────────────────────────────

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
    my_id = cu["user_id"]
    user_map = {u["id"]: u for u in mdb_get_users()}
    members = [my_id] + [m for m in body.member_ids if m != my_id and m in user_map]
    members = list(dict.fromkeys(members))
    new_id = mdb_next_group_id()
    group = {"id": new_id, "name": body.name[:100], "creator_id": my_id, "members": members, "created_at": datetime.utcnow().isoformat() + "Z", "avatar_url": ""}
    mdb_save_group(group)
    for mid in members:
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_created", "group": {**group, "member_details": _group_member_details(members, user_map)}})
    return {**group, "member_details": _group_member_details(members, user_map)}

@app.get("/groups")
def get_groups(cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    user_map = {u["id"]: u for u in mdb_get_users()}
    result = []
    for g in mdb_get_groups():
        if my_id not in g.get("members", []):
            continue
        gmsgs = mdb_get_group_messages(g["id"])
        last = gmsgs[-1] if gmsgs else None
        result.append({**g, "member_details": _group_member_details(g.get("members", []), user_map), "last_message": last.get("content", "") if last else "", "last_message_time": last.get("created_at", "") if last else ""})
    return result

@app.get("/groups/{group_id}/messages")
def get_group_messages(group_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    user_map = {u["id"]: u for u in mdb_get_users()}
    msgs = mdb_get_group_messages(group_id)
    return [{**m, "sender_name": user_map[m["from_user_id"]].get("display_name", user_map[m["from_user_id"]]["username"]) if m["from_user_id"] in user_map else str(m["from_user_id"]), "sender_avatar": user_map[m["from_user_id"]].get("avatar_url", "") if m["from_user_id"] in user_map else ""} for m in msgs]

@app.post("/groups/{group_id}/messages")
async def send_group_message(group_id: int, body: GroupMessageRequest, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    user_map = {u["id"]: u for u in mdb_get_users()}
    now = datetime.utcnow()
    msg = {"group_id": group_id, "from_user_id": my_id, "content": body.content[:4000], "media_url": None, "media_type": None, "file_name": None, "reply_to": body.reply_to, "created_at": now.isoformat() + "Z", "expires_at": (now + timedelta(hours=24)).isoformat() + "Z"}
    msg = mdb_save_group_message(msg)
    sender_name = user_map[my_id].get("display_name", user_map[my_id]["username"]) if my_id in user_map else str(my_id)
    sender_avatar = user_map[my_id].get("avatar_url", "") if my_id in user_map else ""
    broadcast = {**msg, "sender_name": sender_name, "sender_avatar": sender_avatar}
    for mid in group.get("members", []):
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_message", "message": broadcast, "group_id": group_id, "group_name": group["name"]})
    return broadcast

@app.post("/groups/{group_id}/media")
async def send_group_media(group_id: int, file: UploadFile = File(...), cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
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
    user_map = {u["id"]: u for u in mdb_get_users()}
    now = datetime.utcnow()
    msg = {"group_id": group_id, "from_user_id": my_id, "content": "", "media_url": url, "media_type": mtype, "file_name": file.filename, "reply_to": None, "created_at": now.isoformat() + "Z", "expires_at": (now + timedelta(hours=24)).isoformat() + "Z"}
    msg = mdb_save_group_message(msg)
    sender_name = user_map[my_id].get("display_name", user_map[my_id]["username"]) if my_id in user_map else str(my_id)
    sender_avatar = user_map[my_id].get("avatar_url", "") if my_id in user_map else ""
    broadcast = {**msg, "sender_name": sender_name, "sender_avatar": sender_avatar}
    for mid in group.get("members", []):
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_message", "message": broadcast, "group_id": group_id, "group_name": group["name"]})
    return broadcast

@app.put("/groups/{group_id}")
def update_group(group_id: int, body: dict, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    if "name" in body:
        group["name"] = str(body["name"])[:100]
    if "avatar_url" in body:
        group["avatar_url"] = str(body["avatar_url"])
    mdb_save_group(group)
    return group

@app.delete("/groups/{group_id}/members/{user_id}")
def remove_group_member(group_id: int, user_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    if user_id != my_id and group.get("creator_id") != my_id:
        raise HTTPException(status_code=403, detail="Only creator can remove others")
    group["members"] = [m for m in group["members"] if m != user_id]
    mdb_save_group(group)
    return group

@app.post("/groups/{group_id}/members")
def add_group_member(group_id: int, body: dict, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    uid = int(body.get("user_id", 0))
    if uid and uid not in group["members"] and mdb_get_user_by_id(uid):
        group["members"].append(uid)
        mdb_save_group(group)
    return group

# ── QR Device Linking ──────────────────────────────────────

import secrets as _secrets

@app.post("/devices/qr/generate")
async def generate_qr_token(cu: dict = Depends(get_current_user)):
    token = _secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(minutes=10)).isoformat()
    mdb_save_qr_token(token, {"user_id": cu["user_id"], "status": "pending", "created_at": datetime.utcnow().isoformat(), "expires_at": expires_at, "approved": False})
    return {"token": token, "expires_at": expires_at}

@app.get("/devices/qr/{token}/status")
async def qr_token_status(token: str):
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found or expired")
    if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="Token expired")
    return {"status": rec["status"], "approved": rec.get("approved", False)}

@app.post("/devices/qr/{token}/scan")
async def scan_qr_token(token: str, request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="QR code not found. Please generate a new one.")
    if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="QR code expired. Please generate a new one.")
    if rec["status"] not in ("pending", "scanned"):
        raise HTTPException(status_code=409, detail="QR code already used.")
    device_name = body.get("device_name", "Unknown Device")
    rec["status"] = "scanned"
    rec["scanner_device"] = device_name
    rec["scanner_user_agent"] = body.get("user_agent", "")
    mdb_save_qr_token(token, {k: v for k, v in rec.items() if k != "token"})
    await ws_manager.send(str(rec["user_id"]), {"type": "qr_link_request", "token": token, "device_name": device_name, "user_agent": body.get("user_agent", "")})
    return {"status": "scanned", "message": "Approval request sent to primary device"}

@app.post("/devices/qr/{token}/approve")
async def approve_qr_token(token: str, cu: dict = Depends(get_current_user)):
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found or expired")
    if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="Token expired")
    if cu["user_id"] != rec["user_id"]:
        raise HTTPException(status_code=403, detail="Not your token")
    user = mdb_get_user_by_id(rec["user_id"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    token_data = {"user_id": user["id"], "username": user["username"], "email": user["email"], "role": user.get("role", "user"), "display_name": user.get("display_name", user["username"]), "avatar_url": user.get("avatar_url", "")}
    new_jwt = create_jwt_token(token_data)
    device_id = _secrets.token_urlsafe(16)
    mdb_save_device({"id": device_id, "user_id": user["id"], "device_name": rec.get("scanner_device", "Linked Device"), "user_agent": rec.get("scanner_user_agent", ""), "linked_at": datetime.utcnow().isoformat()})
    rec.update({"status": "approved", "approved": True, "jwt": new_jwt})
    mdb_save_qr_token(token, {k: v for k, v in rec.items() if k != "token"})
    await ws_manager.send(f"qr_{token}", {"type": "qr_approved", "token": token, "jwt": new_jwt, "user": token_data})
    return {"status": "approved"}

@app.post("/devices/qr/{token}/reject")
async def reject_qr_token(token: str, cu: dict = Depends(get_current_user)):
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found")
    if cu["user_id"] != rec["user_id"]:
        raise HTTPException(status_code=403, detail="Not your token")
    rec["status"] = "rejected"
    mdb_save_qr_token(token, {k: v for k, v in rec.items() if k != "token"})
    await ws_manager.send(f"qr_{token}", {"type": "qr_rejected", "token": token})
    return {"status": "rejected"}

@app.get("/devices/qr/{token}/await")
async def await_qr_approval(token: str):
    for _ in range(30):
        rec = mdb_get_qr_token(token)
        if not rec:
            raise HTTPException(status_code=404, detail="Token not found")
        if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
            raise HTTPException(status_code=410, detail="Token expired")
        if rec["status"] == "approved":
            return {"status": "approved", "jwt": rec.get("jwt", "")}
        if rec["status"] == "rejected":
            return {"status": "rejected"}
        await asyncio.sleep(1)
    return {"status": "pending"}

@app.get("/devices")
async def list_devices(cu: dict = Depends(get_current_user)):
    return mdb_get_devices(cu["user_id"])

@app.delete("/devices/{device_id}")
async def remove_device(device_id: str, cu: dict = Depends(get_current_user)):
    if not mdb_delete_device(device_id, cu["user_id"]):
        raise HTTPException(status_code=404, detail="Device not found")
    return {"status": "removed"}

# ── Smart Reply ───────────────────────────────────────────

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
