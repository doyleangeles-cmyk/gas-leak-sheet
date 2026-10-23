'use strict';

/* Gas Leak Sheet — API test suite.
 *
 * Boots the real server on a scratch port (PORT env, default 8917)
 * as a child process and drives it over HTTP: page serving, the
 * seeded well list, an inspection create → result → read-back round
 * trip (including a "leak detected" result), the filled year sheet,
 * mark-all, and cleanup of the test inspection so the data file is
 * left exactly as it was found.
 *
 * Run: npm test
 */

const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || 8917;
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log('PASS  ' + name);
  } else {
    failures++;
    console.log('FAIL  ' + name);
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function waitForServer(tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + '/api/wells');
      if (res.ok) return true;
    } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: 'pipe'
  });
  let serverLog = '';
  server.stdout.on('data', function (d) { serverLog += d; });
  server.stderr.on('data', function (d) { serverLog += d; });

  try {
    check('server boots on scratch port ' + PORT, await waitForServer(25));

    /* the app page */
    const page = await fetch(BASE + '/');
    const pageText = await page.text();
    check('GET / serves the app (200)', page.status === 200);
    check('page is the leak inspection app', pageText.indexOf('Quarterly Leak Inspection') !== -1);

    /* seeded well list */
    const wellsRes = await (await fetch(BASE + '/api/wells')).json();
    check('well list returns 23 points', Array.isArray(wellsRes.wells) && wellsRes.wells.length === 23);
    const first = wellsRes.wells[0] || {};
    const last = wellsRes.wells[wellsRes.wells.length - 1] || {};
    check('first point is UNION BANK / Tank Farm',
      first.section === 'UNION BANK' && first.name === 'Tank Farm');
    check('last point is BLM 27-7', last.section === 'BLM' && last.name === 'BLM 27-7');
    check('Tank Farm exists once per section (kept section-qualified)',
      wellsRes.wells.filter(function (w) { return w.name === 'Tank Farm'; }).length === 2);

    /* inspection round trip */
    const before = await (await fetch(BASE + '/api/inspections')).json();
    const createRes = await fetch(BASE + '/api/inspections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionDate: '2026-10-23' })
    });
    const created = await createRes.json();
    check('POST /api/inspections creates (201)', createRes.status === 201 && typeof created.id === 'number');

    const tankFarm = wellsRes.wells[0];
    const putRes = await fetch(BASE + '/api/results', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inspectionId: created.id,
        wellId: tankFarm.id,
        status: 'leak detected',
        note: 'TEST ROW — api round trip'
      })
    });
    check('PUT /api/results saves a result', putRes.status === 200);

    const results = await (await fetch(BASE + '/api/results?inspectionId=' + created.id)).json();
    const leakRow = (results.results || []).find(function (r) { return r.wellId === tankFarm.id; });
    check('result reads back as "leak detected" with its note',
      !!leakRow && leakRow.status === 'leak detected' && leakRow.note === 'TEST ROW — api round trip');

    const badStatus = await fetch(BASE + '/api/results', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionId: created.id, wellId: tankFarm.id, status: 'banana', note: '' })
    });
    check('an unknown status is rejected (400)', badStatus.status === 400);

    /* the filled year sheet sees the leak in the right cell */
    const sheet = await (await fetch(BASE + '/api/sheet?year=2026')).json();
    const cell = (sheet.cells || []).find(function (c) {
      return c.inspectionId === created.id && c.wellId === tankFarm.id;
    });
    check('year sheet carries the leak cell for 2026',
      !!cell && cell.status === 'leak detected' &&
      sheet.inspections.some(function (i) { return i.id === created.id; }));

    /* mark-all fills every well */
    const markRes = await fetch(BASE + '/api/results/mark-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inspectionId: created.id, status: 'no leaks detected' })
    });
    check('mark-all succeeds', markRes.status === 200);
    const after = await (await fetch(BASE + '/api/inspections')).json();
    const mine = (after.inspections || []).find(function (i) { return i.id === created.id; });
    check('recorded count is all 23 after mark-all', !!mine && mine.recordedCount === 23);

    /* cleanup: delete the test inspection, restoring the prior state */
    const delRes = await fetch(BASE + '/api/inspections?id=' + created.id, { method: 'DELETE' });
    check('test inspection deletes cleanly', delRes.status === 200);
    const restored = await (await fetch(BASE + '/api/inspections')).json();
    check('inspection count back to what it was',
      (restored.inspections || []).length === (before.inspections || []).length);
  } catch (e) {
    failures++;
    console.log('FAIL  exception: ' + (e && e.message));
    if (serverLog) console.log('--- server log ---\n' + serverLog);
  } finally {
    server.kill('SIGTERM');
  }

  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main();
