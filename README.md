# Recomp 8

8-week lifting + nutrition tracker (Planet Fitness edition). Zero-dependency Node server, PWA front end.

- `recomp.html` — the app (also published as a claude.ai artifact)
- `build.js` — wraps it into `public/index.html` with PWA metadata (`node build.js`)
- `server.js` — serves `public/` and a JSON store at `/api`, protected by `APP_KEY`

Env: `APP_KEY` (PIN), `DATA_DIR` (mount a volume here, e.g. `/data`), `PORT`.
