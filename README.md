# Recomp 8

8-week lifting + nutrition tracker (Planet Fitness edition). Zero-dependency Node server, PWA front end.

- `recomp.html` — the app (also published as a claude.ai artifact)
- `build.js` — wraps it into `public/index.html` with PWA metadata (`node build.js`)
- `server.js` — serves `public/` and a JSON store at `/api`, protected by `APP_KEY`

Env: `APP_KEY` (PIN), `DATA_DIR` (mount a volume here, e.g. `/data`), `PORT`.

## MCP server

`POST https://<host>/mcp` — Streamable HTTP (stateless JSON-RPC), protocol 2025-06-18.
Auth: `Authorization: Bearer <APP_KEY>` (or `x-key`). 27 tools: context/briefing, day/week/history reads, body trend, progression suggestions, weekly review, exercise/template/meal libraries, grocery list, and writes for day edits, swaps/moves, set logging, food logging, weigh-ins, meal swaps, custom meals, targets, notes. See `mcp.js`.
