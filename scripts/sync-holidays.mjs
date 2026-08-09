import { readFile, writeFile } from 'node:fs/promises';

const SITE_ORIGIN = 'https://www.nepalstock.com.np';
const PROOF_URL = `${SITE_ORIGIN}/api/authenticate/prove`;
const WASM_URL = `${SITE_ORIGIN}/assets/prod/css.wasm`;
const API_ORIGIN = `${SITE_ORIGIN}/api`;
const HOLIDAY_SOURCE = `${SITE_ORIGIN}/holiday-listing`;
const OUTPUT_FILE = new URL('../holidays.json', import.meta.url);
const REQUEST_HEADERS = { 'User-Agent': 'nepse-momentum-trader-holiday-sync/1.0' };
const SCHEMA_VERSION = 1;

async function fetchJson(url, headers = REQUEST_HEADERS) {
  const response = await fetch(url, { headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`NEPSE request failed (${response.status}) for ${url}: ${body.slice(0, 200)}`);
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`NEPSE returned invalid JSON for ${url}: ${error.message}`);
  }
}

function removeIndexedCharacters(value, indexes) {
  if (!indexes.every(index => Number.isInteger(index) && index >= 0 && index < value.length)) {
    throw new Error(`NEPSE token indexes are invalid: ${indexes.join(', ')}`);
  }
  if (indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    throw new Error(`NEPSE token indexes are not strictly increasing: ${indexes.join(', ')}`);
  }

  return indexes.reduce((result, index, position) => {
    const adjustedIndex = index - position;
    return result.slice(0, adjustedIndex) + result.slice(adjustedIndex + 1);
  }, value);
}

async function getPublicApiHeaders() {
  const proof = await fetchJson(PROOF_URL);
  const wasmResponse = await fetch(WASM_URL, { headers: REQUEST_HEADERS });
  if (!wasmResponse.ok) throw new Error(`Could not download NEPSE token helper (${wasmResponse.status})`);
  const wasm = await WebAssembly.instantiate(await wasmResponse.arrayBuffer());
  const functions = wasm.instance.exports;

  const indexes = [
    functions.cdx(proof.salt1, proof.salt2, proof.salt3, proof.salt4, proof.salt5),
    functions.rdx(proof.salt1, proof.salt2, proof.salt4, proof.salt3, proof.salt5),
    functions.bdx(proof.salt1, proof.salt2, proof.salt4, proof.salt3, proof.salt5),
    functions.ndx(proof.salt1, proof.salt2, proof.salt4, proof.salt3, proof.salt5),
    functions.mdx(proof.salt1, proof.salt2, proof.salt4, proof.salt3, proof.salt5)
  ];
  const accessToken = removeIndexedCharacters(proof.accessToken, indexes);

  return {
    ...REQUEST_HEADERS,
    Authorization: `Salter ${accessToken}`
  };
}

function normalizeISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function normalizeDescription(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

async function readPreviousCalendar() {
  try {
    return JSON.parse(await readFile(OUTPUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isValidSyncedAt(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validateCalendar(calendar) {
  if (!calendar || typeof calendar !== 'object' || Array.isArray(calendar)) {
    throw new Error('holiday calendar must be an object');
  }

  if (calendar.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`holiday calendar schemaVersion must be ${SCHEMA_VERSION}`);
  }

  if (typeof calendar.source !== 'string' || calendar.source.length === 0) {
    throw new Error('holiday calendar source must be a non-empty string');
  }

  if (!isValidSyncedAt(calendar.syncedAt)) {
    throw new Error('holiday calendar syncedAt must be an ISO timestamp');
  }

  if (!Array.isArray(calendar.holidays) || calendar.holidays.length === 0) {
    throw new Error('holiday calendar must contain at least one holiday');
  }

  let previousDate = '';
  for (const holiday of calendar.holidays) {
    if (!holiday || typeof holiday !== 'object' || Array.isArray(holiday)) {
      throw new Error('holiday entries must be objects');
    }
    if (!normalizeISODate(holiday.date)) {
      throw new Error(`holiday entry has an invalid date: ${holiday.date}`);
    }
    if (typeof holiday.description !== 'string') {
      throw new Error(`holiday entry ${holiday.date} has an invalid description`);
    }
    if (holiday.date <= previousDate) {
      throw new Error('holiday entries must be unique and sorted by date');
    }
    previousDate = holiday.date;
  }
}

async function syncCalendar() {
  // Read before any network work. This script writes only after a fully
  // validated replacement is available, so a failed sync preserves this file.
  const previous = await readPreviousCalendar();
  const headers = await getPublicApiHeaders();
  const years = await fetchJson(`${API_ORIGIN}/nots/holiday/year`, headers);
  if (!Array.isArray(years) || years.length === 0) throw new Error('NEPSE returned no holiday-list years');

  const byDate = new Map();
  for (const year of years) {
    const rows = await fetchJson(`${API_ORIGIN}/nots/holiday/list?year=${encodeURIComponent(year)}`, headers);
    if (!Array.isArray(rows)) throw new Error(`NEPSE returned an invalid holiday list for ${year}`);

    for (const row of rows) {
      const date = normalizeISODate(row && row.holidayDate);
      if (!date) continue;
      byDate.set(date, normalizeDescription(row.holidayDescription));
    }
  }

  const holidays = Array.from(byDate, ([date, description]) => ({ date, description }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (holidays.length === 0) throw new Error('NEPSE returned no valid holiday dates');

  const previousHolidays = previous && Array.isArray(previous.holidays) ? previous.holidays : null;
  const sameData = JSON.stringify(previousHolidays) === JSON.stringify(holidays);
  const syncedAt = sameData && previous && previous.schemaVersion === SCHEMA_VERSION && isValidSyncedAt(previous.syncedAt)
    ? previous.syncedAt
    : new Date().toISOString();
  const output = {
    schemaVersion: SCHEMA_VERSION,
    source: HOLIDAY_SOURCE,
    syncedAt,
    holidays
  };
  validateCalendar(output);

  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  const previousSerialized = previous ? `${JSON.stringify(previous, null, 2)}\n` : '';
  if (serialized !== previousSerialized) {
    await writeFile(OUTPUT_FILE, serialized, 'utf8');
    console.log(`Updated ${holidays.length} NEPSE holiday dates across ${years.length} published years.`);
  } else {
    console.log(`NEPSE holiday calendar is unchanged (${holidays.length} dates).`);
  }
}

syncCalendar().catch((error) => {
  console.error(`NEPSE holiday sync failed; the existing calendar was left unchanged: ${error.message}`);
  process.exitCode = 1;
});
