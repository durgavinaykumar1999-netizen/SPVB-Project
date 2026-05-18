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
3. Connect your GitHub repo (push this project to GitHub first)
4. Settings:
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
   - **Python version**: 3.10+
5. Add these **Environment Variables** in Render dashboard:
   ```
   MONGODB_URI=mongodb+srv://...
   JWT_SECRET=your-secret
   JWT_ALGORITHM=HS256
   ADMIN_EMAIL=adminspvb@gmail.com
   ADMIN_PASSWORD=6c1243f8e2e1d167576607ec1a1e7ab4
   CLOUDINARY_URL=cloudinary://...
   VAPID_PUBLIC_KEY=BESgcXMBi2T6zG0JKltIB9HuOxjp21hNUBWRXDy5t1qOWfJbuK6iB0iYwKYbwvPOUyl67A1keeL_qYDA36jtoWo
   VAPID_PRIVATE_KEY=MHcCAQEEINc3BNc4xyCDMZe0XjBodEurLY3db9zAE4g1jfeJravHoAoGCCqGSM49AwEHoUQDQgAERKBxcwGLZPrMbQkqW0gH0e47GOnbWE1QFZFcPLm3Wo5Z8lu4rqIHSJjAphvC885TKXrsDWR54v+pgMDfqO2hag==
   VAPID_EMAIL=mailto:adminspvb@gmail.com
   UPLOADS_DIR=/tmp/uploads
   ```
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
   VITE_BACKEND_URL=https://spvb-backend.onrender.com
   ```
5. Deploy → your app is live at `https://your-project.vercel.app`

---

## Step 3 — Push Notifications on Mobile

Once deployed to HTTPS (Vercel + Render):
1. Open `https://your-project.vercel.app` on your phone
2. Install as PWA: browser menu → "Add to Home Screen"
3. Open the app → it will ask for notification permission → **Allow**
4. Done! You'll now receive notifications in the Android/iOS notification bar

---

## Local Development (unchanged)

```bash
start-all.bat
# Frontend: http://localhost:1402
# Backend:  http://localhost:1404
```
