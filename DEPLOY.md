# Gas Leak Sheet: Deploy Notes

The standalone edition of the quarterly leak inspection app for
Angeles Oilfield Services LLC. The browser runs the whole workflow;
the server only serves the page and keeps the data behind a small
JSON API — the well list, inspections, and per-well results.

## Runtime

- **Node.js >= 18** (per `package.json` engines; developed/tested on Node 24).
- **No dependencies.** There is nothing to install — no `npm install`
  step is needed (it is harmless if the host runs one anyway).
- **Start command:** `npm start` (equivalently `node server/server.js`).
- **Port:** the `PORT` environment variable, default **8080**.
  On Render: create a Web Service from the repo, set the start
  command to `npm start`, and Render supplies `PORT` itself.

## Data persistence

- Everything persists to **`server/data/data.json`** (rewritten
  atomically on every change). On first boot the file is seeded with
  the 23 inspection points from the real Leak Inspection sheet
  (UNION BANK ×7, TEXACO ×15, BLM ×1, in sheet order); after that the
  well list is managed in the app and the seed never overwrites it.
- On hosts with an **ephemeral filesystem** (many free tiers wipe or
  reset the disk on redeploy/sleep), the data resets whenever the
  filesystem does. The app tolerates this: if the API is ever
  unreachable, the client falls back to a per-browser local copy
  (localStorage) and field work continues — but note the local copy
  lives on that one device/browser and does not sync back.
- To keep the data across deploys, mount a persistent volume at
  `server/data/` or accept the resets.

## API

- `GET /api/wells` — the well list. `POST /api/wells` adds one
  (`{section, name}`); `DELETE /api/wells?id=N` removes one and its
  recorded results.
- `GET /api/inspections` — inspections, newest first, each with a
  `recordedCount`. `POST /api/inspections` (`{inspectionDate:
  "YYYY-MM-DD"}`) creates one; `DELETE /api/inspections?id=N`
  removes one and its results.
- `GET /api/results?inspectionId=N` — that inspection's results.
  `PUT /api/results` upserts one (`{inspectionId, wellId, status,
  note}`; `status: null` clears it). `POST /api/results/mark-all`
  sets every well's status at once (notes are kept).
- `GET /api/sheet?year=YYYY` — the year's inspections (chronological)
  plus every result cell, for the filled year sheet view.
- Statuses are exactly the sheet's wording: `no leaks detected`,
  `leak detected`, `leak detected, repaired`. The server rejects
  anything else.

## Layout

- `client/index.html` — the app (single-file build): Run inspection,
  Year sheet (Copy for Google Sheets / CSV export), Well list.
- `server/server.js` — static serving + the JSON API.
- `server/data/data.json` — the data file (created on first boot).
- `test/test-api.js` — API test suite: `npm test`.

## Smoke test after deploying

1. Open the site — the Run inspection view should show the date
   picker and, after the first Start, the 23-point checklist grouped
   UNION BANK / TEXACO / BLM.
2. `GET /api/wells` returns `{"wells":[...]}` with 23 entries.
3. Record one well as "leak detected"; the counter shows the leak,
   and the Year sheet tab shows LEAK in red in that well's row under
   the inspection date.
