# Gas Leak Sheet

The standalone edition of the Angeles Oilfield Services LLC quarterly
leak inspection app — the same app as the hosted "Gas Leak Sheet
Autofill" artifact, packaged like the KM Security co-op project so it
can live on GitHub + Render the same way.

Pick an inspection date, work down the list of 23 wells and locations
choosing each one's leak status from a dropdown, and the app fills in
the year sheet in the exact layout of the real Leak Inspection Google
Sheet — ready to copy-paste into it (or download as CSV).

- `client/index.html` — the whole app, one self-contained page.
- `server/server.js` — plain Node server: static client + JSON API,
  data in `server/data/data.json`.
- `test/test-api.js` — API test suite: `npm test`.

See **DEPLOY.md** for how to run and host it.
