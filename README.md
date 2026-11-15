
# Nook Watch Party
 
React/Vite watch-party app with Supabase rooms, synced playback, chat, voice, Google sign-in, private Google Drive streaming, and a video-conversion queue.
 
- **Frontend:** React + Vite (static, deployed on Vercel)
- **Backend:** Node API in `server/` (deployed on a Linux VM)
- **Realtime/data:** Supabase
## Quick start
 
Requires Node.js, `ffmpeg`, `ffprobe`, and `yt-dlp` (on `PATH`).
 
```bash
# Frontend
npm install
cp .env.example .env
 
# Backend
npm install --prefix server
cp server/.env.example server/.env
 
# Run both
npm run dev
```
 
- App: http://localhost:5173
- API: http://localhost:3001
Fill in `.env` and `server/.env` (see [Configuration](#configuration)). The API refuses to start if required secrets are missing or weak. Never commit `.env`, `server/.env`, `DATA_DIR`, or `DOWNLOAD_DIR`.
 
## Configuration
 
### Frontend (`.env`)
 
```env
VITE_API_URL=http://localhost:3001
VITE_GOOGLE_CLIENT_ID=your-oauth-client-id.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=your-restricted-picker-api-key
VITE_GOOGLE_APP_ID=your-google-cloud-project-number
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
VITE_TURN_URL=turn:relay.metered.ca:80          # optional
VITE_TURN_USERNAME=your-turn-username           # optional
VITE_TURN_CREDENTIAL=your-turn-credential       # optional
```
 
### Backend (`server/.env`)
 
See [server/.env.example](./server/.env.example) for the full list.
 
| Variable | Notes |
|---|---|
| `PUBLIC_BASE_URL` | Public API origin (used for signed stream URLs). Required in production; must not be localhost. |
| `FRONTEND_ORIGINS` | Exact, comma-separated frontend origins. No wildcards. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Same client ID as `VITE_GOOGLE_CLIENT_ID`. Keep the secret server-side only. |
| `GOOGLE_REDIRECT_URI` | Must exactly match the authorized redirect URI in Google Cloud. |
| `ALLOWED_EMAILS` | Optional. Exact lowercase emails, comma-separated. Unset = rely on Google consent screen only. |
| `SESSION_SECRET`, `STREAM_SECRET`, `TOKEN_ENCRYPTION_KEY` | Three independent secrets (see below). |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Required for the room playback queue. Service-role key not needed. |
| `DATA_DIR` | Encrypted refresh tokens and stream records. |
| `DOWNLOAD_DIR` | Conversion input/output files. |
| `MAX_SOURCE_GB` | Max download size for URL/Drive conversions. |
| `MAX_QUEUE_SIZE` | Max queued + active jobs. One conversion runs at a time. |
| `FILE_TTL_HOURS` | Converted-file lifetime (default `36`). Also drives cleanup. |
| `MIN_FREE_DISK_GB` | Pause new jobs below this free space (default `1`). |
| `FFMPEG_THREADS` | ffmpeg thread cap (default `2`, range `1`–`8`). |
 
### Generate secrets
 
Run once per variable; don't reuse values.
 
```bash
# SESSION_SECRET and STREAM_SECRET
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
 
# TOKEN_ENCRYPTION_KEY (32 bytes, base64)
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```
 
Never put server secrets in Vercel or any `VITE_*` variable.
 
## Google Cloud setup
 
1. **Project:** Create/select a project. Enable **Google Drive API** and **Google Picker API** (APIs & Services → Library).
2. **Branding & consent** (Google Auth Platform):
   - Branding: set app name, logo, support email, authorized domain, homepage, and Privacy policy URL `https://YOUR-FRONTEND-DOMAIN/privacy` (Nook serves this page; deploy it first).
   - Audience: while in *Testing*, add each allowed account as a test user.
   - Data Access: add scope `https://www.googleapis.com/auth/drive.readonly` (read-only; classified as *restricted* — public production use may require Google verification and a security assessment).
3. **OAuth client (Web application):**
   - Authorized JavaScript origins: `http://localhost:5173`, `https://your-nook-domain.example`
   - Authorized redirect URIs: `http://localhost:3001/api/auth/google/callback`, `https://api.your-nook-domain.example/api/auth/google/callback`
4. **Picker API key:** Restrict to HTTP referrers (exact frontend origins) and to **Google Picker API** only. Set as `VITE_GOOGLE_API_KEY`.
5. **Picker App ID:** Set `VITE_GOOGLE_APP_ID` to the Cloud **project number** (not the project name or client ID).
6. **Server callback:** `GOOGLE_REDIRECT_URI` must match the redirect URI above.
Notes:
- Users upgrading from the old `drive.file` scope must click **Reconnect Drive** and approve the read-only permission.
- The Picker shows only videos owned by the signed-in user in My Drive (no shared items or Shared drives).
- Sign-out clears the Nook session only. Users revoke Drive access in their Google Account settings.
## Supabase
 
Frontend uses Supabase Realtime for presence, chat, and playback broadcasts. Set up the `messages` table and its read/write policies in the SQL editor.
 
The API stores the room playback queue in `room_queues`. Create it once in the SQL editor:
 
```sql
create table room_queues (
  room_id text primary key,
  queue_items jsonb,
  version integer,
  updated_at timestamptz
);
```
 
Also add a permissive RLS policy (queue is public room state; the API is the only writer) and a `pg_cron` job named `cleanup-stale-queues` that deletes rows with `updated_at` older than 36 hours. Without the table the API still starts, but queue endpoints report an error.
 
## Deployment
 
### Frontend (Vercel)
 
Set in the Vercel project (Production and any exact Preview origins):
 
```
VITE_API_URL=https://api.your-domain.example
VITE_GOOGLE_CLIENT_ID=...
VITE_GOOGLE_API_KEY=...
VITE_GOOGLE_APP_ID=...
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_TURN_*   # optional
```
 
`vercel.json` rewrites all paths to `index.html`. Redeploy after changing any `VITE_*` value.
 
Add the deployed frontend origin to: the OAuth client's JavaScript origins, the Picker key's referrer list, and server `FRONTEND_ORIGINS`. No wildcard `.vercel.app` rules.
 
### Backend (Linux VM)
 
Use a VM with enough disk for the source download and converted output together.
 
```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3-pip pipx
pipx ensurepath
pipx install yt-dlp
ffmpeg -version && ffprobe -version && yt-dlp --version
```
 
Production `server/.env`:
 
```env
NODE_ENV=production
PUBLIC_BASE_URL=https://api.your-domain.example
FRONTEND_ORIGINS=https://your-app.vercel.app
GOOGLE_REDIRECT_URI=https://api.your-domain.example/api/auth/google/callback
```
 
Requirements:
- Run the API as a dedicated service account with write access only to `DATA_DIR` and `DOWNLOAD_DIR`.
- Both directories must be on a persistent, private filesystem (not ephemeral containers). Give `DOWNLOAD_DIR` its own filesystem/quota.
- Run a **single** API instance. The stream registry and job store are local files.
- Firewall: allow inbound TCP on the API port only.
- Restart the service after updating `yt-dlp`, `ffmpeg`, or env values. Update `yt-dlp` with `pipx upgrade yt-dlp`.
**Update and restart (PM2):**
 
```bash
cd ~/RAVE2.0/server && git pull origin main && npm install && pm2 restart nook-api
```
 
If you edited `.env`, recreate the process so it re-reads the file:
 
```bash
pm2 delete nook-api && pm2 start server.js --name nook-api && pm2 save
```
 
### Caddy (stream proxy)
 
Disable response buffering on the stream route and preserve `Range`/`Content-Range` headers so seeking works.
 
```caddyfile
api.your-domain.example {
    @videoStream path /api/stream/*
    handle @videoStream {
        reverse_proxy 127.0.0.1:3001 {
            flush_interval -1
        }
    }
 
    handle {
        reverse_proxy 127.0.0.1:3001
    }
}
```
 
## Operations
 
### CPU limits for conversions
 
- ffmpeg/ffprobe run with thread caps set by `FFMPEG_THREADS`. Raise on dedicated conversion machines; lower on small VMs.
- On Linux, media tools run under `nice -n 15` (falls back to normal priority if `nice` is unavailable). Cancelling a job kills the real ffmpeg process.
- On shared machines, keep at least one core free for the stream proxy.
### Disk and cleanup
 
- `POST /api/jobs` refuses new work when free space on `DOWNLOAD_DIR` is below `MIN_FREE_DISK_GB`. Per-job checks still require room for source + output.
- Files from cancelled/crashed jobs are removed when the job ends; a sweep runs on startup and hourly. Files in active streams are never removed.
- Converted videos are deleted after `FILE_TTL_HOURS`. Drive streams expire after 12 hours. Cleanup task runs every 10 minutes.
- Watch free space and the `Disk cleanup removed ...` log line.
### Rate limits
 
Per client address, per minute. All configurable in `server/.env`.
 
| Variable | Default | Covers |
|---|---|---|
| `API_RATE_LIMIT_PER_MIN` | 120 | All of `/api` (except media) |
| `AUTH_RATE_LIMIT_PER_MIN` | 20 | `/api/auth` (sign-in, session check) |
| `DRIVE_RATE_LIMIT_PER_MIN` | 30 | `/api/drive` (Picker token, Drive calls) |
| `JOBS_RATE_LIMIT_PER_MIN` | 20 | Starting/converting jobs |
| `MEDIA_RATE_LIMIT_PER_MIN` | 600 | `/api/stream` (media route) |
 
Raise `AUTH_RATE_LIMIT_PER_MIN` if many users share one IP (e.g. office NAT).
 
## Usage notes
 
- **Guests** can join by invite link or room code without signing in. They can watch, chat, and use voice only — no creating rooms, loading/controlling media, connecting Drive, or converting.
- **Convert page** accepts a My Drive video or any URL supported by `yt-dlp`. Drive files are detected by actual media content, so MKV/AVI work if ffmpeg supports the codecs. Google-native docs and folders aren't valid inputs.
- Convert only content you own or may legally share.
- The browser receives a 12-hour app JWT and short-lived stream URLs only. Google refresh tokens stay encrypted in `DATA_DIR`.
## Validation checklist
 
- [ ] Allowlisted, verified Google email can sign in; non-allowlisted email is rejected.
- [ ] Connect Drive, pick a video, share it, play it on a second signed-in account in the same room.
- [ ] Seeking in a Drive stream returns `206 Partial Content`.
- [ ] Tampered or expired signed stream URL returns `401`.
- [ ] HEVC/MKV Drive video is reported unplayable and offers **Convert**.
- [ ] Converted output plays in a browser and can be shared to a room.
- [ ] Cancelling during download and during ffmpeg stops the child process and removes temp files.
- [ ] Four sequential jobs complete without filling the queue.
- [ ] A 700 MB source converts successfully with enough disk space.
## Architecture
 
[![Architecture diagram](https://gitdiagram.com/diagram-badge.svg)](https://gitdiagram.com/juinaik-1/rave2.0?utm_source=readme&utm_medium=badge)
