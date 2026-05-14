"""
Seed script — inserts test data into MongoDB so you can test all APIs.
Run: python3 seed_data.py

Test credentials after seeding:
  alice@test.com  / Test@123
  bob@test.com    / Test@123
  carol@test.com  / Test@123
"""
import os, hashlib
from datetime import datetime, timedelta
from dotenv import load_dotenv
from pymongo import MongoClient, DESCENDING
import urllib.parse

load_dotenv()

# ── Connect ───────────────────────────────────────────────
def _fix_uri(uri):
    try:
        scheme, rest = uri.split("://", 1)
        creds, host = rest.rsplit("@", 1)
        user, pw = creds.split(":", 1)
        pw = pw.strip("<>")
        return f"{scheme}://{urllib.parse.quote_plus(user)}:{urllib.parse.quote_plus(pw)}@{host}"
    except Exception:
        return uri

uri = _fix_uri(os.getenv("MONGODB_URI", ""))
client = MongoClient(uri)
db_name = uri.rsplit("/", 1)[-1].split("?")[0].strip() or "chatapp"
db = client[db_name]

# ── Helpers ───────────────────────────────────────────────
def hash_pw(p): return hashlib.sha256(p.encode()).hexdigest()

def next_id(col):
    docs = list(col.find({}, {"id": 1, "_id": 0}).sort("id", DESCENDING).limit(1))
    return (docs[0]["id"] + 1) if docs else 1

now = datetime.utcnow()

# ── Clear existing test data ──────────────────────────────
print("Clearing old seed data...")
db["users"].delete_many({"email": {"$in": ["alice@test.com", "bob@test.com", "carol@test.com"]}})

# ── Users ─────────────────────────────────────────────────
print("Inserting users...")
users = []
for name, email in [("alice", "alice@test.com"), ("bob", "bob@test.com"), ("carol", "carol@test.com")]:
    uid = next_id(db["users"])
    u = {
        "id": uid,
        "username": name,
        "display_name": name.capitalize(),
        "email": email,
        "password": hash_pw("Test@123"),
        "phone": None,
        "role": "user",
        "created_at": now.isoformat(),
        "avatar_url": None,
        "cover_url": None,
        "about": f"Hi, I am {name.capitalize()}!",
        "has_password": True,
        "google_id": None,
        "pubkey": None,
    }
    db["users"].insert_one(u)
    users.append(u)
    print(f"  Created user: {name} (id={uid})")

alice, bob, carol = users

# ── Direct Messages ───────────────────────────────────────
print("Inserting direct messages...")
room_ab = f"dm_{min(alice['id'], bob['id'])}_{max(alice['id'], bob['id'])}"
exp = (now + timedelta(days=7)).isoformat()

for sender, recipient, text in [
    (alice, bob, "Hey Bob! How are you?"),
    (bob, alice, "Hey Alice! I am doing great, thanks!"),
    (alice, bob, "Want to hop on a call later?"),
    (bob, alice, "Sure! Let's do 5 PM."),
]:
    mid = next_id(db["messages"])
    db["messages"].insert_one({
        "id": mid,
        "sender": sender["username"],
        "message": text,
        "timestamp": now.isoformat(),
        "room": room_ab,
        "from_user_id": sender["id"],
        "recipient_id": recipient["id"],
        "encrypted": 0,
        "is_read": 0,
        "reply_to": None,
        "media_url": None,
        "media_type": None,
        "file_name": None,
        "expires_at": exp,
    })

print(f"  Inserted 4 messages in room {room_ab}")

# ── Group ─────────────────────────────────────────────────
print("Inserting group...")
gid = next_id(db["groups"])
db["groups"].insert_one({
    "id": gid,
    "name": "Team Chat",
    "creator_id": alice["id"],
    "members": [alice["id"], bob["id"], carol["id"]],
    "created_at": now.isoformat(),
    "avatar_url": None,
})

for sender, text in [
    (alice, "Welcome to Team Chat everyone!"),
    (bob, "Thanks Alice 👋"),
    (carol, "Hey team! Excited to be here."),
]:
    gmid = next_id(db["group_messages"])
    db["group_messages"].insert_one({
        "id": gmid,
        "group_id": gid,
        "from_user_id": sender["id"],
        "content": text,
        "media_url": None,
        "media_type": None,
        "file_name": None,
        "reply_to": None,
        "created_at": now.isoformat(),
        "expires_at": exp,
    })

print(f"  Created group 'Team Chat' (id={gid}) with 3 messages")

# ── Status ────────────────────────────────────────────────
print("Inserting status...")
sid = next_id(db["statuses"])
db["statuses"].insert_one({
    "id": sid,
    "user_id": alice["id"],
    "username": alice["username"],
    "display_name": alice["display_name"],
    "avatar_url": None,
    "content": "Hello World! This is my first status 🎉",
    "type": "text",
    "color": "#075E54",
    "video_url": None,
    "created_at": now.isoformat(),
    "expires_at": (now + timedelta(hours=24)).isoformat(),
    "view_count": 0,
    "viewed_by": [],
    "reactions": [],
})
print(f"  Created status (id={sid})")

# ── Call Logs ─────────────────────────────────────────────
print("Inserting call logs...")
clid = next_id(db["call_logs"])
db["call_logs"].insert_one({
    "id": clid,
    "user_id": alice["id"],
    "contact_id": bob["id"],
    "contact_username": bob["username"],
    "contact_display_name": bob["display_name"],
    "contact_avatar_url": None,
    "call_type": "voice",
    "direction": "outgoing",
    "status": "completed",
    "duration": 120,
    "created_at": now.isoformat(),
    "expires_at": (now + timedelta(days=30)).isoformat(),
})
print(f"  Created call log (id={clid})")

print()
print("=" * 50)
print("Seed complete!")
print("=" * 50)
print()
print("Login credentials:")
print("  alice@test.com  /  Test@123  (id={})".format(alice["id"]))
print("  bob@test.com    /  Test@123  (id={})".format(bob["id"]))
print("  carol@test.com  /  Test@123  (id={})".format(carol["id"]))
print()
print("Next steps:")
print("  1. python3 -m uvicorn main:app --reload")
print("  2. Open http://localhost:8000/docs")
print("  3. Use POST /auth/login with above credentials to get a JWT token")
print("  4. Click 'Authorize' in Swagger and paste the token to test all APIs")
