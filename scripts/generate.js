// Pulls the latest approved schedule data from the Triple F data station
// (an Apps Script web app the schedule spreadsheet pushes into) and
// regenerates one .ics calendar per coach. Runs on a GitHub Actions cron.
const fs = require('fs');
const path = require('path');

const EXPORT_URL = process.env.EXPORT_URL;
if (!EXPORT_URL) { console.error('EXPORT_URL env var missing'); process.exit(1); }

const COACHES = {
  ant: 'Ant', kevin: 'Kevin', jackson: 'Jackson', rich: 'Rich', dstone: 'D-Stone',
  adoriyan: 'Adoriyan', jake: 'Jake', ben: 'Ben', lee: 'Lee', evan: 'Evan',
};
const LOCATION = '4900 Guinn Rd, Knoxville, TN';
const ROOT = path.join(__dirname, '..');

const pad = n => String(n).padStart(2, '0');
const stamp = d => '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes());
const utc = d => '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
const icsEsc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

(async () => {
  // First tell the station to re-read the live schedule sheet, so any change
  // Kevin made shows up without anyone clicking Send. Best effort: if it fails,
  // we still serve whatever the station last stored.
  const REFRESH_URL = EXPORT_URL.replace('export=', 'refresh=');
  if (REFRESH_URL !== EXPORT_URL) {
    try {
      const r = await fetch(REFRESH_URL, { redirect: 'follow' });
      console.log('refresh:', (await r.text()).slice(0, 80));
    } catch (err) { console.log('refresh failed (using last stored):', err.message); }
  }

  // The station can be moody — retry a few times before giving up.
  let text = null;
  for (let i = 1; i <= 5 && !text; i++) {
    try {
      const res = await fetch(EXPORT_URL, { redirect: 'follow' });
      const body = await res.text();
      if (body.startsWith('TFEXPORT\n')) text = body.slice('TFEXPORT\n'.length);
      else console.log(`attempt ${i}: unexpected response (${body.slice(0, 60)}…)`);
    } catch (err) { console.log(`attempt ${i}: ${err.message}`); }
    if (!text) await new Promise(r => setTimeout(r, 10000));
  }
  if (!text) { console.error('Could not reach data station — keeping existing calendars.'); process.exit(0); }

  // Keys look like feed_<MonthTab>_<coachKey>; merge every month per coach.
  const store = JSON.parse(text);
  const rowsByCoach = {};
  for (const [key, json] of Object.entries(store)) {
    const coach = key.split('_').pop();
    if (!COACHES[coach]) continue;
    let rows;
    try { rows = JSON.parse(json); } catch (err) { continue; }
    (rowsByCoach[coach] = rowsByCoach[coach] || []).push(...rows);
  }

  const now = utc(new Date());
  for (const [key, name] of Object.entries(COACHES)) {
    const rows = (rowsByCoach[key] || []).slice().sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Triple F Sports//Schedule Feed//EN',
      'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Triple F — ' + name, 'X-WR-TIMEZONE:America/New_York',
      'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'];
    for (const row of rows) {
      const m = String(row[0]).match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
      if (!m) continue;
      const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
      const end = new Date(start.getTime() + row[1] * 60000);
      lines.push('BEGIN:VEVENT',
        'UID:' + key + '-' + stamp(start) + '@triplefsports.com',
        'DTSTAMP:' + now,
        'DTSTART;TZID=America/New_York:' + stamp(start) + '00',
        'DTEND;TZID=America/New_York:' + stamp(end) + '00',
        'SUMMARY:' + icsEsc(row[2]),
        'LOCATION:' + icsEsc(LOCATION),
        'DESCRIPTION:' + icsEsc(row[3]),
        'STATUS:CONFIRMED', 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    // Only rewrite when the events changed — DTSTAMP alone shouldn't churn commits.
    const file = path.join(ROOT, key + '.ics');
    const next = lines.join('\r\n');
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const strip = s => s.replace(/^DTSTAMP:.*$/gm, '');
    if (strip(prev) !== strip(next)) {
      fs.writeFileSync(file, next);
      console.log('updated', key + '.ics', '—', rows.length, 'classes');
    }
  }
})();
