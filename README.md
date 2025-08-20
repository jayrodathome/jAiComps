# Property Details Generator

Single Express server that serves both the API and static frontend.

## Setup

1. Install deps:

```bash
npm install
```

1. Create `.env`:

```env
GEMINI_API_KEY=your_key_here
PORT=3000
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
