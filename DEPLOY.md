# SPVB Production Deployment Guide

## Architecture
- **Frontend** → Vercel (free, HTTPS auto-configured)
- **Backend** → Render.com (free tier, FastAPI/uvicorn)
- **Database** → MongoDB Atlas (already configured)
- **Media** → Cloudinary (already configured)

HTTPS is automatic on both platforms → push notifications work on mobile.

---

## Step 1 — Deploy Backend to Render

1. Go to https://render.com → Sign up / Log in
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Python version**: 3.10+
5. Add these **Environment Variables** in the Render dashboard (use your own values — never paste real credentials here):
   ```
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/SPVB-CHAT
   JWT_SECRET=<generate a random 32+ char string>
   JWT_ALGORITHM=HS256
   ADMIN_EMAIL=<your admin email>
   ADMIN_PASSWORD=<your admin password>
   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
   VAPID_PUBLIC_KEY=<your generated VAPID public key>
   VAPID_PRIVATE_KEY=<your generated VAPID private key>
   VAPID_EMAIL=mailto:<your email>
   UPLOADS_DIR=/tmp/uploads
   ```
   > **Generate VAPID keys for free** — see the command in `backend/.env.example`

6. Deploy → copy your URL e.g. `https://spvb-backend.onrender.com`

---

## Step 2 — Deploy Frontend to Vercel

1. Go to https://vercel.com → Sign up / Log in
2. Click **New Project** → Import from GitHub
3. Settings:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. Add **Environment Variable**:
   ```
   VITE_BACKEND_URL=https://your-render-backend-url.onrender.com
   ```
5. Deploy → your app is live at `https://your-project.vercel.app`

---

## Step 3 — Push Notifications on Mobile

Once deployed to HTTPS (Vercel + Render):
1. Open your Vercel URL on your phone
2. Install as PWA: browser menu → "Add to Home Screen"
3. Open the app → it will ask for notification permission → **Allow**
4. Done! You'll now receive notifications in the Android/iOS notification bar

---

## Local Development

```bash
start-all.bat
# Frontend: http://localhost:1402
# Backend:  http://localhost:1404
```
