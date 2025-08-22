# Property Details Generator

Single Express server that serves both the API and static frontend.

## Setup

1. Install deps:

```bash
npm install
```

1. Create `.env` from `.env.example` and fill in real keys. Minimal example:

```env
GEMINI_API_KEY=your_gemini_key
GOOGLE_API_KEY=your_google_maps_key
FBI_API_KEY=your_data_gov_key
PORT=3000
CACHE_TTL_SECONDS=900
```

1. Start server:

```bash
npm run start
```

Open: <http://localhost:3000/>

(Use `npm run dev` for auto-reload.)

## Notes

- Frontend now calls the API at relative path `/api/getPropertyDetails`.
- Static files (`index.html`, `app.js`, `style.css`) are served by Express.
- In-memory cache + rate limiting included.
- Crime data: server tries city-level (agency ORI) then falls back to state-level FBI estimates.
- Crime API uses only `FBI_API_KEY`.
- Test your crime API key at `/test-fbi.html` (runs multiple auth variants, shows which succeeded).

## Deployment (Google Cloud Run + Cloud Storage)

### 1. Prerequisites

- Google Cloud project (set PROJECT_ID):

```powershell
gcloud config set project <PROJECT_ID>
```

- Enable required APIs (Run, Build, Artifact, Secret Manager optional):

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

- (Recommended) Store API keys as secrets instead of inline env vars:

```powershell
echo -n "YOUR_GEMINI_KEY" | gcloud secrets create GEMINI_API_KEY --data-file=-
echo -n "YOUR_GOOGLE_KEY" | gcloud secrets create GOOGLE_API_KEY --data-file=-
echo -n "YOUR_FBI_KEY" | gcloud secrets create FBI_API_KEY --data-file=-
```

### 2. Deploy directly from source (Cloud Build + Cloud Run)

Quick one-liner (replace REGION & values or use secrets section below):

```powershell
gcloud run deploy property-details `
	--source . `
	--region us-central1 `
	--allow-unauthenticated `
	--set-env-vars NODE_ENV=production,CACHE_TTL_SECONDS=900
	--set-env-vars GEMINI_API_KEY=REDACTED,GOOGLE_API_KEY=REDACTED,FBI_API_KEY=REDACTED
```

Using secrets (no plain text keys):

```powershell
gcloud run deploy property-details `
	--source . `
	--region us-central1 `
	--allow-unauthenticated `
	--set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest,GOOGLE_API_KEY=GOOGLE_API_KEY:latest,FBI_API_KEY=FBI_API_KEY:latest
	--set-env-vars NODE_ENV=production,CACHE_TTL_SECONDS=900
```

Cloud Run injects PORT; the app listens automatically. Health endpoint: `/healthz`.

### 3. (Optional) Build with Docker locally & deploy

```powershell
docker build -t gcr.io/$env:PROJECT_ID/property-details:latest .
docker push gcr.io/$env:PROJECT_ID/property-details:latest
gcloud run deploy property-details --image gcr.io/$env:PROJECT_ID/property-details:latest --region us-central1 --allow-unauthenticated
```

### 4. Static Assets via Cloud Storage (Optional)

You can keep serving `index.html`, `app.js`, `style.css` from Express (simplest), or host them on a public GCS bucket:

```powershell
gsutil mb -l us-central1 gs://$env:PROJECT_ID-property-app
gsutil iam ch allUsers:objectViewer gs://$env:PROJECT_ID-property-app
gsutil cp index.html app.js style.css gs://$env:PROJECT_ID-property-app
```

Then set a CORS policy if calling the API from the bucket-hosted site:
```powershell
@'
[
	{"origin": ["*"], "method": ["GET","POST"], "responseHeader": ["Content-Type"], "maxAgeSeconds": 3600}
]
'@ | Out-File cors.json -Encoding ascii
gsutil cors set cors.json gs://$env:PROJECT_ID-property-app
```

Point users to the static site URL (<https://storage.googleapis.com/PROJECT_ID-property-app/index.html>) and configure `API_BASE` in `app.js` (or add an env var + small build step) if you deploy API & static separately.

### 5. Environment Variables Summary

| Name | Description |
|------|-------------|
| GEMINI_API_KEY | Gemini model key |
| GOOGLE_API_KEY | Google Maps / Geocoding |
| FBI_API_KEY | FBI crime data key |
| CACHE_TTL_SECONDS | Cache lifetime (default 900) |
| ZILLOW_ZIP_ZHVI_CSV | (Optional) Local/remote CSV for ZIP ZHVI |

### 6. Verifying Deployment

- Open Cloud Run service URL -> should load app UI.
- Check `/healthz` returns `{ ok: true }`.
- Open `/api/debugEnv` to confirm which keys are present (masked).

### 7. Updating

Push new commits then redeploy with the same `gcloud run deploy` command; Cloud Build will rebuild the container.

