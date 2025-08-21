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
