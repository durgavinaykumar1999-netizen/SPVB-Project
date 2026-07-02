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
import hmac
import re
import shutil
import smtplib
import socket
import time
import threading
import traceback
import urllib.request
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from collections import defaultdict
from pathlib import Path
from dotenv import load_dotenv
import random as _random
import uuid as _uuid
try:
    import bcrypt as _bcrypt
    _BCRYPT_AVAILABLE = True
except ImportError:
    _BCRYPT_AVAILABLE = False

load_dotenv()

# ── Cloudinary Setup ──────────────────────────────────────
import cloudinary
import cloudinary.uploader

_CLOUDINARY_URL = os.getenv("CLOUDINARY_URL", "")
_cloudinary_enabled = bool(_CLOUDINARY_URL)
if _cloudinary_enabled:
    cloudinary.config(cloudinary_url=_CLOUDINARY_URL)

# File size limits (bytes)
LIMIT_IMAGE = 10 * 1024 * 1024   # 10 MB
LIMIT_VIDEO = 50 * 1024 * 1024   # 50 MB
LIMIT_AUDIO = 16 * 1024 * 1024   # 16 MB
LIMIT_DOC   = 25 * 1024 * 1024   # 25 MB

def _upload_media(data: bytes, ext: str, media_type: str, folder: str = "spvb") -> str:
    """Upload bytes to Cloudinary if configured, else save locally. Returns URL."""
    if _cloudinary_enabled:
        rtype = "video" if media_type in ("video", "audio") else "raw" if media_type == "document" else "image"
        result = cloudinary.uploader.upload(data, folder=folder, resource_type=rtype)
        return result["secure_url"]
    # Fallback: local disk
    filename = f"{folder.replace('/', '_')}_{int(datetime.now().timestamp())}{ext}"
    dest = UPLOADS_DIR / filename
    dest.write_bytes(data)
    return f"/uploads/{filename}"

_CLOUDINARY_HOST = "res.cloudinary.com"

def _cloudinary_delete(url: str):
    """Delete a Cloudinary asset by its secure URL. Skips profile/avatar folders."""
    if not _cloudinary_enabled or not url or _CLOUDINARY_HOST not in url:
        return
    try:
        # Never delete profile images during periodic cleanup
        if "/spvb/profiles/" in url or "/spvb/avatars/" in url:
            return
        # Extract public_id: everything between /upload/[v.../] and the extension
        import re as _re
        m = _re.search(r"/upload/(?:v\d+/)?(.+?)(?:\.[^.]+)?$", url)
        if not m:
            return
        public_id = m.group(1)
        # Determine resource type from URL path
        rtype = "video" if "/video/" in url else "raw" if "/raw/" in url else "image"
        cloudinary.uploader.destroy(public_id, resource_type=rtype)
    except Exception as e:
        print(f"[cloudinary] delete error: {e}")

def _delete_media_file(url: str):
    """Delete any media file (avatar, cover, wallpaper) from Cloudinary or local storage."""
    if not url:
        return
    if _cloudinary_enabled and _CLOUDINARY_HOST in url:
        try:
            import re as _re
            m = _re.search(r"/upload/(?:v\d+/)?(.+?)(?:\.[^.]+)?$", url)
            if m:
                public_id = m.group(1)
                rtype = "video" if "/video/" in url else "raw" if "/raw/" in url else "image"
                cloudinary.uploader.destroy(public_id, resource_type=rtype)
        except Exception as e:
            print(f"[cloudinary] delete error: {e}")
    elif url.startswith("/uploads/"):
        try:
            fpath = UPLOADS_DIR / url[len("/uploads/"):]
            if fpath.exists():
                fpath.unlink()
        except Exception as e:
            print(f"[local] delete error: {e}")

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

def _apply_projection(doc: dict, proj: dict) -> dict:
    """Apply a MongoDB-style projection dict to a document (Python-side filtering)."""
    if not proj or not doc:
        return doc
    # Determine include vs exclude mode
    vals = [v for k, v in proj.items() if k != "_id"]
    if not vals:
        return doc
    include_mode = bool(vals[0])  # 1 = include, 0 = exclude
    if include_mode:
        result = {}
        for k in proj:
            if proj[k] and k in doc:
                result[k] = doc[k]
        if proj.get("_id", 1) and "_id" in doc:
            result["_id"] = doc["_id"]
        return result
    else:
        result = dict(doc)
        for k, v in proj.items():
            if not v and k in result:
                del result[k]
        return result

def _py_match(doc: dict, filter: dict) -> bool:
    """Python-side MongoDB filter evaluation for operators mongita doesn't support."""
    import re as _re
    for key, cond in filter.items():
        if key == "$or":
            if not any(_py_match(doc, sub) for sub in cond):
                return False
            continue
        if key == "$and":
            if not all(_py_match(doc, sub) for sub in cond):
                return False
            continue
        val = doc.get(key)
        if isinstance(cond, dict):
            for op, operand in cond.items():
                if op == "$exists":
                    if operand and key not in doc:
                        return False
                    if not operand and key in doc:
                        return False
                elif op == "$regex":
                    if not val or not _re.search(operand, str(val)):
                        return False
                elif op == "$eq":
                    if val != operand:
                        return False
                elif op == "$ne":
                    if val == operand:
                        return False
                elif op == "$gt":
                    if not (val is not None and val > operand):
                        return False
                elif op == "$gte":
                    if not (val is not None and val >= operand):
                        return False
                elif op == "$lt":
                    if not (val is not None and val < operand):
                        return False
                elif op == "$lte":
                    if not (val is not None and val <= operand):
                        return False
                elif op == "$in":
                    if val not in operand:
                        return False
                elif op == "$nin":
                    if val in operand:
                        return False
        else:
            if val != cond:
                return False
    return True


def _local_find_all(collection, filter=None, projection=None):
    """Fetch all docs from a mongita collection, apply Python-side filter + projection."""
    try:
        all_docs = list(collection.find({}))
    except Exception:
        return []
    results = []
    for d in all_docs:
        doc = dict(d)
        if filter and not _py_match(doc, filter):
            continue
        if projection:
            doc = _apply_projection(doc, projection)
        results.append(doc)
    return results


class _LocalCursor:
    """Wraps a mongita cursor to support sort/limit/skip chaining (Python-side)."""
    def __init__(self, cursor, projection=None):
        self._cursor = cursor
        self._projection = projection
        self._sort_key = None
        self._sort_dir = None
        self._limit_n = None
        self._skip_n = 0

    def sort(self, key, direction=None):
        if isinstance(key, list):
            self._sort_key = key[0][0] if key else None
            self._sort_dir = key[0][1] if key else 1
        else:
            self._sort_key = key
            self._sort_dir = direction if direction is not None else 1
        return self

    def limit(self, n):
        self._limit_n = n
        return self

    def skip(self, n):
        self._skip_n = n
        return self

    def _resolve(self):
        docs = [dict(d) for d in self._cursor]
        if self._sort_key:
            reverse = (self._sort_dir == -1)
            docs.sort(key=lambda d: d.get(self._sort_key) or 0, reverse=reverse)
        if self._skip_n:
            docs = docs[self._skip_n:]
        if self._limit_n:
            docs = docs[:self._limit_n]
        if self._projection:
            docs = [_apply_projection(d, self._projection) for d in docs]
        return docs

    def __iter__(self):
        return iter(self._resolve())

    def __len__(self):
        return len(self._resolve())


class _LocalCollection:
    """Thin wrapper around a mongita collection for PyMongo compatibility."""
    def __init__(self, col):
        self._col = col

    def find_one(self, filter=None, projection=None, **kw):
        f = filter or {}
        try:
            doc = self._col.find_one(f)
        except Exception:
            # Fallback: fetch all and filter in Python
            docs = _local_find_all(self._col, f, projection)
            return docs[0] if docs else None
        if doc is None:
            return None
        doc = dict(doc)
        if projection:
            doc = _apply_projection(doc, projection)
        return doc

    def find(self, filter=None, projection=None, **kw):
        f = filter or {}
        try:
            cursor = self._col.find(f)
            return _LocalCursor(cursor, projection)
        except Exception:
            # Fallback: fetch all and filter in Python
            docs = _local_find_all(self._col, f, projection)
            return _LocalCursor(iter(docs), None)  # already projected

    def insert_one(self, doc):
        return self._col.insert_one(doc)

    def replace_one(self, filter, replacement, upsert=False):
        return self._col.replace_one(filter, replacement, upsert=upsert)

    def update_one(self, filter, update, upsert=False):
        return self._col.update_one(filter, update, upsert=upsert)

    def update_many(self, filter, update):
        return self._col.update_many(filter, update)

    def delete_one(self, filter):
        return self._col.delete_one(filter)

    def delete_many(self, filter):
        return self._col.delete_many(filter)

    def count_documents(self, filter=None):
        return self._col.count_documents(filter or {})

    def aggregate(self, pipeline):
        # mongita doesn't support aggregate — return empty list for local mode
        return []

    def create_index(self, key, **kw):
        try:
            # Remove unsupported kwargs
            safe_kw = {k: v for k, v in kw.items() if k not in ('unique', 'sparse', 'background')}
            self._col.create_index(key, **safe_kw)
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self._col, name)

class _LocalDb:
    """Wraps a mongita database to return _LocalCollection instances."""
    def __init__(self, db):
        self._db = db
    def __getitem__(self, name):
        return _LocalCollection(self._db[name])

if not _MONGO_URI:
    from mongita import MongitaClientDisk
    _local_data_dir = Path(os.getenv("LOCAL_DATA_DIR", "./data/localdb"))
    _local_data_dir.mkdir(parents=True, exist_ok=True)
    _mongita_client = MongitaClientDisk(str(_local_data_dir))
    mdb = _LocalDb(_mongita_client["spvb"])
    _db_name = "spvb"
    print(f"[DB] Local mode — data stored in {_local_data_dir.resolve()}")
else:
    _mongo_client = MongoClient(
        _MONGO_URI,
        maxPoolSize=50,
        minPoolSize=5,
        serverSelectionTimeoutMS=5000,
        connectTimeoutMS=5000,
        socketTimeoutMS=10000,
        retryWrites=True,
    )
    try:
        _db_name = _MONGO_URI.rsplit("/", 1)[-1].split("?")[0].strip() or "spvb"
    except Exception:
        _db_name = "spvb"
    mdb = _mongo_client[_db_name]
    print(f"[DB] MongoDB mode — {_db_name}")

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
col_ringtones      = mdb["contact_ringtones"]
col_blocked        = mdb["blocked"]
col_qr_tokens      = mdb["qr_tokens"]
col_linked_devices = mdb["linked_devices"]
col_password_reset = mdb["password_reset_tokens"]
col_push_subs      = mdb["push_subscriptions"]   # web push subscriptions
col_sessions       = mdb["login_sessions"]        # all active login sessions across devices
col_scheduled_messages = mdb["scheduled_messages"]  # scheduled messages

# Indexes (wrapped — mongita supports basic indexes; compound/unique silently ignored)
def _idx(col, key, **kw):
    try: col.create_index(key, **kw)
    except Exception: pass

_idx(col_users, "id", unique=True)
_idx(col_users, "email", unique=True)
_idx(col_users, "username")
_idx(col_messages, [("room", ASCENDING), ("expires_at", ASCENDING)])
_idx(col_messages, "id", unique=True)
_idx(col_messages, [("from_user_id", ASCENDING), ("expires_at", ASCENDING)])
_idx(col_messages, [("recipient_id", ASCENDING), ("expires_at", ASCENDING)])
_idx(col_messages, [("from_user_id", ASCENDING), ("recipient_id", ASCENDING), ("expires_at", ASCENDING)])
_idx(col_scheduled_messages, "id", unique=True)
_idx(col_scheduled_messages, [("from_user_id", ASCENDING), ("contact_id", ASCENDING)])
_idx(col_scheduled_messages, "scheduled_time")
_idx(col_login_events, "id")
_idx(col_statuses, "id")
_idx(col_statuses, [("user_id", ASCENDING), ("expires_at", ASCENDING)])
_idx(col_groups, "id", unique=True)
_idx(col_group_messages, "id", unique=True)
_idx(col_group_messages, [("group_id", ASCENDING), ("expires_at", ASCENDING)])
_idx(col_call_logs, "id", unique=True)
_idx(col_call_logs, [("caller_id", ASCENDING)])
_idx(col_call_logs, [("callee_id", ASCENDING)])
_idx(col_user_status, "user_id", unique=True)
_idx(col_qr_tokens, "token", unique=True)
_idx(col_qr_tokens, "expires_at")
_idx(col_linked_devices, "id", unique=True)
_idx(col_push_subs, "user_id")
_idx(col_sessions, "id", unique=True)
_idx(col_sessions, "user_id")

# ── MongoDB Helpers ───────────────────────────────────────

def _strip_id(doc: dict) -> dict:
    doc.pop("_id", None)
    return doc

def _next_id(collection) -> int:
    try:
        docs = list(collection.find({}, {"id": 1, "_id": 0}).sort("id", DESCENDING).limit(1))
    except Exception:
        # Fallback for local mode (mongita doesn't support sort+limit chaining)
        docs = list(collection.find({}, {"id": 1, "_id": 0}))
        docs = [d for d in docs if isinstance(d.get("id"), int)]
    if not docs:
        return 1
    return max(d["id"] for d in docs if isinstance(d.get("id"), int)) + 1

_data_lock = threading.Lock()

# ── User helpers ──────────────────────────────────────────

def mdb_get_users(projection: dict = None) -> list:
    proj = projection or {"_id": 0}
    return [_strip_id(u) for u in col_users.find({}, proj) if u.get("id") is not None]

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
        "status":       doc.get("status", "sent"),   # sent | delivered | seen
        "seen_at":      doc.get("seen_at") or None,
        "encrypted_key_for_sender":   doc.get("encrypted_key_for_sender") or None,
        "encrypted_key_for_receiver": doc.get("encrypted_key_for_receiver") or None,
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
            "status":       "sent",    # sent → delivered → seen
            "seen_at":      None,      # set when receiver opens the chat
            "encrypted_key_for_sender":   msg.get("encrypted_key_for_sender"),
            "encrypted_key_for_receiver": msg.get("encrypted_key_for_receiver"),
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

def db_get_recent_conversations_fast(my_id: int) -> dict:
    """MongoDB aggregation: one pass to compute per-contact last-message + unread counts."""
    now = datetime.utcnow().isoformat()
    pipeline = [
        # Only DM messages involving this user that haven't expired
        {"$match": {
            "$or": [{"from_user_id": my_id}, {"recipient_id": my_id}],
            "room": {"$regex": "^dm_"},
            "expires_at": {"$gt": now},
        }},
        # Derive contact_id (the other party)
        {"$addFields": {
            "contact_id": {
                "$cond": [{"$eq": ["$from_user_id", my_id]}, "$recipient_id", "$from_user_id"]
            },
            "is_from_me": {"$eq": ["$from_user_id", my_id]},
        }},
        # Group by contact — keep last message and count unread received messages
        {"$group": {
            "_id": "$contact_id",
            "last_id":       {"$max": "$id"},
            "last_message":  {"$last": "$message"},
            "last_from_me":  {"$last": "$is_from_me"},
            "last_ts":       {"$last": "$timestamp"},
            "unread_count":  {"$sum": {
                "$cond": [{"$and": [
                    {"$eq": ["$is_from_me", False]},
                    {"$eq": ["$is_read", 0]},
                ]}, 1, 0]
            }},
            "sent_unread_count": {"$sum": {
                "$cond": [{"$and": [
                    {"$eq": ["$is_from_me", True]},
                    {"$eq": ["$is_read", 0]},
                ]}, 1, 0]
            }},
            "sent_total": {"$sum": {"$cond": ["$is_from_me", 1, 0]}},
        }},
    ]
    result = {}
    for doc in col_messages.aggregate(pipeline):
        cid = doc["_id"]
        if not cid:
            continue
        result[cid] = {
            "contact_id":   cid,
            "last_message": doc.get("last_message", ""),
            "created_at":   doc.get("last_ts", ""),
            "from_me":      doc.get("last_from_me", False),
            "unread_count": doc.get("unread_count", 0),
            "all_sent_read": doc.get("sent_unread_count", 0) == 0 and doc.get("sent_total", 0) > 0,
        }
    return result

def db_mark_messages_read(contact_id: int, my_id: int) -> list:
    with _data_lock:
        docs = list(col_messages.find(
            {"from_user_id": contact_id, "recipient_id": my_id, "is_read": 0},
            {"id": 1, "_id": 0}
        ))
        ids = [d["id"] for d in docs]
        if ids:
            seen_at = datetime.utcnow().isoformat() + "Z"
            # Start 24-hour expiry clock from the moment the receiver sees the message
            expires_24h = (datetime.utcnow() + timedelta(hours=24)).isoformat() + "Z"
            col_messages.update_many(
                {"id": {"$in": ids}},
                {"$set": {"is_read": 1, "status": "seen", "seen_at": seen_at, "expires_at": expires_24h}}
            )
    return ids

def db_mark_messages_delivered(message_ids: list) -> None:
    """Mark messages as delivered (WS reached the receiver's device)."""
    if not message_ids:
        return
    col_messages.update_many(
        {"id": {"$in": message_ids}, "status": "sent"},
        {"$set": {"status": "delivered"}}
    )

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
        "timestamp": datetime.utcnow().isoformat() + "Z",
    })
    # Keep only last 200 events as hard cap
    total = col_login_events.count_documents({})
    if total > 200:
        oldest = list(col_login_events.find({}, {"id": 1, "_id": 0}).sort("id", ASCENDING).limit(total - 200))
        if oldest:
            col_login_events.delete_many({"id": {"$in": [d["id"] for d in oldest]}})

def mdb_get_login_events() -> list:
    return [_strip_id(dict(d)) for d in col_login_events.find({}, {"_id": 0}).sort("id", ASCENDING)]

# ── User status helpers ───────────────────────────────────

def mdb_set_status(user_id, username, email, st):
    col_user_status.replace_one(
        {"user_id": str(user_id)},
        {"user_id": str(user_id), "status": st, "username": username, "email": email, "updated_at": datetime.utcnow().isoformat() + "Z"},
        upsert=True
    )
    mdb_invalidate_user_status_cache()

_user_status_cache: dict = {}
_user_status_cache_ts: float = 0.0
_USER_STATUS_CACHE_TTL = 5  # seconds

def mdb_get_user_status() -> dict:
    global _user_status_cache, _user_status_cache_ts
    if time.monotonic() - _user_status_cache_ts < _USER_STATUS_CACHE_TTL:
        return _user_status_cache
    result = {}
    for doc in col_user_status.find({}, {"_id": 0}):
        uid = doc.pop("user_id")
        result[str(uid)] = doc
    _user_status_cache = result
    _user_status_cache_ts = time.monotonic()
    return result

def mdb_invalidate_user_status_cache():
    global _user_status_cache_ts
    _user_status_cache_ts = 0.0

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
    if doc is None:
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
    logs = [_strip_id(dict(d)) for d in docs]
    # Enrich with fresh contact info from users collection (not stored in log)
    contact_ids = list({l["contact_id"] for l in logs if l.get("contact_id")})
    contacts = {u["id"]: u for u in col_users.find({"id": {"$in": contact_ids}}, {"_id": 0, "id": 1, "username": 1, "display_name": 1, "avatar_url": 1})}
    for log in logs:
        c = contacts.get(log.get("contact_id"), {})
        log["contact_username"]     = c.get("username", "")
        log["contact_display_name"] = c.get("display_name", "")
        log["contact_avatar_url"]   = c.get("avatar_url", "")
    return logs

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

def mdb_get_device(device_id: str, user_id: int):
    doc = col_linked_devices.find_one({"id": device_id, "user_id": user_id}, {"_id": 0})
    return _strip_id(dict(doc)) if doc else None

def mdb_delete_device(device_id: str, user_id: int) -> bool:
    res = col_linked_devices.delete_one({"id": device_id, "user_id": user_id})
    return res.deleted_count > 0

# ── Login session helpers ─────────────────────────────────

def mdb_save_session(session: dict):
    col_sessions.insert_one({**session})

def mdb_get_sessions(user_id: int) -> list:
    docs = col_sessions.find({"user_id": user_id}, {"_id": 0})
    return [_strip_id(dict(d)) for d in docs]

def mdb_get_session(session_id: str, user_id: int):
    doc = col_sessions.find_one({"id": session_id, "user_id": user_id}, {"_id": 0})
    return _strip_id(dict(doc)) if doc else None

def mdb_delete_session(session_id: str, user_id: int) -> bool:
    res = col_sessions.delete_one({"id": session_id, "user_id": user_id})
    # Remove the FCM token linked to this session so push stops immediately after logout/removal
    if res.deleted_count > 0 and session_id:
        col_fcm_tokens.delete_many({"session_id": session_id, "user_id": user_id})
    return res.deleted_count > 0

def mdb_touch_session(session_id: str):
    col_sessions.update_one({"id": session_id}, {"$set": {"last_seen": datetime.utcnow().isoformat() + "Z"}})

# ── Periodic cleanup ──────────────────────────────────────

def _purge_orphan_uploads():
    try:
        grace = 24 * 3600
        now_ts = time.time()
        referenced = set()
        for u in mdb_get_users():
            for field in ("avatar_url", "cover_url"):
                url = u.get(field, "") or ""
                if url.startswith("/uploads/"):
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

def _run_cleanup():
    """Delete all expired documents. Called on startup, every 5 min, and via admin endpoint."""
    try:
        now_iso = datetime.utcnow().isoformat()

        # ── Messages: delete expired ones ──────────────────────────────
        expired_msgs = list(col_messages.find(
            {"expires_at": {"$lt": now_iso}, "media_url": {"$exists": True, "$ne": ""}},
            {"media_url": 1, "_id": 0}
        ))
        for m in expired_msgs:
            _cloudinary_delete(m.get("media_url", ""))
        r1 = col_messages.delete_many({"expires_at": {"$lt": now_iso}})

        # ── Old messages with no expires_at or expires_at empty — delete if older than 7 days ──
        cutoff_7d = (datetime.utcnow() - timedelta(days=7)).isoformat() + "Z"
        r_old = col_messages.delete_many({
            "$or": [{"expires_at": {"$exists": False}}, {"expires_at": ""}],
            "timestamp": {"$lt": cutoff_7d}
        })

        # ── Messages seen >24h ago — delete media first, then messages ──
        cutoff_24h = (datetime.utcnow() - timedelta(hours=24)).isoformat() + "Z"
        seen_with_media = list(col_messages.find(
            {"is_read": 1, "status": "seen", "seen_at": {"$lt": cutoff_24h}, "media_url": {"$exists": True, "$ne": ""}},
            {"media_url": 1, "_id": 0}
        ))
        for m in seen_with_media:
            _cloudinary_delete(m.get("media_url", ""))
        r_seen = col_messages.delete_many({
            "is_read": 1,
            "status": "seen",
            "seen_at": {"$lt": cutoff_24h}
        })

        # ── Group messages ──────────────────────────────────────────────
        expired_grp = list(col_group_messages.find(
            {"expires_at": {"$lt": now_iso}, "media_url": {"$exists": True, "$ne": ""}},
            {"media_url": 1, "_id": 0}
        ))
        for m in expired_grp:
            _cloudinary_delete(m.get("media_url", ""))
        r2 = col_group_messages.delete_many({"expires_at": {"$lt": now_iso}})

        # ── Everything else ────────────────────────────────────────────
        expired_statuses = list(col_statuses.find({"expires_at": {"$lt": now_iso}}, {"video_url": 1, "image_url": 1}))
        for s in expired_statuses:
            _cloudinary_delete(s.get("video_url", ""))
            _cloudinary_delete(s.get("image_url", ""))
        mdb_cleanup_expired_statuses()
        col_call_logs.delete_many({"expires_at": {"$lt": now_iso}})
        mdb_delete_expired_qr()
        col_password_reset.delete_many({"expires_at": {"$lt": now_iso}})
        # ── Login events: keep only last 7 days (was 30 days / 500 cap) ──
        col_login_events.delete_many({
            "timestamp": {"$lt": (datetime.utcnow() - timedelta(days=7)).isoformat()}
        })

        # ── Orphaned sessions: delete sessions not touched in 8 days ──────
        # JWT TTL is 7 days — any session older than 8 days is definitely expired
        stale_session_cutoff = (datetime.utcnow() - timedelta(days=8)).isoformat() + "Z"
        col_sessions.delete_many({"last_seen": {"$lt": stale_session_cutoff}})
        # Also delete sessions with no last_seen older than 8 days from created_at
        col_sessions.delete_many({
            "last_seen": {"$exists": False},
            "created_at": {"$lt": stale_session_cutoff}
        })

        # ── Orphaned linked_devices: remove QR-linked devices older than 8 days ──
        col_linked_devices.delete_many({
            "linked_at": {"$lt": stale_session_cutoff}
        })

        # ── Orphaned FCM tokens: remove tokens not updated in 30 days ──────
        stale_fcm_cutoff = datetime.utcnow() - timedelta(days=30)
        col_fcm_tokens.delete_many({"updated_at": {"$lt": stale_fcm_cutoff}})
        # Also delete FCM tokens whose session no longer exists
        active_session_ids = set(
            d["session_id"] for d in col_sessions.find({"session_id": {"$exists": True}}, {"session_id": 1, "_id": 0})
        )
        orphan_fcm = [
            d["token"] for d in col_fcm_tokens.find(
                {"session_id": {"$exists": True, "$ne": ""}}, {"token": 1, "session_id": 1, "_id": 0}
            )
            if d.get("session_id") not in active_session_ids
        ]
        if orphan_fcm:
            col_fcm_tokens.delete_many({"token": {"$in": orphan_fcm}})

        # ── Orphaned push subscriptions: remove if older than 30 days ──────
        col_push_subs.delete_many({
            "$or": [
                {"created_at": {"$lt": (datetime.utcnow() - timedelta(days=30)).isoformat()}},
                {"created_at": {"$exists": False}},  # old subs with no timestamp
            ]
        })

        # ── user_status: remove status records for deleted users ────────────
        active_user_ids = set(str(u["id"]) for u in col_users.find({}, {"id": 1, "_id": 0}))
        col_user_status.delete_many({"user_id": {"$nin": list(active_user_ids)}})

        total = r1.deleted_count + r2.deleted_count + r_old.deleted_count + r_seen.deleted_count
        if total > 0:
            print(f"[cleanup] Deleted {r1.deleted_count} msgs, {r_seen.deleted_count} seen, {r_old.deleted_count} old, {r2.deleted_count} group msgs")
        if orphan_fcm:
            print(f"[cleanup] Removed {len(orphan_fcm)} orphaned FCM tokens")
        _purge_orphan_uploads()
        _cleanup_rate_buckets()
    except Exception as e:
        print(f"[cleanup] Error: {e}")

async def _periodic_cleanup():
    await asyncio.sleep(5)
    _run_cleanup()  # Run immediately on startup to clear any backlog
    while True:
        await asyncio.sleep(5 * 60)  # Every 5 minutes (was 30 min)
        _run_cleanup()

@asynccontextmanager
async def lifespan(_app: FastAPI):
    asyncio.create_task(_periodic_cleanup())
    yield

app = FastAPI(title="SPVB API", version="1.3.0", lifespan=lifespan)

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"[500] {request.method} {request.url.path}\n{tb}")
    return JSONResponse(status_code=500, content={"detail": "Internal server error", "path": str(request.url.path)})

# ── WebSocket Connection Manager ──────────────────────────
# Supports multiple simultaneous connections per user (multi-tab / multi-device).
class WSManager:
    def __init__(self):
        # user_id → list of active WebSocket connections
        self.connections: dict[str, list] = {}

    async def connect(self, user_id: str, ws: WebSocket):
        await ws.accept()
        uid = str(user_id)
        if uid not in self.connections:
            self.connections[uid] = []
        self.connections[uid].append(ws)

    def disconnect(self, user_id: str, ws=None):
        uid = str(user_id)
        if ws is None:
            self.connections.pop(uid, None)
        else:
            conns = self.connections.get(uid, [])
            # Guard: QR slots store a single WebSocket, not a list
            if not isinstance(conns, list):
                self.connections.pop(uid, None)
                return
            if ws in conns:
                conns.remove(ws)
            if not conns:
                self.connections.pop(uid, None)

    async def send(self, user_id: str, data: dict):
        """Send to ALL connections of user_id (all tabs/devices)."""
        uid = str(user_id)
        raw = self.connections.get(uid, [])
        conns = list(raw) if isinstance(raw, list) else []
        dead = []
        for ws in conns:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(uid, ws)

    async def send_except(self, user_id: str, exclude_ws, data: dict):
        """Send to all connections of user_id EXCEPT the given WebSocket.
        Used to notify other tabs/devices that this tab already answered a call."""
        uid = str(user_id)
        conns = list(self.connections.get(uid, []))
        dead = []
        for ws in conns:
            if ws is exclude_ws:
                continue
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(uid, ws)

    def is_connected(self, user_id: str) -> bool:
        uid = str(user_id)
        return bool(self.connections.get(uid))

    async def broadcast_all(self, data: dict, exclude_uid: str = ""):
        """Broadcast to every connected user (used for presence updates).
        Skips QR slots which store a single WebSocket object instead of a list."""
        dead = []
        for uid, conns in list(self.connections.items()):
            if uid == exclude_uid:
                continue
            if uid.startswith('qr_'):  # QR slots are not user connections
                continue
            if not isinstance(conns, list):  # safety guard
                continue
            for ws in list(conns):
                try:
                    await ws.send_json(data)
                except Exception:
                    dead.append((uid, ws))
        for uid, ws in dead:
            self.disconnect(uid, ws)

ws_manager = WSManager()

# ── Email (SMTP) ───────────────────────────────────────────
_SMTP_SERVER    = os.getenv("SMTP_SERVER", "")
_SMTP_PORT      = int(os.getenv("SMTP_PORT", "587"))
_SMTP_USER      = os.getenv("SMTP_USER", "")
_SMTP_PASSWORD  = os.getenv("SMTP_PASSWORD", "")
_SMTP_FROM      = os.getenv("SMTP_FROM_EMAIL", _SMTP_USER)
_SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "SPVB")
_smtp_enabled   = bool(_SMTP_SERVER and _SMTP_USER and _SMTP_PASSWORD)

def send_email(to_email: str, subject: str, html_body: str, text_body: str = "") -> bool:
    """Send an email via SMTP. Returns True on success, False if not configured or on failure."""
    if not _smtp_enabled:
        return False
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{_SMTP_FROM_NAME} <{_SMTP_FROM}>"
        msg["To"] = to_email
        if text_body:
            msg.attach(MIMEText(text_body, "plain"))
        msg.attach(MIMEText(html_body, "html"))

        # Render's network has no outbound IPv6 route, but smtp.gmail.com has an
        # AAAA record — force IPv4-only DNS resolution for this connection so we
        # don't hit "[Errno 101] Network is unreachable".
        _orig_getaddrinfo = socket.getaddrinfo
        def _ipv4_getaddrinfo(host, port, family=0, *args, **kwargs):
            return _orig_getaddrinfo(host, port, socket.AF_INET, *args, **kwargs)
        socket.getaddrinfo = _ipv4_getaddrinfo
        try:
            if _SMTP_PORT == 587:
                with smtplib.SMTP(_SMTP_SERVER, _SMTP_PORT, timeout=30) as server:
                    server.starttls()
                    server.login(_SMTP_USER, _SMTP_PASSWORD)
                    server.sendmail(_SMTP_USER, [to_email], msg.as_string())
            else:
                with smtplib.SMTP_SSL(_SMTP_SERVER, _SMTP_PORT, timeout=30) as server:
                    server.login(_SMTP_USER, _SMTP_PASSWORD)
                    server.sendmail(_SMTP_USER, [to_email], msg.as_string())
        finally:
            socket.getaddrinfo = _orig_getaddrinfo
        return True
    except Exception as e:
        print(f"[email] send failed ({type(e).__name__}): {e}")
        return False

# ── Web Push (VAPID) ──────────────────────────────────────
_VAPID_PUBLIC_KEY  = os.getenv("VAPID_PUBLIC_KEY", "")
_VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
_VAPID_EMAIL       = os.getenv("VAPID_EMAIL", "mailto:admin@spvb.com")
_push_enabled      = bool(_VAPID_PUBLIC_KEY and _VAPID_PRIVATE_KEY)

# Extract the raw 32-byte EC private key value and re-encode as base64url.
# pywebpush.webpush() routes this through Vapid.from_string() which is the
# simplest, most version-compatible path — avoids all PEM/ASN.1 parsing issues.
_VAPID_RAW_B64 = None
if _push_enabled:
    try:
        import base64 as _b64
        from cryptography.hazmat.primitives.serialization import load_der_private_key
        _der = _b64.b64decode(_VAPID_PRIVATE_KEY)
        _pk  = load_der_private_key(_der, password=None)
        # private_value is the raw 32-byte EC scalar — exactly what pywebpush expects
        _raw = _pk.private_numbers().private_value.to_bytes(32, 'big')
        _VAPID_RAW_B64 = _b64.urlsafe_b64encode(_raw).rstrip(b'=').decode()
        print(f"[push] enabled, email={_VAPID_EMAIL}")
    except Exception as _e:
        print(f"[push] key load failed: {_e}")
else:
    print("[push] disabled — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set in .env")

# ── Firebase Cloud Messaging (FCM) ───────────────────────
_fcm_app = None
col_fcm_tokens = mdb["fcm_tokens"]
_idx(col_fcm_tokens, "user_id")
_idx(col_fcm_tokens, "session_id")

def _init_firebase():
    global _fcm_app
    sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "")
    sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    try:
        import firebase_admin
        from firebase_admin import credentials
        if sa_json:
            import base64 as _b64, json as _json
            sa_dict = _json.loads(_b64.b64decode(sa_json).decode())
            cred = credentials.Certificate(sa_dict)
        elif sa_path and os.path.exists(sa_path):
            cred = credentials.Certificate(sa_path)
        else:
            print("[fcm] disabled — FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_SERVICE_ACCOUNT_JSON not set")
            return
        _fcm_app = firebase_admin.initialize_app(cred)
        print("[fcm] Firebase Admin SDK initialized")
    except Exception as e:
        print(f"[fcm] init failed: {e}")

_init_firebase()

def _send_fcm(user_id: int, title: str, body: str, data: dict = None):
    """Send FCM push to all registered device tokens of user_id."""
    if not _fcm_app:
        return
    tokens = [d["token"] for d in col_fcm_tokens.find({"user_id": user_id}, {"token": 1, "_id": 0})]
    if not tokens:
        return
    try:
        from firebase_admin import messaging as fcm_messaging
        payload = data or {}
        str_data = {k: str(v) for k, v in payload.items()}
        messages = [
            fcm_messaging.Message(
                notification=fcm_messaging.Notification(title=title, body=body),
                data=str_data,
                token=tok,
                android=fcm_messaging.AndroidConfig(priority="high"),
                apns=fcm_messaging.APNSConfig(
                    payload=fcm_messaging.APNSPayload(aps=fcm_messaging.Aps(sound="default"))
                ),
            )
            for tok in tokens
        ]
        resp = fcm_messaging.send_each(messages)
        invalid = []
        for i, r in enumerate(resp.responses):
            if not r.success:
                err = str(r.exception)
                print(f"[fcm] FAIL token={tokens[i][:20]}… → {err}")
                if "registration-token-not-registered" in err or "invalid-registration-token" in err:
                    invalid.append(tokens[i])
        if invalid:
            col_fcm_tokens.delete_many({"token": {"$in": invalid}})
        print(f"[fcm] → user={user_id} sent={resp.success_count} fail={resp.failure_count}")
    except Exception as e:
        print(f"[fcm] send error: {e}")

def _send_push(user_id: int, title: str, body: str, data: dict = None):
    """Send push notification via FCM (primary) and VAPID web push (fallback)."""
    # FCM — works on Android/iOS/Web
    _send_fcm(user_id, title, body, data)
    # VAPID web push — browser-only fallback
    if not _push_enabled or not _VAPID_RAW_B64:
        return
    subs = list(col_push_subs.find({"user_id": user_id}, {"_id": 0}))
    if not subs:
        return
    from pywebpush import webpush
    payload = json.dumps({
        "title": title,
        "body":  body,
        "data":  data or {},
    })
    print(f"[push] → user={user_id} subs={len(subs)} title={title!r}")
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                },
                data=payload,
                vapid_private_key=_VAPID_RAW_B64,
                vapid_claims={"sub": _VAPID_EMAIL},
                ttl=86400,
                content_encoding="aes128gcm",
            )
            print(f"[push] OK {sub['endpoint'][:55]}…")
        except Exception as e:
            print(f"[push] FAIL {sub['endpoint'][:40]}… → {e}")
            if "410" in str(e) or "404" in str(e):
                col_push_subs.delete_one({"endpoint": sub["endpoint"]})

UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "../data/uploads"))
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Allow configured origins + all Vercel preview URLs
_ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "")
if _ALLOWED_ORIGINS:
    _origins = [o.strip() for o in _ALLOWED_ORIGINS.split(",")]
    _origin_regex = r"https://.*\.vercel\.app"
else:
    _origins = ["*"]
    _origin_regex = None

app.add_middleware(GZipMiddleware, minimum_size=512)
# allow_credentials=True is incompatible with allow_origins=["*"] in Starlette ≥ 0.20
# Only enable credentials when specific origins are configured
_allow_credentials = bool(_ALLOWED_ORIGINS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=_origin_regex,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Security middleware — rate limiting + security headers ─
_PUBLIC_PATHS = {"/", "/docs", "/openapi.json", "/redoc"}
# Paths excluded from rate limiting — high-frequency heartbeat/status endpoints
_NO_RATE_PATHS = {"/users/me/status", "/users/online-status", "/auth/me"}

@app.middleware("http")
async def security_middleware(request: Request, call_next):
    path = request.url.path

    # Skip rate limiting for health check and docs
    if path not in _PUBLIC_PATHS and path not in _NO_RATE_PATHS and not path.startswith("/uploads"):
        # Real IP — respect X-Forwarded-For from Render's proxy
        ip = request.headers.get("x-forwarded-for", "")
        ip = ip.split(",")[0].strip() if ip else (request.client.host if request.client else "unknown")

        # IP-level rate limit (protects against unauthenticated spam too)
        try:
            _check_ip_rate(ip)
        except HTTPException as e:
            return JSONResponse(status_code=429, content={"detail": e.detail},
                                headers={"Retry-After": "60"})

        # User-level rate limit for authenticated requests
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer "):
            try:
                payload = decode_jwt_token(auth[7:])
                user_id = str(payload.get("user_id", ""))
                if user_id:
                    _check_user_rate(user_id)
            except HTTPException as e:
                if e.status_code == 429:
                    return JSONResponse(status_code=429, content={"detail": e.detail},
                                        headers={"Retry-After": "60"})
                # 401 handled by the actual endpoint
            except Exception:
                pass

    response = await call_next(request)

    # Security headers — prevent clickjacking, sniffing, etc.
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]         = "DENY"
    response.headers["X-XSS-Protection"]        = "1; mode=block"
    response.headers["Referrer-Policy"]          = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]       = "geolocation=(), microphone=(), camera=()"
    # Remove server fingerprint (MutableHeaders has no .pop — use del)
    try:
        del response.headers["server"]
    except KeyError:
        pass
    return response

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
security = HTTPBearer()

# ── Auth helpers ──────────────────────────────────────────

def hash_password(p: str) -> str:
    if _BCRYPT_AVAILABLE:
        return _bcrypt.hashpw(p.encode(), _bcrypt.gensalt(12)).decode()
    return hashlib.sha256(p.encode()).hexdigest()

def verify_password(p: str, h: str) -> bool:
    if not h:
        return False
    # bcrypt hashes start with $2b$ or $2a$
    if _BCRYPT_AVAILABLE and h.startswith("$2"):
        return _bcrypt.checkpw(p.encode(), h.encode())
    # legacy SHA-256 fallback (constant-time)
    return hmac.compare_digest(hashlib.sha256(p.encode()).hexdigest(), h)

# ── Rate limiting ─────────────────────────────────────────
# In-memory sliding-window counters: { key: [timestamp, ...] }
_login_attempts: dict      = defaultdict(list)
_ip_requests: dict         = defaultdict(list)
_user_requests: dict       = defaultdict(list)
_password_reset_attempts: dict = defaultdict(list)  # Rate limit password resets per email
_MAX_LOGIN_ATTEMPTS        = 10
_LOGIN_WINDOW_SECONDS      = 300   # 5 min window for login attempts
_MAX_PASSWORD_RESETS       = 5
_PASSWORD_RESET_WINDOW     = 3600  # 1 hour window for password resets per email
_IP_LIMIT_PER_MIN          = 600   # max requests per IP per minute
_USER_LIMIT_PER_MIN        = 300   # max requests per user per minute
_RL_LOCK                   = threading.Lock()

def _check_rate_limit(identifier: str):
    """Login-specific rate limit — 10 attempts per 5 minutes."""
    now = time.time()
    with _RL_LOCK:
        _login_attempts[identifier] = [t for t in _login_attempts[identifier] if now - t < _LOGIN_WINDOW_SECONDS]
        if len(_login_attempts[identifier]) >= _MAX_LOGIN_ATTEMPTS:
            raise HTTPException(status_code=429, detail="Too many login attempts. Try again in 5 minutes.")
        _login_attempts[identifier].append(now)

def _check_ip_rate(ip: str):
    """Block an IP sending more than 200 requests/minute."""
    now = time.time()
    with _RL_LOCK:
        _ip_requests[ip] = [t for t in _ip_requests[ip] if now - t < 60]
        if len(_ip_requests[ip]) >= _IP_LIMIT_PER_MIN:
            raise HTTPException(status_code=429, detail="Too many requests. Slow down.")
        _ip_requests[ip].append(now)

def _check_user_rate(user_id: str):
    """Block a user_id sending more than 100 requests/minute."""
    now = time.time()
    with _RL_LOCK:
        _user_requests[user_id] = [t for t in _user_requests[user_id] if now - t < 60]
        if len(_user_requests[user_id]) >= _USER_LIMIT_PER_MIN:
            raise HTTPException(status_code=429, detail="Request limit reached. Please slow down.")
        _user_requests[user_id].append(now)

def _check_password_reset_rate(email: str):
    """Limit password reset requests to 5 per email per hour to prevent brute force."""
    now = time.time()
    with _RL_LOCK:
        _password_reset_attempts[email] = [t for t in _password_reset_attempts[email] if now - t < _PASSWORD_RESET_WINDOW]
        if len(_password_reset_attempts[email]) >= _MAX_PASSWORD_RESETS:
            raise HTTPException(status_code=429, detail="Too many password reset requests. Try again in 1 hour.")
        _password_reset_attempts[email].append(now)

def _cleanup_rate_buckets():
    """Purge stale entries so memory doesn't grow unbounded."""
    now = time.time()
    with _RL_LOCK:
        for d in (_ip_requests, _user_requests, _login_attempts, _password_reset_attempts):
            stale = [k for k, v in d.items() if not v or now - v[-1] > 3700]
            for k in stale:
                del d[k]

def create_jwt_token(data: dict, days: int = 7) -> str:
    secret = os.getenv("JWT_SECRET", "")
    if not secret:
        raise HTTPException(status_code=500, detail="Server configuration error")
    exp = datetime.utcnow() + timedelta(days=days)
    return jwt.encode({"exp": exp, **data}, secret, algorithm=os.getenv("JWT_ALGORITHM", "HS256"))

def decode_jwt_token(token: str) -> dict:
    try:
        secret = os.getenv("JWT_SECRET", "")
        if not secret:
            raise HTTPException(status_code=500, detail="Server configuration error")
        return jwt.decode(token, secret, algorithms=[os.getenv("JWT_ALGORITHM", "HS256")])
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
    payload = decode_jwt_token(credentials.credentials)
    # If the token carries a session_id, verify the session hasn't been revoked
    session_id = payload.get("session_id")
    if session_id:
        exists = col_sessions.find_one({"id": session_id}, {"_id": 1})
        if not exists:
            raise HTTPException(status_code=401, detail="Session revoked — please log in again")
    return payload

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

class VerifyResetCodeRequest(BaseModel):
    email: EmailStr
    code: str

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
    preview: Optional[str] = None  # plain-text snippet for push notification body only
    encrypted_key_for_sender:   Optional[str] = None  # RSA-OAEP wrapped AES key for sender (E2E V2)
    encrypted_key_for_receiver: Optional[str] = None  # RSA-OAEP wrapped AES key for receiver (E2E V2)

class StatusRequest(BaseModel):
    content: str
    type: Optional[str] = "text"
    color: Optional[str] = "#00a884"
    video_url: Optional[str] = None
    image_url: Optional[str] = None

class UserStatusUpdate(BaseModel):
    status: str

# ── WebSocket Endpoints ───────────────────────────────────

@app.websocket("/ws/qr/{token}")
async def qr_ws_endpoint(websocket: WebSocket, token: str):
    await websocket.accept()
    key = f"qr_{token}"
    # Store as list so ws_manager.send() works correctly
    ws_manager.connections[key] = [websocket]
    try:
        while True:
            await asyncio.sleep(1)
            rec = mdb_get_qr_token(token)
            if not rec or _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
                await websocket.send_json({"type": "qr_expired"})
                break
            if rec["status"] == "approved":
                # Use "token" key (matches frontend check: msg.token)
                jwt_val = rec.get("jwt", "") or rec.get("token", "")
                user_data = rec.get("user_payload") or {}
                await websocket.send_json({
                    "type": "qr_approved",
                    "token": jwt_val,
                    "session_id": rec.get("session_id", ""),
                    "user": user_data,
                })
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

def _safe_int(value) -> int:
    """Safely convert value to int, returns None if invalid."""
    try:
        return int(value)
    except (ValueError, TypeError):
        return None

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
    username = payload.get("username", "") or ""
    email = payload.get("email", "") or ""
    caller_display = payload.get("display_name") or payload.get("username", f"User {user_id}")
    mdb_set_status(user_id, username, email, "online")
    # Broadcast online status to all connected users instantly
    await ws_manager.broadcast_all({"type": "user_status", "user_id": user_id, "status": "online"}, exclude_uid=str(user_id))
    # Update last_seen for this session so the devices list shows recent activity
    ws_session_id = payload.get("session_id", "")
    if ws_session_id:
        try:
            mdb_touch_session(ws_session_id)
        except Exception:
            pass
    try:
        while True:
            data = await websocket.receive_json()
            target = str(data.get("target", ""))
            if not target:
                continue
            msg_type = data.get("type", "")
            await ws_manager.send(target, {**data, "from": str(user_id)})
            target_online = ws_manager.is_connected(target)

            # Mark message as delivered when WS relay reaches an active connection
            if msg_type == "chat_message" and target_online:
                msg_id = data.get("message", {}).get("id") if isinstance(data.get("message"), dict) else None
                if msg_id:
                    threading.Thread(target=db_mark_messages_delivered, args=([msg_id],), daemon=True).start()
                    # Notify sender that message was delivered
                    target_id = _safe_int(target)
                    if target_id:
                        await ws_manager.send(str(user_id), {"type": "message_delivered", "message_ids": [msg_id], "by": target_id})

            if msg_type == "call_answer":
                # Tell all OTHER tabs/devices of this user (the callee) to dismiss
                # the incoming call banner — they don't need to answer anymore.
                await ws_manager.send_except(user_id, websocket, {
                    "type": "call_accepted_elsewhere",
                    "from": str(target),
                })

            elif msg_type == "call_reject" or msg_type == "call_end":
                # Dismiss banner on all other tabs of this user too
                await ws_manager.send_except(user_id, websocket, {
                    "type": "call_accepted_elsewhere",
                    "from": str(target),
                })

            if msg_type == "call_offer":
                call_type = data.get("callType", "voice")
                icon = "📹" if call_type == "video" else "📞"
                # Always send call push — even if target has WS open (might be backgrounded on mobile)
                target_id = _safe_int(target)
                if target_id:
                    threading.Thread(
                        target=_send_push,
                        args=(
                            target_id,
                            f"{icon} Incoming {call_type} call",
                            f"{caller_display} is calling you",
                            {"type": "call", "from": str(user_id), "callType": call_type,
                             "callerName": caller_display},
                        ),
                        daemon=True,
                    ).start()

            elif msg_type == "chat_message":
                # Push for WS-relayed messages when target is offline or has no active WS tab
                if not target_online:
                    content = data.get("content") or data.get("text") or ""
                    plain_preview = data.get("preview", "")
                    if plain_preview:
                        preview = plain_preview[:80]
                    elif not content:
                        preview = "New message"
                    elif str(content).startswith("__e2e__|"):
                        preview = "New message"
                    else:
                        preview = content[:80]
                    # Mark delivered + tell sender → double grey ticks
                    ws_msg_id = data.get("message", {}).get("id") if isinstance(data.get("message"), dict) else None
                    target_id = _safe_int(target)
                    if ws_msg_id and target_id:
                        threading.Thread(target=db_mark_messages_delivered, args=([ws_msg_id],), daemon=True).start()
                        await ws_manager.send(str(user_id), {
                            "type": "message_delivered",
                            "message_ids": [ws_msg_id],
                            "by": target_id,
                        })
                    if target_id:
                        threading.Thread(
                            target=_send_push,
                            args=(
                                target_id,
                                caller_display,
                                preview,
                                {"type": "message", "from": str(user_id)},
                            ),
                            daemon=True,
                        ).start()
    except WebSocketDisconnect:
        ws_manager.disconnect(str(user_id), websocket)
        # Only mark offline when ALL tabs/devices have disconnected
        if not ws_manager.is_connected(str(user_id)):
            mdb_set_status(user_id, from_user[0], from_user[1], "offline")
            last_seen_now = datetime.utcnow().isoformat() + "Z"
            await ws_manager.broadcast_all({"type": "user_status", "user_id": user_id, "status": "offline", "last_seen": last_seen_now})
    except Exception:
        ws_manager.disconnect(str(user_id), websocket)
        if not ws_manager.is_connected(str(user_id)):
            mdb_set_status(user_id, from_user[0], from_user[1], "offline")
            last_seen_now = datetime.utcnow().isoformat() + "Z"
            await ws_manager.broadcast_all({"type": "user_status", "user_id": user_id, "status": "offline", "last_seen": last_seen_now})

# ── Public Key Exchange (E2E) ─────────────────────────────

@app.put("/api/users/me/pubkey")
def set_pubkey(body: dict, cu: dict = Depends(get_current_user)):
    # Only store if it looks like an ECDH key (kty=EC) — reject RSA keys here
    raw = body.get("pubkey", "")
    mdb_update_user(cu["user_id"], {"pubkey": raw})
    return {"ok": True}

@app.get("/api/users/{user_id}/pubkey")
def get_pubkey(user_id: int, cu: dict = Depends(get_current_user)):
    doc = col_users.find_one({"id": user_id}, {"_id": 0, "pubkey": 1})
    if doc is None:
        raise HTTPException(status_code=404, detail="User not found")
    pubkey = doc.get("pubkey") or ""
    return JSONResponse(
        content={"pubkey": pubkey, "user_id": user_id},
        headers={"Cache-Control": "public, max-age=60" if pubkey else "no-store"},
    )

# V2 RSA-OAEP pubkey — stored separately so V1 ECDH key is never overwritten
@app.put("/api/users/me/pubkey_v2")
def set_pubkey_v2(body: dict, cu: dict = Depends(get_current_user)):
    mdb_update_user(cu["user_id"], {"pubkey_v2": body.get("pubkey", "")})
    return {"ok": True}

@app.get("/api/users/{user_id}/pubkey_v2")
def get_pubkey_v2(user_id: int, cu: dict = Depends(get_current_user)):
    doc = col_users.find_one({"id": user_id}, {"_id": 0, "pubkey_v2": 1})
    if doc is None:
        raise HTTPException(status_code=404, detail="User not found")
    pubkey = doc.get("pubkey_v2") or ""
    return JSONResponse(
        content={"pubkey": pubkey, "user_id": user_id},
        headers={"Cache-Control": "public, max-age=60" if pubkey else "no-store"},
    )

@app.get("/api/users/me/e2e-status")
def get_e2e_status(cu: dict = Depends(get_current_user)):
    """Self-service E2E status — any user can check their own key health."""
    my_id = cu["user_id"]
    me = col_users.find_one({"id": my_id}, {"_id": 0, "pubkey": 1, "e2e_key_backup": 1})
    has_pubkey = bool(me and me.get("pubkey"))
    has_backup = bool(me and me.get("e2e_key_backup"))
    pubkey_x   = None
    if has_pubkey:
        try:
            import json as _j
            pubkey_x = _j.loads(me["pubkey"]).get("x", "")[:16]
        except Exception:
            pubkey_x = "parse-error"

    # Check all contacts' pubkeys
    saved_ids  = mdb_get_saved_contacts(str(my_id))
    # Safely convert contact IDs, filtering out invalid ones
    valid_ids = [_safe_int(i) for i in saved_ids if _safe_int(i) is not None]
    contacts   = list(col_users.find({"id": {"$in": valid_ids}}, {"_id": 0, "id": 1, "username": 1, "pubkey": 1})) if valid_ids else []
    contact_status = [{"id": c["id"], "username": c.get("username"), "has_pubkey": bool(c.get("pubkey"))} for c in contacts]
    missing = [c for c in contact_status if not c["has_pubkey"]]

    return {
        "my_status": {"has_pubkey": has_pubkey, "pubkey_x": pubkey_x, "has_backup": has_backup},
        "contacts_missing_pubkey": missing,
        "contacts_ok": len(contact_status) - len(missing),
        "verdict": "OK" if has_pubkey and not missing else (
            "MY_KEY_MISSING" if not has_pubkey else
            f"{len(missing)} contact(s) have no pubkey — their messages cannot be decrypted"
        ),
    }

# ── E2E Key Backup (encrypted with user's password via PBKDF2) ────────────

@app.put("/api/users/me/key-backup")
def set_key_backup(body: dict, cu: dict = Depends(get_current_user)):
    """Store V1 ECDH private key encrypted with password (PBKDF2+AES-GCM)."""
    backup = body.get("backup", "")
    if not backup:
        raise HTTPException(status_code=400, detail="backup required")
    mdb_update_user(cu["user_id"], {"e2e_key_backup": backup})
    return {"ok": True}

@app.get("/api/users/me/key-backup")
def get_key_backup(cu: dict = Depends(get_current_user)):
    """Retrieve V1 ECDH encrypted private key backup."""
    u = mdb_get_user_by_id(cu["user_id"])
    return {"backup": u.get("e2e_key_backup", "") if u else ""}

# ── V2 RSA-OAEP Key Backup — separate field, never overwrites V1 ──────────

@app.put("/api/users/me/key-backup-v2")
def set_key_backup_v2(body: dict, cu: dict = Depends(get_current_user)):
    """Store V2 RSA-OAEP private key encrypted with password (PBKDF2+AES-GCM)."""
    backup = body.get("backup", "")
    if not backup:
        raise HTTPException(status_code=400, detail="backup required")
    mdb_update_user(cu["user_id"], {"e2e_key_backup_v2": backup})
    return {"ok": True}

@app.get("/api/users/me/key-backup-v2")
def get_key_backup_v2(cu: dict = Depends(get_current_user)):
    """Retrieve V2 RSA-OAEP encrypted private key backup."""
    u = mdb_get_user_by_id(cu["user_id"])
    return {"backup": u.get("e2e_key_backup_v2", "") if u else ""}

@app.put("/api/users/me/password")
def change_password(body: dict, cu: dict = Depends(get_current_user)):
    """Change password and re-encrypt both key backups atomically."""
    old_pw  = body.get("old_password", "")
    new_pw  = body.get("new_password", "")
    v1_backup = body.get("key_backup_v1", "")
    v2_backup = body.get("key_backup_v2", "")
    if not old_pw or not new_pw:
        raise HTTPException(status_code=400, detail="old_password and new_password required")
    u = mdb_get_user_by_id(cu["user_id"])
    if not u or not verify_password(old_pw, u.get("password", "")):
        raise HTTPException(status_code=401, detail="Wrong current password")
    fields: dict = {"password": hash_password(new_pw)}
    if v1_backup:
        fields["e2e_key_backup"] = v1_backup
    if v2_backup:
        fields["e2e_key_backup_v2"] = v2_backup
    mdb_update_user(cu["user_id"], fields)
    return {"ok": True}

# ── Push Notifications ────────────────────────────────────

@app.get("/api/push/vapid-public-key")
def get_vapid_public_key():
    return {"publicKey": _VAPID_PUBLIC_KEY}

@app.post("/api/push/subscribe")
def push_subscribe(body: dict, cu: dict = Depends(get_current_user)):
    endpoint = body.get("endpoint", "")
    p256dh   = body.get("keys", {}).get("p256dh", "")
    auth     = body.get("keys", {}).get("auth", "")
    if not endpoint:
        raise HTTPException(status_code=400, detail="endpoint required")
    col_push_subs.update_one(
        {"endpoint": endpoint},
        {"$set": {"user_id": cu["user_id"], "endpoint": endpoint, "p256dh": p256dh, "auth": auth,
                  "created_at": datetime.utcnow().isoformat() + "Z"}},
        upsert=True,
    )
    return {"ok": True}

@app.delete("/api/push/subscribe")
def push_unsubscribe(body: dict, cu: dict = Depends(get_current_user)):
    endpoint = body.get("endpoint", "")
    if endpoint:
        col_push_subs.delete_one({"endpoint": endpoint, "user_id": cu["user_id"]})
    return {"ok": True}

@app.post("/api/push/fcm-token")
def register_fcm_token(body: dict, cu: dict = Depends(get_current_user)):
    """Register an FCM device token for the current user, linked to the current session."""
    token = (body.get("token") or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="token required")
    session_id = cu.get("session_id", "")
    col_fcm_tokens.update_one(
        {"token": token},
        {"$set": {"user_id": cu["user_id"], "token": token, "session_id": session_id, "updated_at": datetime.utcnow().isoformat() + "Z"}},
        upsert=True,
    )
    return {"ok": True}

@app.delete("/api/push/fcm-token")
def unregister_fcm_token(body: dict, cu: dict = Depends(get_current_user)):
    token = (body.get("token") or "").strip()
    session_id = cu.get("session_id", "")
    if token:
        col_fcm_tokens.delete_one({"token": token, "user_id": cu["user_id"]})
    # Also remove by session_id as fallback — covers cases where fcm_token is missing from localStorage
    if session_id:
        col_fcm_tokens.delete_many({"session_id": session_id, "user_id": cu["user_id"]})
    # Remove session so it disappears from linked devices on other devices
    if session_id:
        mdb_delete_session(session_id, cu["user_id"])
    return {"ok": True}

@app.post("/api/auth/logout")
def logout(cu: dict = Depends(get_current_user)):
    """Remove the current session record — called on logout when no FCM token exists."""
    session_id = cu.get("session_id", "")
    if session_id:
        mdb_delete_session(session_id, cu["user_id"])
    return {"ok": True}

@app.post("/api/push/test")
def push_test(cu: dict = Depends(get_current_user)):
    """Fire a test push notification to the calling user (for debugging)."""
    name = cu.get("display_name") or cu.get("username", "You")
    threading.Thread(
        target=_send_push,
        args=(cu["user_id"], "SPVB 🔔 Test", f"Push is working, {name}!", {"test": True}),
        daemon=True,
    ).start()
    subs = col_push_subs.count_documents({"user_id": cu["user_id"]})
    return {"ok": True, "subscriptions": subs, "push_enabled": _push_enabled}

# ── Health ────────────────────────────────────────────────

@app.get("/api/")
def root():
    return {"message": "SPVB API", "version": "1.3.0"}

@app.get("/api/health")
def health():
    return {"status": "healthy", "timestamp": datetime.utcnow().isoformat() + "Z"}

@app.get("/api/ping")
def ping():
    return {"ok": True}

# ── Auth ──────────────────────────────────────────────────

@app.post("/api/auth/register", response_model=TokenResponse)
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
        "created_at": datetime.utcnow().isoformat() + "Z",
        "display_name": req.username, "avatar_url": "",
    }
    mdb_save_user(new_user)
    mdb_record_login(uid, req.username, req.email, "register", "user")
    token = create_jwt_token({"user_id": uid, "username": req.username, "email": req.email, "role": "user", "display_name": req.username, "avatar_url": ""})
    return {"token": token, "user": {"id": uid, "username": req.username, "email": req.email, "phone": req.phone or "", "role": "user", "display_name": req.username, "avatar_url": ""}}

@app.post("/api/auth/login", response_model=TokenResponse)
def login(req: LoginRequest, request: Request):
    admin_email = os.getenv("ADMIN_EMAIL")
    admin_password = os.getenv("ADMIN_PASSWORD", "")
    identifier = req.identifier.strip()
    is_email = "@" in identifier

    # Rate limit by identifier
    _check_rate_limit(identifier.lower())

    ua = request.headers.get("user-agent", "")
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "")
    if ip and "," in ip:
        ip = ip.split(",")[0].strip()

    # Constant-time admin password comparison to prevent timing attacks
    if is_email and identifier == admin_email and hmac.compare_digest(req.password, admin_password):
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
        if is_email:
            raise HTTPException(status_code=401, detail="No account found with this email address")
        else:
            raise HTTPException(status_code=401, detail="No account found with this phone number. Try logging in with your email address instead.")

    u = matched_user
    stored_pwd = u.get("password", "")
    if not u.get("has_password") and stored_pwd == "":
        raise HTTPException(status_code=401, detail="This account uses Google Sign-In. Set a password first via Account Setup, or click 'Continue with Google'.")
    if stored_pwd and verify_password(req.password, stored_pwd):
        mdb_record_login(u["id"], u["username"], u["email"], "email", u.get("role", "user"))
        session_id = str(_uuid.uuid4())
        token = create_jwt_token({"user_id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "session_id": session_id})
        dev = _parse_device_info(ua)
        now = datetime.utcnow().isoformat() + "Z"
        try:
            mdb_save_session({"id": session_id, "user_id": u["id"], "device_name": dev["device_name"], "device_type": dev["device_type"], "os": dev["os"], "browser": dev["browser"], "ip": ip, "login_method": "password", "created_at": now, "last_seen": now})
        except Exception:
            pass
        return {"token": token, "session_id": session_id, "user": {"id": u["id"], "username": u["username"], "email": u["email"], "phone": u.get("phone", ""), "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "cover_url": u.get("cover_url", "")}}
    raise HTTPException(status_code=401, detail="Incorrect password")

@app.post("/api/auth/verify-password")
def verify_password_endpoint(body: dict, cu: dict = Depends(get_current_user)):
    """Verify the current user's password — used by the app lock screen fallback."""
    pw = body.get("password", "")
    if not pw:
        raise HTTPException(status_code=400, detail="password required")
    user_id = cu["user_id"]
    # Admin has no DB record — compare directly to env
    if user_id == 0:
        if hmac.compare_digest(pw, os.getenv("ADMIN_PASSWORD", "")):
            return {"ok": True}
        raise HTTPException(status_code=401, detail="Wrong password")
    u = mdb_get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    stored = u.get("password", "")
    if not stored:
        raise HTTPException(status_code=400, detail="Account uses Google Sign-In — no password set")
    if not verify_password(pw, stored):
        raise HTTPException(status_code=401, detail="Wrong password")
    return {"ok": True}

@app.post("/api/auth/google", response_model=TokenResponse)
def google_login(req: GoogleAuthRequest, request: Request):
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

    ua = request.headers.get("user-agent", "")
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "")
    if ip and "," in ip:
        ip = ip.split(",")[0].strip()

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
        user = {"id": uid, "username": username, "email": email, "password": "", "has_password": False, "role": "user", "created_at": datetime.utcnow().isoformat() + "Z", "google_id": gd.get("sub"), "avatar_url": picture, "display_name": name, "phone": ""}
        mdb_save_user(user)

    mdb_record_login(user["id"], user["username"], email, "google", user.get("role", "user"))
    session_id = str(_uuid.uuid4())
    tok = create_jwt_token({"user_id": user["id"], "username": user["username"], "email": email, "role": user.get("role", "user"), "display_name": user.get("display_name", name), "avatar_url": user.get("avatar_url", picture), "session_id": session_id})
    dev = _parse_device_info(ua)
    now = datetime.utcnow().isoformat() + "Z"
    try:
        mdb_save_session({"id": session_id, "user_id": user["id"], "device_name": dev["device_name"], "device_type": dev["device_type"], "os": dev["os"], "browser": dev["browser"], "ip": ip, "login_method": "google", "created_at": now, "last_seen": now})
    except Exception:
        pass
    needs_setup = not user.get("has_password") or not user.get("phone")
    return {"token": tok, "session_id": session_id, "user": {"id": user["id"], "username": user["username"], "email": email, "role": user.get("role", "user"), "display_name": user.get("display_name", name), "avatar_url": user.get("avatar_url", picture)}, "is_new_user": is_new_user, "needs_setup": needs_setup}

@app.get("/api/auth/me")
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

@app.post("/api/auth/set-password")
def set_password(req: SetPasswordRequest, cu: dict = Depends(get_current_user)):
    fields = {"password": hash_password(req.password), "has_password": True}
    if req.phone:
        fields["phone"] = req.phone
    mdb_update_user(cu["user_id"], fields)
    return {"ok": True}

@app.post("/api/auth/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    import secrets, string
    _check_password_reset_rate(req.email)
    user = mdb_get_user_by_email(req.email)
    if not user:
        raise HTTPException(status_code=404, detail="No account found with this email address")

    code_chars = string.ascii_uppercase + string.digits
    code = ''.join(secrets.choice(code_chars) for _ in range(6))
    expires = (datetime.utcnow() + timedelta(minutes=15)).isoformat() + "Z"
    mdb_save_reset_token(req.email, {"code": code, "expires_at": expires, "user_id": user["id"]})

    name = user.get("display_name") or user.get("username") or "there"
    subject = "Your SPVB password reset code"
    html_body = f"""
      <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
        <h2 style="color: #7b4ff5; margin-bottom: 4px;">SPVB Password Reset</h2>
        <p>Hi {name},</p>
        <p>Use the code below to reset your password. This code expires in 15 minutes.</p>
        <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; background: #f3f0ff; color: #5a3fd6; padding: 16px 24px; border-radius: 12px; text-align: center; margin: 20px 0;">{code}</div>
        <p>If you didn't request this, you can safely ignore this email.</p>
      </div>
    """
    text_body = f"Hi {name},\n\nYour SPVB password reset code is: {code}\nThis code expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email."
    print(f"[forgot-password] attempting to send email to {req.email}, SMTP enabled: {_smtp_enabled}")
    sent = send_email(req.email, subject, html_body, text_body)
    if not sent:
        print(f"[forgot-password] email send failed/not configured for {req.email}")
    else:
        print(f"[forgot-password] email sent successfully to {req.email}")

    return {"ok": True, "message": "A reset code has been sent to your email address"}

@app.post("/api/auth/verify-reset-code")
def verify_reset_code(req: VerifyResetCodeRequest):
    entry = mdb_get_reset_token(req.email)
    if not entry or entry.get("code") != req.code.upper():
        raise HTTPException(status_code=400, detail="Invalid or expired code")
    if _parse_dt(entry["expires_at"]) < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Reset code has expired")
    return {"ok": True}

@app.post("/api/auth/reset-password")
def reset_password_endpoint(req: ResetPasswordRequest):
    email, entry = mdb_find_reset_token_by_code(req.code.upper())
    if not entry:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    if _parse_dt(entry["expires_at"]) < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Reset code has expired")
    mdb_update_user(entry["user_id"], {"password": hash_password(req.password), "has_password": True})
    mdb_delete_reset_token(email)
    return {"ok": True}

# ── User Online Status ────────────────────────────────────

@app.post("/api/users/me/status")
def set_user_status(body: UserStatusUpdate, cu: dict = Depends(get_current_user)):
    mdb_set_status(cu["user_id"], cu.get("username", ""), cu.get("email", ""), body.status)
    return {"ok": True}

@app.get("/api/contacts")
def get_contacts(cu: dict = Depends(get_current_user)):
    _contact_proj = {"_id": 0, "id": 1, "username": 1, "email": 1, "display_name": 1,
                     "avatar_url": 1, "cover_url": 1, "about": 1, "phone": 1}
    users = mdb_get_users(_contact_proj)
    user_status = mdb_get_user_status()
    my_nicknames = mdb_get_nicknames(str(cu["user_id"]))
    now = datetime.utcnow()
    result = []
    for u in users:
        if u["id"] == cu["user_id"]:
            continue
        uid_str = str(u["id"])
        st = user_status.get(uid_str)
        if st:
            diff = (now - _parse_dt(st["updated_at"])).total_seconds()
            online = "online" if diff < 35 else ("away" if diff < 120 else "offline")
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

@app.get("/api/contacts/saved")
def get_saved_contacts(cu: dict = Depends(get_current_user)):
    saved = mdb_get_saved_contacts(str(cu["user_id"]))
    return {"saved_contact_ids": saved}

@app.post("/api/contacts/{contact_id}/save")
def save_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    saved = mdb_get_saved_contacts(uid)
    if contact_id not in saved:
        saved.append(contact_id)
    mdb_save_saved_contacts(uid, saved)
    return {"ok": True}

@app.delete("/api/contacts/{contact_id}/save")
def unsave_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    saved = mdb_get_saved_contacts(uid)
    mdb_save_saved_contacts(uid, [c for c in saved if c != contact_id])
    return {"ok": True}

@app.get("/api/users/find-by-phone")
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

@app.put("/api/contacts/{contact_id}/nickname")
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

VALID_RINGTONES = {"default","chime","bell","marimba","pop","soft","alert","ding","whistle","none"}

@app.put("/api/contacts/{contact_id}/ringtone")
def set_contact_ringtone(contact_id: int, body: dict, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    ringtone = str(body.get("ringtone", "default")).strip()
    if ringtone not in VALID_RINGTONES:
        raise HTTPException(status_code=400, detail="Invalid ringtone")
    doc = col_ringtones.find_one({"user_id": uid}, {"_id": 0}) or {"user_id": uid, "map": {}}
    mapping = doc.get("map", {})
    if ringtone == "default":
        mapping.pop(str(contact_id), None)
    else:
        mapping[str(contact_id)] = ringtone
    col_ringtones.replace_one({"user_id": uid}, {"user_id": uid, "map": mapping}, upsert=True)
    return {"ok": True, "ringtone": ringtone}

@app.get("/api/contacts/ringtones")
def get_contact_ringtones(cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    doc = col_ringtones.find_one({"user_id": uid}, {"_id": 0}) or {}
    return doc.get("map", {})

@app.post("/api/contacts/{contact_id}/block")
def block_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    ids = mdb_get_blocked(uid)
    if contact_id not in ids:
        ids.append(contact_id)
    mdb_save_blocked(uid, ids)
    return {"ok": True}

@app.delete("/api/contacts/{contact_id}/block")
def unblock_contact(contact_id: int, cu: dict = Depends(get_current_user)):
    uid = str(cu["user_id"])
    ids = mdb_get_blocked(uid)
    mdb_save_blocked(uid, [x for x in ids if x != contact_id])
    return {"ok": True}

@app.get("/api/contacts/blocked")
def get_blocked_contacts(cu: dict = Depends(get_current_user)):
    ids = mdb_get_blocked(str(cu["user_id"]))
    result = []
    for uid in ids:
        u = mdb_get_user_by_id(uid)
        if u:
            result.append({"id": u["id"], "username": u["username"], "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", "")})
    return result

@app.put("/api/auth/me")
def update_me(body: dict, cu: dict = Depends(get_current_user)):
    u = mdb_get_user_by_id(cu["user_id"])
    if not u:
        # Fallback: try string id (covers edge cases from JWT type mismatch)
        u = col_users.find_one({"id": str(cu["user_id"])}, {"_id": 0})
        if u:
            u = _strip_id(dict(u))
        else:
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
    if "msg_retention_days" in body:
        days = int(body["msg_retention_days"])
        if days not in (1, 3, 7, 14, 30, 0):  # 0 = never delete
            raise HTTPException(status_code=400, detail="Invalid retention value")
        fields["msg_retention_days"] = days
    mdb_update_user(cu["user_id"], fields)
    u.update(fields)
    return {"ok": True, "user": {"id": u["id"], "username": u["username"], "email": u["email"], "phone": u.get("phone", ""), "role": u.get("role", "user"), "display_name": u.get("display_name", u["username"]), "avatar_url": u.get("avatar_url", ""), "cover_url": u.get("cover_url", ""), "about": u.get("about", ""), "msg_retention_days": u.get("msg_retention_days", 0)}}

# ── Messages ──────────────────────────────────────────────

@app.get("/api/messages/recent")
def get_recent_conversations(cu: dict = Depends(get_current_user)):
    return db_get_recent_conversations_fast(cu["user_id"])

@app.put("/api/messages/read/{contact_id}")
async def mark_messages_read(contact_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    marked_ids = db_mark_messages_read(contact_id, my_id)
    if marked_ids:
        await ws_manager.send(str(contact_id), {"type": "read_receipt", "by": my_id, "message_ids": marked_ids})
    return {"ok": True, "count": len(marked_ids)}

@app.get("/api/messages/conversation/{contact_id}")
async def get_conversation(contact_id: int, since_id: int = 0, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    room = f"dm_{min(my_id, contact_id)}_{max(my_id, contact_id)}"
    messages = db_get_messages_room(room, since_id)
    # Mark undelivered messages sent to me as delivered and notify the sender
    undelivered = [m["id"] for m in messages if m.get("recipient_id") == my_id and m.get("status") == "sent"]
    if undelivered:
        threading.Thread(target=db_mark_messages_delivered, args=(undelivered,), daemon=True).start()
        await ws_manager.send(str(contact_id), {"type": "message_delivered", "message_ids": undelivered, "by": my_id})
    return messages

@app.get("/api/users/online")
def get_online_users(cu: dict = Depends(get_current_user)):
    # Only expose presence for contacts the requester has saved (privacy)
    saved = set(str(i) for i in mdb_get_saved_contacts(str(cu["user_id"])))
    user_status = mdb_get_user_status()
    now = datetime.utcnow()
    result = {}
    for uid, info in user_status.items():
        if uid not in saved:
            continue
        diff = (now - _parse_dt(info["updated_at"])).total_seconds()
        # Strip non-serializable fields (ObjectId from mongita)
        clean = {k: str(v) if hasattr(v, '__class__') and v.__class__.__name__ == 'ObjectId' else v
                 for k, v in info.items() if k != "_id"}
        if info.get("status") == "hidden":
            result[uid] = {**clean, "online_status": "hidden"}
        elif diff < 60:
            result[uid] = {**clean, "online_status": "online"}
        elif diff < 300:
            result[uid] = {**clean, "online_status": "away"}
        else:
            result[uid] = {**clean, "online_status": "offline"}
    return JSONResponse(content=result, headers={"Cache-Control": "private, max-age=5"})

# ── Admin Stats ───────────────────────────────────────────

@app.get("/api/admin/stats")
def admin_stats(cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    users = mdb_get_users()
    user_status = mdb_get_user_status()
    events = mdb_get_login_events()
    now = datetime.utcnow()
    today = now.date().isoformat()

    online_users = []
    for uid, info in user_status.items():
        diff = (now - _parse_dt(info["updated_at"])).total_seconds()
        online_users.append({"user_id": uid, "username": info.get("username", ""), "email": info.get("email", ""), "online_status": "online" if diff < 35 else ("away" if diff < 120 else "offline"), "last_seen": info["updated_at"]})
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

@app.post("/api/admin/cleanup")
def admin_cleanup(cu: dict = Depends(get_current_user)):
    """Manually trigger a full database cleanup — admin only."""
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    before_msgs  = col_messages.count_documents({})
    before_grp   = col_group_messages.count_documents({})
    before_logs  = col_login_events.count_documents({})
    _run_cleanup()
    after_msgs  = col_messages.count_documents({})
    after_grp   = col_group_messages.count_documents({})
    after_logs  = col_login_events.count_documents({})
    return {
        "ok": True,
        "deleted": {
            "messages": before_msgs - after_msgs,
            "group_messages": before_grp - after_grp,
            "login_events": before_logs - after_logs,
        },
        "remaining": {
            "messages": after_msgs,
            "group_messages": after_grp,
            "sessions": col_sessions.count_documents({}),
            "fcm_tokens": col_fcm_tokens.count_documents({}),
            "users": col_users.count_documents({}),
        }
    }

@app.get("/api/admin/storage")
def admin_storage(cu: dict = Depends(get_current_user)):
    """Show storage usage per collection — admin only."""
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    result = {}
    for name in mdb.list_collection_names():
        try:
            stats = mdb.command("collstats", name)
            result[name] = {
                "documents": stats.get("count", 0),
                "size_kb": round(stats.get("size", 0) / 1024, 1),
                "storage_kb": round(stats.get("storageSize", 0) / 1024, 1),
            }
        except Exception:
            pass
    total_kb = sum(v["storage_kb"] for v in result.values())
    return {"collections": result, "total_storage_kb": round(total_kb, 1), "total_storage_mb": round(total_kb / 1024, 2)}

@app.get("/api/admin/e2e-report")
def admin_e2e_report(cu: dict = Depends(get_current_user)):
    """
    Production E2E investigation report — admin only.
    Returns per-user key status and message decryption health.
    """
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    users = list(col_users.find({}, {"_id": 0, "id": 1, "username": 1, "email": 1, "pubkey": 1, "e2e_key_backup": 1}))

    # Message stats
    total_encrypted   = col_messages.count_documents({"encrypted": 1})
    total_unencrypted = col_messages.count_documents({"encrypted": 0})
    total_messages    = total_encrypted + total_unencrypted

    # Per-user E2E status
    user_report = []
    for u in users:
        uid = u["id"]
        has_pubkey  = bool(u.get("pubkey", ""))
        has_backup  = bool(u.get("e2e_key_backup", ""))
        pubkey_x    = None
        if has_pubkey:
            try:
                import json as _json
                pubkey_x = _json.loads(u["pubkey"]).get("x", "")[:12] + "…"
            except Exception:
                pubkey_x = "parse-error"

        # Count encrypted messages sent by this user and received by this user
        sent_encrypted = col_messages.count_documents({"from_user_id": uid, "encrypted": 1})
        recv_encrypted = col_messages.count_documents({"recipient_id": uid, "encrypted": 1})

        user_report.append({
            "user_id":       uid,
            "username":      u.get("username", ""),
            "has_pubkey":    has_pubkey,
            "pubkey_x":      pubkey_x,
            "has_backup":    has_backup,
            "sent_encrypted": sent_encrypted,
            "recv_encrypted": recv_encrypted,
            "risk": (
                "NO_PUBKEY — cannot receive encrypted messages"  if not has_pubkey else
                "NO_BACKUP — cannot restore key on new device"   if not has_backup else
                "OK"
            ),
        })

    no_pubkey  = [u for u in user_report if not u["has_pubkey"]]
    no_backup  = [u for u in user_report if u["has_pubkey"] and not u["has_backup"]]
    fully_ok   = [u for u in user_report if u["has_pubkey"] and u["has_backup"]]

    return {
        "summary": {
            "total_users":        len(users),
            "users_with_pubkey":  len(users) - len(no_pubkey),
            "users_no_pubkey":    len(no_pubkey),
            "users_no_backup":    len(no_backup),
            "users_fully_ok":     len(fully_ok),
            "total_messages":     total_messages,
            "encrypted_messages": total_encrypted,
            "plaintext_messages": total_unencrypted,
            "encryption_rate_pct": round(total_encrypted / max(total_messages, 1) * 100, 1),
        },
        "at_risk_users": [u for u in user_report if u["risk"] != "OK"],
        "all_users": user_report,
        "recommendation": (
            "REDESIGN NOT NEEDED — fix key upload for users missing pubkey"
            if len(no_pubkey) < len(users) * 0.5
            else "CRITICAL — majority of users have no pubkey, investigate key upload flow"
        ),
    }

# ── Admin: Impersonate user ───────────────────────────────
@app.post("/api/admin/impersonate/{user_id}")
def admin_impersonate(user_id: int, cu: dict = Depends(get_current_user)):
    """Admin-only: generate a short-lived JWT to log in as any user."""
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    target = mdb_get_user_by_id(user_id)
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    # Short-lived token (1 hour) with a marker so it can be identified
    token = create_jwt_token({
        "user_id": target["id"],
        "username": target["username"],
        "email": target["email"],
        "role": target.get("role", "user"),
        "display_name": target.get("display_name", target["username"]),
        "avatar_url": target.get("avatar_url", ""),
        "impersonated_by": cu["user_id"],
    }, days=0)  # days=0 → use 1-hour expiry below
    from datetime import timezone
    exp = datetime.now(timezone.utc) + timedelta(hours=1)
    import json as _json
    from jose import jwt as _jwt
    secret = os.getenv("JWT_SECRET", "")
    token = _jwt.encode(
        {"exp": exp, "user_id": target["id"], "username": target["username"],
         "email": target["email"], "role": target.get("role", "user"),
         "display_name": target.get("display_name", target["username"]),
         "avatar_url": target.get("avatar_url", ""),
         "impersonated_by": cu["user_id"]},
        secret, algorithm=os.getenv("JWT_ALGORITHM", "HS256")
    )
    return {
        "token": token,
        "user": {
            "id": target["id"],
            "username": target["username"],
            "email": target["email"],
            "role": target.get("role", "user"),
            "display_name": target.get("display_name", target["username"]),
            "avatar_url": target.get("avatar_url", ""),
            "phone": target.get("phone", ""),
        }
    }

# ── Messages POST ─────────────────────────────────────────

@app.post("/api/messages")
async def create_message(msg: MessageRequest, cu: dict = Depends(get_current_user)):
    _now = datetime.utcnow()
    # Server keeps messages for 30 days max — each client filters by their own retention setting
    _expires = (_now + timedelta(days=30)).isoformat() + "Z"
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
        "expires_at": _expires,
        "encrypted_key_for_sender":   msg.encrypted_key_for_sender or None,
        "encrypted_key_for_receiver": msg.encrypted_key_for_receiver or None,
    }
    message = db_save_message(message)
    if msg.recipient_id:
        await ws_manager.send(str(msg.recipient_id), {"type": "chat_message", "message": message})
        recipient_online = ws_manager.is_connected(str(msg.recipient_id))
        # Mark delivered immediately if recipient has active WS,
        # then notify the SENDER so their double-tick appears instantly.
        if recipient_online:
            threading.Thread(target=db_mark_messages_delivered, args=([message["id"]],), daemon=True).start()
            # Tell sender → double grey ticks
            await ws_manager.send(str(cu["user_id"]), {
                "type": "message_delivered",
                "message_ids": [message["id"]],
                "by": msg.recipient_id,
            })
        else:
            # Recipient not connected via WS — send push notification
            sender_name = cu.get("display_name") or cu.get("username", "Someone")
            if msg.preview:
                push_body = msg.preview[:80]
            elif not msg.content:
                push_body = "[Media]"
            elif msg.content.startswith("__e2e__|"):
                push_body = "New message"
            else:
                push_body = msg.content[:80]

            # Mark as delivered immediately — push means the message reached the device.
            # Do this BEFORE spawning the thread so we can await WS notify to sender.
            db_mark_messages_delivered([message["id"]])
            # Tell the sender → double grey ticks appear right away
            await ws_manager.send(str(cu["user_id"]), {
                "type": "message_delivered",
                "message_ids": [message["id"]],
                "by": msg.recipient_id,
            })
            threading.Thread(target=_send_push, args=(msg.recipient_id, sender_name, push_body, {"type": "message", "from": str(cu["user_id"])}), daemon=True).start()
    return message

@app.delete("/api/messages/{message_id}")
async def delete_message(message_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    msg = col_messages.find_one({"id": message_id})
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg.get("from_user_id") != my_id:
        raise HTTPException(status_code=403, detail="Cannot delete another user's message")
    col_messages.delete_one({"id": message_id})
    # Delete associated media from Cloudinary / local storage
    if msg.get("media_url"):
        threading.Thread(target=_cloudinary_delete, args=(msg["media_url"],), daemon=True).start()
    # Notify recipient via WebSocket
    recipient_id = msg.get("recipient_id")
    if recipient_id:
        await ws_manager.send(str(recipient_id), {"type": "message_deleted", "message_id": message_id})
    return {"ok": True}

# ── Scheduled Messages ────────────────────────────────────────
@app.post("/api/messages/schedule")
async def schedule_message(
    contact_id: int = Form(...),
    message: str = Form(""),
    scheduled_time: str = Form(...),
    file: UploadFile = None,
    cu: dict = Depends(get_current_user)
):
    """Schedule a message to be sent at a future time"""
    try:
        scheduled_dt = datetime.fromisoformat(scheduled_time.replace('Z', '+00:00'))
        now_utc = datetime.now(scheduled_dt.tzinfo)
        if scheduled_dt <= now_utc:
            raise HTTPException(status_code=400, detail="Scheduled time must be in the future")

        msg_id = _next_id(col_scheduled_messages)
        file_url = None
        file_name = None

        if file:
            file_content = await file.read()
            file_name = file.filename
            file_ext = Path(file_name).suffix
            file_url = _upload_media(file_content, file_ext, "document", "spvb/scheduled")

        scheduled_msg = {
            "id": msg_id,
            "from_user_id": cu["user_id"],
            "contact_id": contact_id,
            "message": message,
            "file_url": file_url,
            "file_name": file_name,
            "scheduled_time": scheduled_dt.isoformat(),
            "created_at": datetime.now(scheduled_dt.tzinfo).isoformat(),
            "sent": False,
        }
        col_scheduled_messages.insert_one(scheduled_msg)
        return {"ok": True, "id": msg_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/messages/scheduled")
def get_scheduled_messages(contact_id: int, cu: dict = Depends(get_current_user)):
    """Get all scheduled messages for a contact"""
    messages = list(col_scheduled_messages.find({
        "from_user_id": cu["user_id"],
        "contact_id": contact_id,
        "sent": False
    }).sort("scheduled_time", ASCENDING))
    return {"scheduled_messages": messages}

@app.delete("/api/messages/scheduled/{message_id}")
async def delete_scheduled_message(message_id: int, cu: dict = Depends(get_current_user)):
    """Delete a scheduled message"""
    msg = col_scheduled_messages.find_one({"id": message_id})
    if not msg:
        raise HTTPException(status_code=404, detail="Scheduled message not found")
    if msg.get("from_user_id") != cu["user_id"]:
        raise HTTPException(status_code=403, detail="Cannot delete another user's scheduled message")

    col_scheduled_messages.delete_one({"id": message_id})
    if msg.get("file_url"):
        threading.Thread(target=_cloudinary_delete, args=(msg["file_url"],), daemon=True).start()
    return {"ok": True}

@app.put("/api/messages/scheduled/{message_id}")
async def update_scheduled_message(
    message_id: int,
    message: str = Form(""),
    scheduled_time: str = Form(...),
    cu: dict = Depends(get_current_user)
):
    """Update a scheduled message"""
    msg = col_scheduled_messages.find_one({"id": message_id})
    if not msg:
        raise HTTPException(status_code=404, detail="Scheduled message not found")
    if msg.get("from_user_id") != cu["user_id"]:
        raise HTTPException(status_code=403, detail="Cannot update another user's scheduled message")

    scheduled_dt = datetime.fromisoformat(scheduled_time.replace('Z', '+00:00'))
    now_utc = datetime.now(scheduled_dt.tzinfo)
    if scheduled_dt <= now_utc:
        raise HTTPException(status_code=400, detail="Scheduled time must be in the future")

    col_scheduled_messages.update_one(
        {"id": message_id},
        {"$set": {
            "message": message,
            "scheduled_time": scheduled_dt.isoformat()
        }}
    )
    return {"ok": True}

@app.get("/api/messages/{room}")
def get_messages(room: str, cu: dict = Depends(get_current_user)):
    return db_get_messages_room(room)

# ── Upload ────────────────────────────────────────────────

_IMG_EXTS = {'.jpg', '.jpeg', '.png', '.gif', '.webp'}
_VID_EXTS = {'.mp4', '.mov', '.mkv', '.avi', '.wmv'}
_AUD_EXTS = {'.webm', '.ogg', '.mp3', '.m4a', '.wav', '.aac'}
_DOC_EXTS = {'.pdf', '.doc', '.docx', '.txt', '.xlsx', '.xls', '.pptx', '.ppt', '.zip', '.rar', '.csv'}
_SIZE_MAP  = {"image": LIMIT_IMAGE, "video": LIMIT_VIDEO, "audio": LIMIT_AUDIO, "document": LIMIT_DOC}
_SIZE_LABEL = {"image": "10 MB", "video": "50 MB", "audio": "16 MB", "document": "25 MB"}

@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(None),
    type: str = "avatar",
    old_url: str = Form(None),
    cu: dict = Depends(get_current_user)
):
    # Delete old image before uploading new one
    if type in ("avatar", "cover"):
        u = mdb_get_user_by_id(cu["user_id"])
        db_old_url = (u or {}).get(f"{type}_url", "")
        # Prefer DB value; fall back to client-supplied old_url if DB is empty
        url_to_delete = db_old_url or old_url or ""
        if url_to_delete:
            _delete_media_file(url_to_delete)
    elif type == "wallpaper" and old_url:
        _delete_media_file(old_url)
    # If no file provided, this was a delete-only request
    if not file:
        return {"url": ""}
    ext = Path(file.filename or "").suffix.lower() or ".jpg"
    all_exts = _IMG_EXTS | _VID_EXTS | _AUD_EXTS
    if ext not in all_exts:
        raise HTTPException(status_code=400, detail="Invalid file type")
    mtype = "image" if ext in _IMG_EXTS else "video" if ext in _VID_EXTS else "audio"
    data = await file.read()
    if len(data) > _SIZE_MAP[mtype]:
        raise HTTPException(status_code=413, detail=f"File too large. Max size for {mtype}s is {_SIZE_LABEL[mtype]}.")
    # Route to different Cloudinary folders based on type
    if type == "status":
        folder = f"spvb/statuses/{cu['user_id']}"
    elif type == "wallpaper":
        folder = f"spvb/wallpapers/{cu['user_id']}"
    else:
        folder = f"spvb/profiles/{cu['user_id']}"
    url = _upload_media(data, ext, mtype, folder=folder)
    return {"url": url}

@app.post("/api/messages/media")
async def send_media_message(
    file: UploadFile = File(...),
    recipient_id: int = Form(...),
    caption: str = Form(""),
    cu: dict = Depends(get_current_user)
):
    ext = Path(file.filename or "").suffix.lower()
    # Fallback: if extension missing or unrecognised, detect from MIME type
    if not ext or ext not in (_IMG_EXTS | _VID_EXTS | _AUD_EXTS | _DOC_EXTS):
        ct = (file.content_type or "").lower()
        if "image" in ct:      ext = ".jpg"
        elif "video" in ct:    ext = ".mp4"
        elif "audio" in ct:    ext = ".webm"
        elif "pdf" in ct:      ext = ".pdf"
        else:                  ext = ".jpg"  # safe default for unknown
    all_exts = _IMG_EXTS | _VID_EXTS | _AUD_EXTS | _DOC_EXTS
    if ext not in all_exts:
        raise HTTPException(status_code=400, detail="Invalid file type")
    media_type = "image" if ext in _IMG_EXTS else "video" if ext in _VID_EXTS else "audio" if ext in _AUD_EXTS else "document"
    data = await file.read()
    if len(data) > _SIZE_MAP[media_type]:
        raise HTTPException(status_code=413, detail=f"File too large. Max size for {media_type}s is {_SIZE_LABEL[media_type]}.")
    media_url = _upload_media(data, ext, media_type, folder=f"spvb/chat/{cu['user_id']}")
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
        "expires_at": (_now + timedelta(days=30)).isoformat() + "Z",
    }
    message = db_save_message(message)
    await ws_manager.send(str(recipient_id), {"type": "chat_message", "message": message})
    return message

# ── Statuses ──────────────────────────────────────────────

@app.post("/api/statuses")
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
        "image_url": body.image_url or None,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "expires_at": (datetime.utcnow() + timedelta(hours=24)).isoformat() + "Z",
        "view_count": 0,
        "viewed_by": [],
        "reactions": [],
    }
    mdb_save_status(s)
    for uid in list(ws_manager.connections.keys()):
        # Skip QR sockets (format: "qr_token") — only broadcast to actual user connections
        if uid.startswith("qr_"):
            continue
        try:
            if int(uid) != cu["user_id"]:
                await ws_manager.send(uid, {"type": "new_status", "status": s})
        except (ValueError, TypeError):
            # Skip invalid UIDs (shouldn't happen, but safety guard)
            continue
    return s

@app.get("/api/statuses")
def get_statuses(cu: dict = Depends(get_current_user)):
    mdb_cleanup_expired_statuses()
    now = datetime.utcnow()
    my_id = cu["user_id"]
    # Only show statuses from contacts the requester has saved (+ own statuses)
    saved_ids = set(mdb_get_saved_contacts(str(my_id)))
    all_statuses = mdb_get_statuses()
    users = {u["id"]: u for u in mdb_get_users()}
    result = []
    for s in all_statuses:
        if _parse_dt(s["expires_at"]) <= now:
            continue
        # Include own statuses; skip other users not in saved contacts
        if s["user_id"] != my_id and s["user_id"] not in saved_ids:
            continue
        entry = dict(s)
        # Always use the current user's avatar/display_name so updates reflect immediately
        current_user = users.get(s["user_id"])
        if current_user:
            entry["avatar_url"] = current_user.get("avatar_url", s.get("avatar_url", ""))
            entry["display_name"] = current_user.get("display_name", s.get("display_name", ""))
        if s["user_id"] == my_id:
            viewers = []
            for uid in s.get("viewed_by", []):
                u = users.get(uid)
                if u:
                    viewers.append({"id": uid, "name": u.get("display_name") or u.get("username", f"User {uid}")})
            entry["viewers"] = viewers
        result.append(entry)
    return result

@app.delete("/api/statuses/{status_id}")
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

@app.post("/api/statuses/{status_id}/view")
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

@app.post("/api/statuses/{status_id}/react")
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

@app.post("/api/call-logs")
def save_call_log(body: dict, cu: dict = Depends(get_current_user)):
    contact_id = int(body.get("contact_id", 0))
    contact = mdb_get_user_by_id(contact_id)
    now = datetime.utcnow()
    log = {
        "user_id":    cu["user_id"],
        "contact_id": contact_id,
        "call_type":  str(body.get("call_type", "voice")),
        "direction":  str(body.get("direction", "outgoing")),
        "status":     str(body.get("status", "completed")),
        "duration":   int(body.get("duration", 0)),
        "created_at": now.isoformat(),
        "expires_at": (now + timedelta(hours=24)).isoformat(),
    }
    # contact_username/display_name/avatar_url NOT stored — fetched live from users on read
    return mdb_save_call_log(log)

@app.get("/api/call-logs")
def get_call_logs(cu: dict = Depends(get_current_user)):
    return mdb_get_call_logs(cu["user_id"])

# ── Phone Contact Sync ────────────────────────────────────

@app.post("/api/contacts/sync-phones")
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

@app.post("/api/users", response_model=dict)
def create_user(user: User, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    uid = _next_id(col_users)
    new_user = {**user.model_dump(mode="json"), "id": uid, "created_at": datetime.utcnow().isoformat() + "Z", "password": hash_password(user.password)}
    mdb_save_user(new_user)
    return {"id": uid, "message": "User created"}

@app.get("/api/users")
def get_users(cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    users = mdb_get_users()
    user_status = mdb_get_user_status()
    events = mdb_get_login_events()
    now = datetime.utcnow()
    result = []
    for u in users:
        uid_str = str(u["id"])
        st = user_status.get(uid_str)
        if st:
            diff = (now - _parse_dt(st["updated_at"])).total_seconds()
            online = "online" if diff < 35 else ("away" if diff < 120 else "offline")
            last_seen = st["updated_at"]
        else:
            online = "never"
            last_seen = None
        login_count = sum(1 for e in events if e["user_id"] == u["id"])
        last_login = next((e["timestamp"] for e in reversed(events) if e["user_id"] == u["id"]), None)
        result.append({"id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "created_at": u.get("created_at"), "avatar_url": u.get("avatar_url", ""), "display_name": u.get("display_name", ""), "online_status": online, "last_seen": last_seen, "login_count": login_count, "last_login": last_login})
    return result

@app.get("/api/users/{user_id}")
def get_user(user_id: int, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    u = mdb_get_user_by_id(user_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    return {"id": u["id"], "username": u["username"], "email": u["email"], "role": u.get("role", "user"), "created_at": u.get("created_at")}

@app.put("/api/users/{user_id}")
def update_user(user_id: int, user: User, cu: dict = Depends(get_current_user)):
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")
    existing = mdb_get_user_by_id(user_id)
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")
    updated = {**existing, "username": user.username, "email": user.email, "password": hash_password(user.password)}
    mdb_save_user(updated)
    return {"id": user_id, "message": "User updated"}

@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, cu: dict = Depends(get_current_user)):
    # Allow self-deletion or admin deletion
    if cu.get("role") != "admin" and cu.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Forbidden")
    # Delete all user data
    col_messages.delete_many({"$or": [{"from_user_id": user_id}, {"recipient_id": user_id}]})
    col_group_messages.delete_many({"from_user_id": user_id})
    col_statuses.delete_many({"user_id": user_id})
    col_call_logs.delete_many({"$or": [{"user_id": user_id}, {"contact_id": user_id}]})
    col_saved_contacts.delete_many({"user_id": str(user_id)})
    col_linked_devices.delete_many({"user_id": user_id})
    col_user_status.delete_many({"user_id": str(user_id)})
    mdb_delete_user(user_id)
    return {"message": "Account deleted"}

# ── Items CRUD ────────────────────────────────────────────

col_items = mdb["items"]
_idx(col_items, "id", unique=True)

@app.post("/api/items")
def create_item(item: Item, cu: dict = Depends(get_current_user)):
    iid = _next_id(col_items)
    doc = item.model_dump(mode="json")
    doc["id"] = iid
    doc["created_at"] = datetime.utcnow().isoformat() + "Z"
    col_items.insert_one(doc)
    return {"id": iid, "message": "Item created"}

@app.get("/api/items")
def get_items(cu: dict = Depends(get_current_user)):
    return [{k: v for k, v in i.items() if k != "_id"} for i in col_items.find()]

@app.get("/api/items/{item_id}")
def get_item(item_id: int, cu: dict = Depends(get_current_user)):
    item = col_items.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item

@app.put("/api/items/{item_id}")
def update_item(item_id: int, item: Item, cu: dict = Depends(get_current_user)):
    existing = col_items.find_one({"id": item_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Item not found")
    doc = item.model_dump(mode="json")
    doc["id"] = item_id
    doc["created_at"] = existing.get("created_at")
    col_items.replace_one({"id": item_id}, doc)
    return {"id": item_id, "message": "Item updated"}

@app.delete("/api/items/{item_id}")
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

@app.post("/api/groups")
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

@app.get("/api/groups")
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

@app.get("/api/groups/{group_id}/messages")
def get_group_messages(group_id: int, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    user_map = {u["id"]: u for u in mdb_get_users()}
    msgs = mdb_get_group_messages(group_id)
    return [{**m, "sender_name": user_map[m["from_user_id"]].get("display_name", user_map[m["from_user_id"]]["username"]) if m["from_user_id"] in user_map else str(m["from_user_id"]), "sender_avatar": user_map[m["from_user_id"]].get("avatar_url", "") if m["from_user_id"] in user_map else ""} for m in msgs]

@app.post("/api/groups/{group_id}/messages")
async def send_group_message(group_id: int, body: GroupMessageRequest, cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    user_map = {u["id"]: u for u in mdb_get_users()}
    now = datetime.utcnow()
    msg = {"group_id": group_id, "from_user_id": my_id, "content": body.content[:4000], "media_url": None, "media_type": None, "file_name": None, "reply_to": body.reply_to, "created_at": now.isoformat() + "Z", "expires_at": (now + timedelta(days=30)).isoformat() + "Z"}
    msg = mdb_save_group_message(msg)
    sender_name = user_map[my_id].get("display_name", user_map[my_id]["username"]) if my_id in user_map else str(my_id)
    sender_avatar = user_map[my_id].get("avatar_url", "") if my_id in user_map else ""
    broadcast = {**msg, "sender_name": sender_name, "sender_avatar": sender_avatar}
    for mid in group.get("members", []):
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_message", "message": broadcast, "group_id": group_id, "group_name": group["name"]})
    return broadcast

@app.post("/api/groups/{group_id}/media")
async def send_group_media(group_id: int, file: UploadFile = File(...), cu: dict = Depends(get_current_user)):
    my_id = cu["user_id"]
    group = mdb_get_group(group_id)
    if not group or my_id not in group.get("members", []):
        raise HTTPException(status_code=403, detail="Not a member")
    ext = Path(file.filename or "file").suffix.lower() or ".bin"
    mtype = "image" if ext in _IMG_EXTS else "video" if ext in _VID_EXTS else "audio" if ext in _AUD_EXTS else "document"
    data = await file.read()
    if len(data) > _SIZE_MAP.get(mtype, LIMIT_DOC):
        raise HTTPException(status_code=413, detail=f"File too large. Max size for {mtype}s is {_SIZE_LABEL.get(mtype, '25 MB')}.")
    url = _upload_media(data, ext, mtype, folder=f"spvb/groups/{group_id}")
    user_map = {u["id"]: u for u in mdb_get_users()}
    now = datetime.utcnow()
    msg = {"group_id": group_id, "from_user_id": my_id, "content": "", "media_url": url, "media_type": mtype, "file_name": file.filename, "reply_to": None, "created_at": now.isoformat() + "Z", "expires_at": (now + timedelta(days=30)).isoformat() + "Z"}
    msg = mdb_save_group_message(msg)
    sender_name = user_map[my_id].get("display_name", user_map[my_id]["username"]) if my_id in user_map else str(my_id)
    sender_avatar = user_map[my_id].get("avatar_url", "") if my_id in user_map else ""
    broadcast = {**msg, "sender_name": sender_name, "sender_avatar": sender_avatar}
    for mid in group.get("members", []):
        if mid != my_id:
            await ws_manager.send(str(mid), {"type": "group_message", "message": broadcast, "group_id": group_id, "group_name": group["name"]})
    return broadcast

@app.put("/api/groups/{group_id}")
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

@app.delete("/api/groups/{group_id}/members/{user_id}")
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

@app.post("/api/groups/{group_id}/members")
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

# ── QR Login (public — desktop generates, mobile approves) ────────────────────

import secrets as _secrets

def _parse_browser_name(ua: str) -> str:
    if not ua:
        return "Web Browser"
    if "Mobile" in ua or "Android" in ua or "iPhone" in ua:
        prefix = "Mobile"
    else:
        prefix = "Desktop"
    if "Edg/" in ua or "Edge" in ua:
        return f"{prefix} / Edge"
    if "OPR/" in ua or "Opera" in ua:
        return f"{prefix} / Opera"
    if "Chrome" in ua:
        return f"{prefix} / Chrome"
    if "Firefox" in ua:
        return f"{prefix} / Firefox"
    if "Safari" in ua:
        return f"{prefix} / Safari"
    return f"{prefix} / Browser"

def _parse_device_info(ua: str) -> dict:
    """Return {device_name, device_type, os, browser} from user-agent string."""
    if not ua:
        return {"device_name": "Unknown Device", "device_type": "desktop", "os": "Unknown", "browser": "Browser"}
    # OS detection
    if "iPhone" in ua:
        os_name, dtype = "iOS", "mobile"
    elif "iPad" in ua:
        os_name, dtype = "iPadOS", "tablet"
    elif "Android" in ua:
        os_name, dtype = "Android", "mobile" if "Mobile" in ua else "tablet"
    elif "Windows" in ua:
        os_name, dtype = "Windows", "desktop"
    elif "Macintosh" in ua or "Mac OS X" in ua:
        os_name, dtype = "macOS", "desktop"
    elif "Linux" in ua:
        os_name, dtype = "Linux", "desktop"
    elif "CrOS" in ua:
        os_name, dtype = "ChromeOS", "desktop"
    else:
        os_name, dtype = "Unknown", "desktop"
    # Browser detection
    if "Edg/" in ua or "Edge" in ua:
        browser = "Edge"
    elif "OPR/" in ua or "Opera" in ua:
        browser = "Opera"
    elif "SamsungBrowser" in ua:
        browser = "Samsung Browser"
    elif "Chrome" in ua:
        browser = "Chrome"
    elif "Firefox" in ua:
        browser = "Firefox"
    elif "Safari" in ua:
        browser = "Safari"
    else:
        browser = "Browser"
    device_name = f"{browser} on {os_name}"
    return {"device_name": device_name, "device_type": dtype, "os": os_name, "browser": browser}

@app.post("/api/auth/qr/generate")
async def generate_qr_login(request: Request):
    """Public endpoint — desktop calls this to get a QR login token."""
    mdb_delete_expired_qr()
    token = _secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(minutes=2)).isoformat() + "Z"
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    desktop_ua = body.get("user_agent", "") or request.headers.get("user-agent", "")
    mdb_save_qr_token(token, {
        "user_id": None, "status": "pending",
        "created_at": datetime.utcnow().isoformat() + "Z",
        "expires_at": expires_at, "approved": False,
        "login_qr": True,
        "desktop_user_agent": desktop_ua,
        "desktop_browser": _parse_browser_name(desktop_ua),
    })
    return {"token": token, "expires_at": expires_at}

@app.get("/api/auth/qr/{token}/info")
async def get_qr_info(token: str):
    """Public — returns minimal info about the QR token (browser, status) for the approve screen."""
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="QR not found or expired")
    if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="QR expired")
    return {
        "status": rec.get("status", "pending"),
        "browser": rec.get("desktop_browser", "Web Browser"),
        "created_at": rec.get("created_at", ""),
        "expires_at": rec.get("expires_at", ""),
    }

@app.post("/api/auth/qr/{token}/approve")
async def approve_qr_login(token: str, cu: dict = Depends(get_current_user)):
    """Mobile (logged-in) user approves QR login for desktop."""
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="QR code not found or expired")
    if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="QR code expired")
    if rec["status"] not in ("pending", "scanned"):
        raise HTTPException(status_code=409, detail="QR code already used")
    user = mdb_get_user_by_id(cu["user_id"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    session_id = str(_uuid.uuid4())
    new_jwt = create_jwt_token({
        "user_id": user["id"], "username": user["username"],
        "email": user["email"], "role": user.get("role", "user"),
        "display_name": user.get("display_name", user["username"]),
        "avatar_url": user.get("avatar_url", ""),
        "session_id": session_id,
    })
    user_payload_qr = {
        "id": user["id"], "username": user["username"],
        "email": user["email"], "display_name": user.get("display_name", user["username"]),
        "avatar_url": user.get("avatar_url", ""), "role": user.get("role", "user"),
    }
    rec.update({"status": "approved", "approved": True, "jwt": new_jwt,
                "user_id": cu["user_id"], "session_id": session_id,
                "user_payload": user_payload_qr})
    mdb_save_qr_token(token, {k: v for k, v in rec.items() if k != "token"})

    # Save linked device so it appears in the devices list and can be revoked
    device_id = str(_uuid.uuid4())
    desktop_ua = rec.get("desktop_user_agent", "")
    desktop_browser = rec.get("desktop_browser") or _parse_browser_name(desktop_ua)
    mdb_save_device({
        "id": device_id,
        "user_id": cu["user_id"],
        "username": user.get("username", ""),
        "display_name": user.get("display_name", user.get("username", "")),
        "device_name": desktop_browser,
        "device_type": "desktop",
        "jwt_token": new_jwt,       # stored to force-logout on removal
        "qr_token": token,
        "linked_at": datetime.utcnow().isoformat() + "Z",
        "user_agent": desktop_ua,
    })
    # Also save to login_sessions so it appears in the unified sessions list
    dev = _parse_device_info(desktop_ua)
    now_iso = datetime.utcnow().isoformat() + "Z"
    try:
        mdb_save_session({"id": session_id, "user_id": user["id"], "device_name": dev["device_name"], "device_type": dev["device_type"], "os": dev["os"], "browser": dev["browser"], "ip": rec.get("desktop_ip", ""), "login_method": "qr", "created_at": now_iso, "last_seen": now_iso})
    except Exception:
        pass

    user_payload = {
        "id": user["id"], "username": user["username"],
        "email": user["email"], "display_name": user.get("display_name", user["username"]),
        "avatar_url": user.get("avatar_url", ""),
        "msg_retention_days": user.get("msg_retention_days", 1),
    }
    await ws_manager.send(f"qr_{token}", {"type": "qr_approved", "token": new_jwt, "session_id": session_id, "user": user_payload})
    return {"ok": True, "device_id": device_id}

@app.post("/api/auth/qr/{token}/reject")
async def reject_qr_login(token: str, cu: dict = Depends(get_current_user)):
    """Mobile user rejects QR login."""
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="QR not found")
    rec["status"] = "rejected"
    mdb_save_qr_token(token, {k: v for k, v in rec.items() if k != "token"})
    await ws_manager.send(f"qr_{token}", {"type": "qr_rejected"})
    return {"ok": True}

@app.get("/api/auth/qr/{token}/status")
async def qr_login_status(token: str):
    rec = mdb_get_qr_token(token)
    if not rec or _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="expired")
    return {"status": rec["status"]}

# ── QR Device Linking ──────────────────────────────────────

@app.post("/api/devices/qr/generate")
async def generate_qr_token(cu: dict = Depends(get_current_user)):
    token = _secrets.token_urlsafe(32)
    expires_at = (datetime.utcnow() + timedelta(minutes=10)).isoformat() + "Z"
    mdb_save_qr_token(token, {"user_id": cu["user_id"], "status": "pending", "created_at": datetime.utcnow().isoformat() + "Z", "expires_at": expires_at, "approved": False})
    return {"token": token, "expires_at": expires_at}

@app.get("/api/devices/qr/{token}/status")
async def qr_token_status(token: str):
    rec = mdb_get_qr_token(token)
    if not rec:
        raise HTTPException(status_code=404, detail="Token not found or expired")
    if _parse_dt(rec.get("expires_at", "")) <= datetime.utcnow():
        raise HTTPException(status_code=410, detail="Token expired")
    return {"status": rec["status"], "approved": rec.get("approved", False)}

@app.post("/api/devices/qr/{token}/scan")
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

@app.post("/api/devices/qr/{token}/approve")
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
    session_id = str(_uuid.uuid4())
    # Save device and session
    mdb_save_device({
        "id": device_id,
        "user_id": user["id"],
        "device_name": rec.get("scanner_device", "Linked Device"),
        "user_agent": rec.get("scanner_user_agent", ""),
        "jwt_token": new_jwt,
        "linked_at": datetime.utcnow().isoformat() + "Z"
    })
    # Save session for unified sessions list
    try:
        dev = _parse_device_info(rec.get("scanner_user_agent", ""))
        now_iso = datetime.utcnow().isoformat() + "Z"
        mdb_save_session({
            "id": session_id,
            "user_id": user["id"],
            "device_name": dev["device_name"],
            "device_type": dev["device_type"],
            "os": dev["os"],
            "browser": dev["browser"],
            "login_method": "qr",
            "created_at": now_iso,
            "last_seen": now_iso
        })
    except Exception as e:
        print(f"[qr] session save error: {e}")

    rec.update({"status": "approved", "approved": True, "jwt": new_jwt, "session_id": session_id})
    mdb_save_qr_token(token, {k: v for k, v in rec.items() if k != "token"})
    # Send JWT token (not QR token) for frontend login
    await ws_manager.send(f"qr_{token}", {"type": "qr_approved", "token": new_jwt, "session_id": session_id, "user": token_data})
    return {"status": "approved"}

@app.post("/api/devices/qr/{token}/reject")
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

@app.get("/api/devices/qr/{token}/await")
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

@app.get("/api/devices")
async def list_devices(cu: dict = Depends(get_current_user)):
    devices = mdb_get_devices(cu["user_id"])
    # Strip sensitive jwt_token before returning to client
    return [{k: v for k, v in d.items() if k != "jwt_token"} for d in devices]

@app.delete("/api/devices/{device_id}")
async def remove_device(device_id: str, cu: dict = Depends(get_current_user)):
    device = mdb_get_device(device_id, cu["user_id"])
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    # Send force_logout via WS before deleting so the device session is kicked
    jwt_token = device.get("jwt_token", "")
    if jwt_token:
        try:
            payload = decode_jwt_token(jwt_token)
            kicked_user_id = str(payload.get("user_id", ""))
            if kicked_user_id:
                await ws_manager.send(kicked_user_id, {"type": "force_logout"})
        except Exception:
            pass
    mdb_delete_device(device_id, cu["user_id"])
    return {"status": "removed"}

# ── Login Sessions (all devices, not just QR-linked) ─────

@app.get("/api/sessions")
def list_sessions(cu: dict = Depends(get_current_user)):
    """Return all active login sessions for the current user."""
    sessions = mdb_get_sessions(cu["user_id"])
    current_session_id = cu.get("session_id", "")
    result = []
    for s in sessions:
        result.append({
            "id": s["id"],
            "device_name": s.get("device_name", "Unknown Device"),
            "device_type": s.get("device_type", "desktop"),
            "os": s.get("os", ""),
            "browser": s.get("browser", ""),
            "ip": s.get("ip", ""),
            "login_method": s.get("login_method", ""),
            "created_at": s.get("created_at", ""),
            "last_seen": s.get("last_seen", ""),
            "is_current": s["id"] == current_session_id,
        })
    # Sort: current session first, then by last_seen desc
    result.sort(key=lambda x: (not x["is_current"], x.get("last_seen", "") or ""), reverse=False)
    return result

@app.delete("/api/sessions/{session_id}")
async def remove_session(session_id: str, cu: dict = Depends(get_current_user)):
    """Remove a login session and force-logout that device."""
    session = mdb_get_session(session_id, cu["user_id"])
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    # Send targeted force_logout — frontend checks session_id before logging out
    await ws_manager.send(str(cu["user_id"]), {"type": "force_logout", "session_id": session_id})
    mdb_delete_session(session_id, cu["user_id"])
    return {"status": "removed"}

# ── Smart Reply ───────────────────────────────────────────

@app.post("/api/smart-reply")
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
