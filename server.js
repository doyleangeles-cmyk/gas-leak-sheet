'use strict';

/* Gas Leak Sheet — standalone server.
 *
 * This server does three jobs:
 *   1. Serve the static client (client/index.html — the whole app).
 *   2. Keep the inspection data (server/data/data.json): the well
 *      list, one inspection per inspection day, and one result per
 *      well per inspection (status + optional note).
 *   3. Expose that data behind a small JSON API (/api/wells,
 *      /api/inspections, /api/results, /api/sheet) with basic sanity
 *      checks on writes, because this may sit on the public internet.
 *
 * The client mirrors the artifact app "Gas Leak Sheet Autofill":
 * run an inspection, pick each well's leak status from a dropdown,
 * and the filled year sheet (Copy for Google Sheets / CSV) lines up
 * row-for-row with the user's real Leak Inspection Google Sheet.
 * If the API is ever unreachable, the client falls back to a
 * per-browser local copy, so field work is never blocked.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const STATUSES = ['no leaks detected', 'leak detected', 'leak detected, repaired'];
const MAX_BODY = 64 * 1024;

/* The 23 inspection points from the user's real Leak Inspection
   sheet, in sheet order, grouped by section. "Tank Farm" and
   "Header and gas lines" legitimately appear once per section, so
   a well's identity is (section, name). Seeded on first boot only;
   after that the user manages the list in the app. */
const SEED_WELLS = [
  ['UNION BANK', 'Tank Farm'],
  ['UNION BANK', 'Header and gas lines'],
  ['UNION BANK', 'UnionBank 76 - 12'],
  ['UNION BANK', 'UnionBank wI1 - 12'],
  ['UNION BANK', 'UnionBank E1 - 12'],
  ['UNION BANK', 'UnionBank 86X - 12'],
  ['UNION BANK', 'W&K Bank of Ca B - 1'],
  ['TEXACO', 'Tank Farm'],
  ['TEXACO', 'Header and gas lines'],
  ['TEXACO', 'Clancy 31 - 18'],
  ['TEXACO', 'Texaco 42 - 18'],
  ['TEXACO', 'Texaco 32 - 18'],
  ['TEXACO', 'Texaco 22 - 18'],
  ['TEXACO', 'Texaco 33 - 18'],
  ['TEXACO', 'Clancy 61 - 18'],
  ['TEXACO', 'Clancy 51 - 18'],
  ['TEXACO', 'Texaco 52 - 18'],
  ['TEXACO', 'Texaco E1 - 18'],
  ['TEXACO', 'Texaco M1 - 18'],
  ['TEXACO', 'Texaco 43X - 18'],
  ['TEXACO', 'Texaco 54 - 18'],
  ['TEXACO', 'Texaco 44 - 18'],
  ['BLM', 'BLM 27-7']
];

/* ================= Data storage ================= */

function seedData() {
  const wells = SEED_WELLS.map(function (pair, i) {
    return { id: i + 1, section: pair[0], name: pair[1] };
  });
  return {
    nextWellId: wells.length + 1,
    nextInspectionId: 1,
    wells: wells,
    inspections: [], // { id, inspectionDate: 'YYYY-MM-DD' }
    results: []      // { inspectionId, wellId, status, note }
  };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.wells) || !Array.isArray(d.inspections) || !Array.isArray(d.results)) {
      return seedData();
    }
    if (typeof d.nextWellId !== 'number') d.nextWellId = d.wells.length + 1;
    if (typeof d.nextInspectionId !== 'number') d.nextInspectionId = d.inspections.length + 1;
    return d;
  } catch (e) {
    return seedData();
  }
}

function saveData(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

let data = loadData();
saveData(data); // persist the seed (or a normalized file) on first boot

/* ================= Validation helpers ================= */

function cleanText(v, maxLen) {
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().slice(0, maxLen);
  return cleaned.length ? cleaned : null;
}

function cleanId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return v.trim();
}

function cleanStatus(v) {
  return STATUSES.indexOf(v) !== -1 ? v : null;
}

function findWell(id) {
  return data.wells.find(function (w) { return w.id === id; }) || null;
}

function findInspection(id) {
  return data.inspections.find(function (i) { return i.id === id; }) || null;
}

function recordedCount(inspectionId) {
  return data.results.filter(function (r) { return r.inspectionId === inspectionId; }).length;
}

function publicInspections() {
  return data.inspections
    .slice()
    .sort(function (a, b) {
      if (a.inspectionDate !== b.inspectionDate) return a.inspectionDate < b.inspectionDate ? 1 : -1;
      return b.id - a.id;
    })
    .map(function (i) {
      return { id: i.id, inspectionDate: i.inspectionDate, recordedCount: recordedCount(i.id) };
    });
}

/* ================= HTTP ================= */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let body = '';
  req.on('data', function (chunk) {
    body += chunk;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on('end', function () {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) { /* handled by callers */ }
    cb(parsed);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  /* ---- Well list ---- */
  if (p === '/api/wells') {
    if (req.method === 'GET') {
      sendJson(res, 200, { wells: data.wells });
      return;
    }
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const section = body && cleanText(body.section, 60);
        const name = body && cleanText(body.name, 120);
        if (!section || !name) { sendJson(res, 400, { error: 'A section and a name are required.' }); return; }
        const well = { id: data.nextWellId++, section: section, name: name };
        data.wells.push(well);
        saveData(data);
        sendJson(res, 201, { well: well });
      });
      return;
    }
    if (req.method === 'DELETE') {
      const id = cleanId(url.searchParams.get('id'));
      const well = id && findWell(id);
      if (!well) { sendJson(res, 404, { error: 'No such well.' }); return; }
      data.wells = data.wells.filter(function (w) { return w.id !== id; });
      data.results = data.results.filter(function (r) { return r.wellId !== id; });
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Inspections ---- */
  if (p === '/api/inspections') {
    if (req.method === 'GET') {
      sendJson(res, 200, { inspections: publicInspections() });
      return;
    }
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const date = body && cleanDate(body.inspectionDate);
        if (!date) { sendJson(res, 400, { error: 'A valid inspection date (YYYY-MM-DD) is required.' }); return; }
        const insp = { id: data.nextInspectionId++, inspectionDate: date };
        data.inspections.push(insp);
        saveData(data);
        sendJson(res, 201, { id: insp.id, inspectionDate: insp.inspectionDate });
      });
      return;
    }
    if (req.method === 'DELETE') {
      const id = cleanId(url.searchParams.get('id'));
      if (!id || !findInspection(id)) { sendJson(res, 404, { error: 'No such inspection.' }); return; }
      data.inspections = data.inspections.filter(function (i) { return i.id !== id; });
      data.results = data.results.filter(function (r) { return r.inspectionId !== id; });
      saveData(data);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Results ---- */
  if (p === '/api/results') {
    if (req.method === 'GET') {
      const id = cleanId(url.searchParams.get('inspectionId'));
      if (!id || !findInspection(id)) { sendJson(res, 404, { error: 'No such inspection.' }); return; }
      const results = data.results
        .filter(function (r) { return r.inspectionId === id; })
        .map(function (r) { return { wellId: r.wellId, status: r.status, note: r.note }; });
      sendJson(res, 200, { results: results });
      return;
    }
    if (req.method === 'PUT') {
      readBody(req, function (body) {
        const inspectionId = body && cleanId(body.inspectionId);
        const wellId = body && cleanId(body.wellId);
        if (!inspectionId || !findInspection(inspectionId)) { sendJson(res, 404, { error: 'No such inspection.' }); return; }
        if (!wellId || !findWell(wellId)) { sendJson(res, 404, { error: 'No such well.' }); return; }
        const note = body && typeof body.note === 'string' ? body.note.slice(0, 500) : '';
        /* status null clears the recorded result for this well */
        if (body.status === null || body.status === undefined) {
          data.results = data.results.filter(function (r) {
            return !(r.inspectionId === inspectionId && r.wellId === wellId);
          });
          saveData(data);
          sendJson(res, 200, { ok: true });
          return;
        }
        const status = cleanStatus(body.status);
        if (!status) { sendJson(res, 400, { error: 'Unknown leak status.' }); return; }
        const existing = data.results.find(function (r) {
          return r.inspectionId === inspectionId && r.wellId === wellId;
        });
        if (existing) { existing.status = status; existing.note = note; }
        else data.results.push({ inspectionId: inspectionId, wellId: wellId, status: status, note: note });
        saveData(data);
        sendJson(res, 200, { ok: true });
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (p === '/api/results/mark-all') {
    if (req.method === 'POST') {
      readBody(req, function (body) {
        const inspectionId = body && cleanId(body.inspectionId);
        const status = body && cleanStatus(body.status);
        if (!inspectionId || !findInspection(inspectionId)) { sendJson(res, 404, { error: 'No such inspection.' }); return; }
        if (!status) { sendJson(res, 400, { error: 'Unknown leak status.' }); return; }
        let updated = 0;
        data.wells.forEach(function (w) {
          const existing = data.results.find(function (r) {
            return r.inspectionId === inspectionId && r.wellId === w.id;
          });
          if (existing) existing.status = status;
          else data.results.push({ inspectionId: inspectionId, wellId: w.id, status: status, note: '' });
          updated++;
        });
        saveData(data);
        sendJson(res, 200, { ok: true, updated: updated });
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  /* ---- Filled year sheet ---- */
  if (p === '/api/sheet') {
    if (req.method === 'GET') {
      const year = Number(url.searchParams.get('year'));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        sendJson(res, 400, { error: 'A valid year is required.' });
        return;
      }
      const inss = data.inspections
        .filter(function (i) { return Number(i.inspectionDate.slice(0, 4)) === year; })
        .slice()
        .sort(function (a, b) {
          if (a.inspectionDate !== b.inspectionDate) return a.inspectionDate < b.inspectionDate ? -1 : 1;
          return a.id - b.id;
        });
      const ids = {};
      inss.forEach(function (i) { ids[i.id] = true; });
      const cells = data.results
        .filter(function (r) { return ids[r.inspectionId]; })
        .map(function (r) {
          return { inspectionId: r.inspectionId, wellId: r.wellId, status: r.status, note: r.note };
        });
      sendJson(res, 200, {
        year: year,
        inspections: inss.map(function (i) { return { id: i.id, inspectionDate: i.inspectionDate }; }),
        cells: cells
      });
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }

  if (p.indexOf('/api/') === 0) {
    sendJson(res, 404, { error: 'Unknown API route.' });
    return;
  }

  /* static client — just the one file */
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(CLIENT_DIR, 'index.html'), function (err, dataBuf) {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Client file missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(dataBuf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, function () {
  console.log('Gas Leak Sheet server listening on port ' + PORT);
});
