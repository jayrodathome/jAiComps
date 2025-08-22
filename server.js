const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const os = require('os');
const fs = require('fs');
const path = require('path');
const config = require('./config'); // Configuration (loads env)
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Client } = require("@googlemaps/google-maps-services-js");

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const mapsClient = new Client({});

const app = express();
const port = process.env.PORT || 3000; // Allow overriding port
const host = process.env.HOST || '0.0.0.0'; // Bind to all interfaces for LAN access
const DATA_DIR = path.join(__dirname, 'data');

// Simple in-memory cache { address: { data, expiresAt } }
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 900) * 1000; // default 15m
const cache = new Map();

// Zillow (or similar) property value dataset cache (zip -> {date, value})
let zillowValues = null; // ZHVI
let zillowPpsf = null; // price per sqft (metro-level)
let zillowDownloadTimestamp = null; // tracks last time any Zillow file was downloaded into data folder

// Support loading either local file system path or remote HTTP(S) URL
// Basic CSV line parser supporting quoted fields and escaped quotes
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { // escaped quote
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function loadZillowWideCSV(filePath) {
  try {
    let text;
    let origin;
    if (/^https?:\/\//i.test(filePath)) {
      const resp = await fetch(filePath);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
      origin = filePath;
    } else {
      const abs = path.resolve(filePath);
      text = fs.readFileSync(abs, 'utf8');
      origin = abs;
    }
    const lines = text.split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) return;
  const header = parseCsvLine(lines[0]);
    // Identify date columns (YYYY-MM or YYYY-MM-DD). We'll store YYYY-MM for display.
    const dateCols = header
      .map((h,i)=> (/^(19|20)\d{2}-\d{2}(-\d{2})?$/.test(h.trim()) ? {col:i, raw:h.trim(), ym:h.trim().slice(0,7)} : null))
      .filter(Boolean);
    if (!dateCols.length) {
      console.warn('Zillow CSV: no date columns detected. Header length:', header.length);
      return;
    }
    const regionNameIdx = header.findIndex(h=>/RegionName/i.test(h));
    const regionTypeIdx = header.findIndex(h=>/RegionType/i.test(h));
    const stateIdx = header.findIndex(h=>/^State$/i.test(h)||/StateName/i.test(h));
    if (regionNameIdx === -1 || regionTypeIdx === -1) {
      console.warn('Zillow CSV missing RegionName or RegionType columns');
      return;
    }
    const zipMap = new Map();
    const msaMap = new Map(); // "City, ST" -> { date, value }
    for (let li=1; li<lines.length; li++) {
      const row = parseCsvLine(lines[li]);
      if (row.length < header.length) continue;
      const regionName = row[regionNameIdx]?.trim();
      const regionType = (row[regionTypeIdx] || '').trim().toLowerCase();
      if (!regionName) continue;
      if (regionType !== 'zip' && regionType !== 'msa') continue;
      const series = [];
      let latest = null;
      for (let di=0; di<dateCols.length; di++) {
        const {col, ym} = dateCols[di];
        const valStr = row[col];
        if (valStr && !isNaN(+valStr)) {
          const v = +valStr;
            series.push({ ym, value: v });
          latest = { ym, value: v };
        }
      }
      if (!latest) continue;
      const entry = { date: latest.ym, value: latest.value, state: stateIdx>=0 ? row[stateIdx].trim() : undefined, series };
      if (regionType === 'zip') zipMap.set(regionName, entry);
      else if (regionType === 'msa') msaMap.set(regionName.toUpperCase(), entry);
    }
    // If we're parsing the locally cached file name, attempt to set download timestamp from its mtime (persisted across restarts)
    if (!zillowDownloadTimestamp) {
      try {
        if (!/^https?:/i.test(filePath) && /zillow_latest\.csv$/i.test(filePath)) {
          const st = fs.statSync(filePath);
          zillowDownloadTimestamp = st.mtime;
        }
      } catch {}
    }
    zillowValues = { loadedAt: new Date(), zipCount: zipMap.size, msaCount: msaMap.size, zipMap, msaMap };
    console.log(`Loaded Zillow dataset from ${origin} -> ZIPs: ${zipMap.size}, MSAs: ${msaMap.size}`);
  } catch (e) {
    console.warn('Failed to load Zillow CSV:', e.message);
  }
}

// Load Metro-level price per square foot CSV (no ZIPs). Returns map: MSA KEY -> {date,value,series}
async function loadZillowPricePerSqftCSV(filePath) {
  try {
    let text; let origin;
    if (/^https?:\/\//i.test(filePath)) { const resp = await fetch(filePath); if (!resp.ok) throw new Error(`HTTP ${resp.status}`); text = await resp.text(); origin = filePath; }
    else { const abs = path.resolve(filePath); text = fs.readFileSync(abs,'utf8'); origin = abs; }
    const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
    if (!lines.length) return;
    const header = parseCsvLine(lines[0]);
    const dateCols = header.map((h,i)=> (/^(19|20)\d{2}-\d{2}(-\d{2})?$/.test(h.trim()) ? {col:i, ym:h.trim().slice(0,7)}:null)).filter(Boolean);
    const regionNameIdx = header.findIndex(h=>/RegionName/i.test(h));
    const regionTypeIdx = header.findIndex(h=>/RegionType/i.test(h));
    if (regionNameIdx === -1 || regionTypeIdx === -1) { console.warn('PPSF CSV missing RegionName/RegionType'); return; }
    const msaMap = new Map();
    for (let li=1; li<lines.length; li++) {
      const row = parseCsvLine(lines[li]);
      if (row.length < header.length) continue;
      const regionName = row[regionNameIdx]?.trim();
      const regionType = (row[regionTypeIdx]||'').trim().toLowerCase();
      if (!regionName || regionType !== 'msa') continue;
      const series=[]; let latest=null;
      for (let di=0; di<dateCols.length; di++) { const {col, ym} = dateCols[di]; const valStr=row[col]; if (valStr && !isNaN(+valStr)) { const v=+valStr; series.push({ym,value:v}); latest={ym,value:v}; } }
      if (!latest) continue;
      msaMap.set(regionName.toUpperCase(), { date: latest.ym, value: latest.value, series });
    }
    zillowPpsf = { loadedAt: new Date(), msaCount: msaMap.size, msaMap };
    console.log(`Loaded Zillow PPSF dataset from ${origin} -> MSAs: ${msaMap.size}`);
  } catch(e){ console.warn('Failed to load Zillow PPSF CSV:', e.message); }
}

async function ensurePpsfLoaded() {
  if (!zillowPpsf && config.zillowDatasets && config.zillowDatasets.pricePerSqft) {
    await loadZillowPricePerSqftCSV(config.zillowDatasets.pricePerSqft);
  }
}

function findMsaKeyForAddress(address, msaMap) {
  if (!address || !msaMap || !msaMap.size) return null;
  let city = null, state = null;
  const cityStateMatch = address.match(/([^,]+),\s*([A-Z]{2})\s+\d{5}/i);
  if (cityStateMatch) {
    city = cityStateMatch[1].trim();
    state = cityStateMatch[2].toUpperCase();
  } else {
    const parts = address.split(',').map(p=>p.trim());
    if (parts.length >= 2) {
      city = parts[parts.length-2];
      const stMatch = parts[parts.length-1].match(/\b([A-Z]{2})\b/);
      if (stMatch) state = stMatch[1].toUpperCase();
    }
  }
  if (!city || !state) return null;
  const targetCityUpper = city.toUpperCase();
  const targetStateUpper = state.toUpperCase();
  const directKey = `${targetCityUpper}, ${targetStateUpper}`;
  if (msaMap.has(directKey)) return directKey;
  // Partial startsWith
  let bestKey = null;
  for (const key of msaMap.keys()) {
    if (key.endsWith(`, ${targetStateUpper}`)) {
      const cityPart = key.split(',')[0];
      if (cityPart.startsWith(targetCityUpper)) { bestKey = key; break; }
    }
  }
  if (bestKey) return bestKey;
  // Fuzzy
  const levenshtein = (a,b)=>{ const m=[...Array(b.length+1)].map((_,i)=>i); for(let i=1;i<=a.length;i++){ let prev=i-1; m[0]=i; for(let j=1;j<=b.length;j++){ const tmp=m[j]; m[j]=a[i-1]===b[j-1]?prev:Math.min(prev,m[j-1],m[j])+1; prev=tmp;} } return m[b.length]; };
  let bestDist = Infinity; let best = null;
  for (const key of msaMap.keys()) {
    if (!key.endsWith(`, ${targetStateUpper}`)) continue;
    const cityPart = key.split(',')[0];
    const dist = levenshtein(cityPart, targetCityUpper);
    if (dist < bestDist) { bestDist = dist; best = key; }
  }
  if (bestDist <= 3) return best;
  return null;
}

async function ensureZillowLoaded() {
  if (zillowValues || !process.env.ZILLOW_ZIP_ZHVI_CSV) return;
  await loadZillowWideCSV(process.env.ZILLOW_ZIP_ZHVI_CSV);
}

/**
 * Download latest Zillow CSV referenced by env variable into data folder and reload.
 */
async function refreshZillowDataset() {
  // Determine primary ZHVI source (env override or config default)
  const zhviSrc = process.env.ZILLOW_ZIP_ZHVI_CSV || config.zillowDatasets.zhviWide;
  const ppsfSrc = config.zillowDatasets.pricePerSqft;
  if (!zhviSrc) throw new Error('No ZHVI dataset URL configured');
  // Local path case for ZHVI only; PPSF still remote
  if (!/^https?:\/\//i.test(zhviSrc)) {
    await loadZillowWideCSV(zhviSrc);
    if (ppsfSrc) await loadZillowPricePerSqftCSV(ppsfSrc); // remote
    return { mode: 'reload-local', zhvi_source: zhviSrc, ppsf_source: ppsfSrc, zhvi: zillowValues, ppsf: zillowPpsf };
  }
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  const ts = Date.now();
  const zhviName = 'zillow_latest.csv';
  const ppsfName = 'zillow_ppsf_latest.csv';
  const zhviTarget = path.join(DATA_DIR, zhviName);
  const ppsfTarget = path.join(DATA_DIR, ppsfName);
  // Download both (parallel)
  const [zhviResp, ppsfResp] = await Promise.all([
    fetch(zhviSrc),
    ppsfSrc ? fetch(ppsfSrc) : Promise.resolve(null)
  ]);
  if (!zhviResp.ok) throw new Error(`ZHVI download failed: HTTP ${zhviResp.status}`);
  if (ppsfResp && !ppsfResp.ok) console.warn('PPSF download failed:', ppsfResp.status);
  fs.writeFileSync(zhviTarget, Buffer.from(await zhviResp.arrayBuffer()));
  if (ppsfResp && ppsfResp.ok) fs.writeFileSync(ppsfTarget, Buffer.from(await ppsfResp.arrayBuffer()));
  zillowDownloadTimestamp = new Date();
  await loadZillowWideCSV(zhviTarget);
  if (ppsfResp && ppsfResp.ok) await loadZillowPricePerSqftCSV(ppsfTarget);
  return { mode: 'downloaded', zhvi_saved_as: zhviTarget, ppsf_saved_as: ppsfResp?.ok ? ppsfTarget : null, zhvi_source: zhviSrc, ppsf_source: ppsfSrc, downloaded_at: zillowDownloadTimestamp, zhvi: zillowValues, ppsf: zillowPpsf };
}

// ---------------- Geocoding & Metro distance helpers ---------------- //
const geocodeCache = new Map(); // key -> {lat,lng}
async function geocode(query) {
  if (!config.googleApiKey) return null;
  const k = query.toLowerCase();
  if (geocodeCache.has(k)) return geocodeCache.get(k);
  try {
    const resp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${config.googleApiKey}`);
    if (!resp.ok) return null;
    const j = await resp.json();
    const loc = j.results?.[0]?.geometry?.location || null;
    if (loc) geocodeCache.set(k, loc);
    return loc;
  } catch { return null; }
}

function haversineMiles(a, b) {
  if (!a || !b) return Infinity;
  const R = 3958.8; // miles
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function extractZip(address) {
  if (!address) return null;
  const m = address.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}

// Enable CORS so our front-end (running on a different port) can call this server
app.use(cors());
// Enable the server to understand JSON in request bodies
app.use(express.json());
// Serve static frontend assets (index.html, app.js, style.css, etc.)
app.use(express.static(__dirname));

// Basic rate limiting to protect the endpoint
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 15, // max requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

/**
 * Attempt to extract a US state (2-letter) from an address string.
 * @param {string} address
 * @returns {string|null}
 */
function extractState(address) {
  if (!address) return null;
  const STATE_ABBRS = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
  ]);
  // Common US address pattern: City, ST ZIP
  const match = address.toUpperCase().match(/,\s*([A-Z]{2})\s+\d{5}/);
  if (match && STATE_ABBRS.has(match[1])) return match[1];
  // Fallback: look for , ST (end)
  const match2 = address.toUpperCase().match(/,\s*([A-Z]{2})(?:\s|$)/);
  if (match2 && STATE_ABBRS.has(match2[1])) return match2[1];
  return null;
}

/**
 * Perform a fetch against FBI Crime Data API trying multiple authentication styles.
 * Order: header X-API-Key, then query param variants (api_key, API_KEY, apikey, key).
 * Returns the first non-401/403 response or the last attempt's response.
 * @param {string} path API path beginning with '/'
 * @param {object} options fetch options
 */
async function fbiFetch(path, options = {}) {
  const base = 'https://api.usa.gov/crime/fbi/sapi/api';
  const key = config.fbiApiKey;
  const variants = [
    { name: 'header:X-API-Key', headers: { 'X-API-Key': key } },
  { name: 'header:X-Api-Key', headers: { 'X-Api-Key': key } },
    { name: 'query:api_key', q: { api_key: key } },
    { name: 'query:API_KEY', q: { API_KEY: key } },
    { name: 'query:apikey', q: { apikey: key } },
    { name: 'query:key', q: { key } }
  ];
  const [p, existingQuery] = path.split('?');
  const existingParams = new URLSearchParams(existingQuery || '');
  let lastResp = null;
  for (const v of variants) {
    const params = new URLSearchParams(existingParams.toString());
    if (v.q) Object.entries(v.q).forEach(([k,val]) => params.set(k, val));
    const url = `${base}${p}?${params.toString()}`;
    const resp = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), ...(v.headers || {}) }
    });
    // Return immediately if auth works (not 401/403) or success
    if (resp.status !== 401 && resp.status !== 403) return resp;
    lastResp = resp; // keep last 401/403 to return if all fail
  }
  return lastResp;
}

/**
 * Fetches recent crime estimate data from FBI (api.usa.gov) for the state in the address.
 * Uses the "estimates" endpoint which returns counts for key offense categories.
 * @param {string} address
 * @returns {Promise<object>} Object with stats suitable for merging into propertyData.crime
 */
async function getCrimeData(address) {
  try {
    const state = extractState(address);
    if (!state) {
      return { stats: { note: 'State not detected in address. Crime stats unavailable.' } };
    }
    if (!config.fbiApiKey) {
      return { stats: { note: 'FBI API key not configured.' } };
    }

    // Derive city via Google Geocoding (fallback to simple parse if unavailable)
    let city = null;
    try {
      if (config.googleApiKey) {
        const geoResp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${config.googleApiKey}`);
        if (geoResp.ok) {
          const geoJson = await geoResp.json();
          const comp = geoJson.results?.[0]?.address_components || [];
            const locality = comp.find(c => c.types.includes('locality')) || comp.find(c => c.types.includes('postal_town'));
          const admin2 = comp.find(c => c.types.includes('administrative_area_level_3')) || comp.find(c => c.types.includes('administrative_area_level_2'));
          city = (locality || admin2)?.long_name || null;
        }
      }
    } catch (gErr) {
      console.warn('Geocoding for city failed, will try regex fallback', gErr.message);
    }
    if (!city) {
      // naive parse: segment before state abbreviation
      const m = address.split(',');
      if (m.length >= 2) city = m[m.length - 2].trim();
    }

    // Choose target year: last full year (currentYear - 1)
    const now = new Date();
    const targetYear = now.getMonth() >= 6 ? now.getFullYear() - 1 : now.getFullYear() - 2; // assume data lags ~6 months

    // Attempt city-level ORI search
    let ori = null;
    let population = null;
    if (city) {
      try {
        const agenciesUrl = `/agencies/byStateAbbr?stateAbbr=${state}&page=1&per_page=500`;
        const agResp = await fbiFetch(agenciesUrl);
        if (agResp.ok) {
          const agJson = await agResp.json();
          const agencies = agJson?.agencies || agJson?.results || [];
          const cityUpper = city.toUpperCase();
          // Filter plausible city agencies
          const matches = agencies.filter(a => {
            const name = (a.agency_name || '').toUpperCase();
            const cName = (a.city_name || '').toUpperCase();
            return cName === cityUpper || name.startsWith(cityUpper) || name.includes(`${cityUpper} POLICE`);
          });
          // Prefer Police Department style and with population
          matches.sort((a,b)=> (b.population||0)-(a.population||0));
          if (matches.length) {
            ori = matches[0].ori;
            population = matches[0].population || null;
          }
        }
      } catch (agErr) {
        console.warn('Agency lookup failed, falling back to state:', agErr.message);
      }
    }

    async function fetchOffense(offense) {
      const url = `/summarized/agencies/${ori}/${offense}/offense/${targetYear}/${targetYear}`;
      const r = await fbiFetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      return j?.results?.[0] || null;
    }

    let stats = null;
    if (ori) {
      try {
        const offenses = ['violent-crime','property-crime','burglary','larceny-theft','motor-vehicle-theft','arson','homicide-offenses','robbery','aggravated-assault'];
        const results = {};
        for (const o of offenses) {
          const row = await fetchOffense(o);
          if (row) results[o] = row;
        }
        if (Object.keys(results).length) {
          // population from any row
          population = population || Object.values(results)[0].population || null;
          const pop = population || 0;
          const rate = (count) => (pop ? +((count / pop) * 100000).toFixed(1) : null);
          stats = {
            level: 'city',
            city,
            state,
            year: targetYear,
            population: pop,
            violent_crime: results['violent-crime']?.actual,
            property_crime: results['property-crime']?.actual,
            burglary: results['burglary']?.actual,
            larceny: results['larceny-theft']?.actual,
            motor_vehicle_theft: results['motor-vehicle-theft']?.actual,
            arson: results['arson']?.actual,
            homicide: results['homicide-offenses']?.actual,
            robbery: results['robbery']?.actual,
            aggravated_assault: results['aggravated-assault']?.actual,
            violent_rate_per_100k: rate(results['violent-crime']?.actual || 0),
            property_rate_per_100k: rate(results['property-crime']?.actual || 0),
            burglary_rate_per_100k: rate(results['burglary']?.actual || 0),
            larceny_rate_per_100k: rate(results['larceny-theft']?.actual || 0),
            motor_vehicle_theft_rate_per_100k: rate(results['motor-vehicle-theft']?.actual || 0),
            arson_rate_per_100k: rate(results['arson']?.actual || 0)
          };
        }
      } catch (cityErr) {
        console.warn('City-level crime retrieval failed:', cityErr.message);
      }
    }

    if (!stats) {
      // Fall back to state-level
      const estUrl = `/estimates/states/${state}/${targetYear}/${targetYear}?page=1&per_page=1`;
      const resp = await fbiFetch(estUrl, { timeout: 15000 });
      if (!resp.ok) {
        return { stats: { note: `FBI API request failed (${resp.status})` } };
      }
      const json = await resp.json();
      const row = json?.results?.[0];
      if (!row) return { stats: { note: 'No FBI crime data returned.' } };
      const pop = row.population || 0;
      const rate = (count) => (pop ? +((count / pop) * 100000).toFixed(1) : null);
      stats = {
        level: 'state',
        state,
        year: row.year,
        population: pop,
        violent_crime: row.violent_crime,
        homicide: row.homicide || row.murder || row.murder_and_nonnegligent_manslaughter,
        robbery: row.robbery,
        aggravated_assault: row.aggravated_assault,
        property_crime: row.property_crime,
        burglary: row.burglary,
        larceny: row.larceny,
        motor_vehicle_theft: row.motor_vehicle_theft,
        arson: row.arson,
        violent_rate_per_100k: rate(row.violent_crime),
        property_rate_per_100k: rate(row.property_crime),
        burglary_rate_per_100k: rate(row.burglary),
        larceny_rate_per_100k: rate(row.larceny),
        motor_vehicle_theft_rate_per_100k: rate(row.motor_vehicle_theft),
        arson_rate_per_100k: rate(row.arson),
        note: city ? `City-level data unavailable for ${city}; showing state estimates.` : undefined
      };
    }
    return { stats };
  } catch (e) {
    console.error('Crime data fetch error:', e);
    return { stats: { note: 'Error retrieving FBI crime data.' } };
  }
}

/**
 * Calls the Google Gemini API to generate property details for a given address.
 * @param {string} address The address to get details for.
 * @returns {Promise<object>} A promise that resolves with the property details JSON.
 */
async function getPropertyDetailsFromGemini(address) {
  console.log(`Received request for address: ${address}`);
  
  if (!config.geminiApiKey) {
    throw new Error('Gemini API key not configured. Set GEMINI_API_KEY in .env');
  }

  // Use a current Gemini model (gemini-pro was deprecated / removed)
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // This is where you replicate the instructions for your "Gem".
  // We provide a detailed system prompt and a "one-shot" example using your existing properties.json.
  // This guides the model to return data in the exact format you need.
  const exampleJson = JSON.stringify(require('./properties.json'), null, 2);
  const prompt = `
You are a real estate data analyst. Your task is to generate a detailed JSON object for a given property address.
The JSON object must strictly follow this structure and data types. Do not add any extra text, explanations, or markdown formatting like 
around the output.
When populating the school section, it should be specific to the city within a 10 mile radius of the address and only Public schools. Public schools in Google Maps places will never have a rating.

Here is an example of the required JSON format:
${exampleJson}

Now, generate a new JSON object with the same structure and data types for the following address:
${address}
`;

  try {
    console.log("Sending request to Gemini API...");
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Clean possible markdown fences
    const cleanedText = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // Try direct parse first
    try {
      return JSON.parse(cleanedText);
    } catch (primaryErr) {
      // Attempt to extract the first JSON object via a greedy match
      const match = cleanedText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (secondaryErr) {
          console.error('Secondary JSON parse failed:', secondaryErr);
        }
      }
      console.error('Primary JSON parse failed:', primaryErr);
      throw primaryErr; // Rethrow so outer catch adds context
    }
  } catch (e) {
    console.error("Error during Gemini API call or JSON parsing. Full error object:", JSON.stringify(e, null, 2));
    // Include more details in the thrown error
    let errorMessage = e.message;
    if (e.response && e.response.data) {
      errorMessage += ` | Response data: ${JSON.stringify(e.response.data)}`;
    }
    throw new Error(`Failed to get a valid JSON response from the AI model. Raw response: ${errorMessage}`);
  }
}

// Validate & normalize the structure we expect from the model so the frontend doesn't break.
function normalizePropertyData(data) {
  const safe = (v, fallback) => (v === undefined || v === null ? fallback : v);

  // Commute defaults
  data.commute = safe(data.commute, {});
  data.commute.transit = safe(data.commute.transit, {});
  data.commute.transit.bus_access = safe(data.commute.transit.bus_access, 'N/A');
  data.commute.transit.major_routes = Array.isArray(data.commute.transit.major_routes) ? data.commute.transit.major_routes : [];
  const dt = data.commute.transit.drive_times = safe(data.commute.transit.drive_times, {});
  // Normalize each provided drive time entry; don't inject city-specific keys.
  Object.keys(dt).forEach(k => {
    dt[k] = safe(dt[k], {});
    dt[k].drive_min = safe(dt[k].drive_min, 'N/A');
    dt[k].drive_mi = safe(dt[k].drive_mi, 'N/A');
  });

  return data;
}

// Define the API endpoint that our front-end will call
app.post('/api/getPropertyDetails', async (req, res) => {
  const start = Date.now();
  try {
    const { address, sections } = req.body || {};
    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Invalid or missing address.' });
    }

    // Normalize requested sections (lowercase). If none provided, treat as ALL (legacy behavior)
    let requested = null; // null => all
    if (Array.isArray(sections) && sections.length) {
      requested = Array.from(new Set(sections.map(s => String(s).toLowerCase())));
    }
    const wants = (k) => !requested || requested.includes(k);
    const AI_SECTIONS = new Set(['address','amenities_access','commute','schools','broadband','environmental_risk']);
    const needAI = !requested || requested.some(s => AI_SECTIONS.has(s));

    // Build cache key factoring in selected sections
    const cacheKey = address.toLowerCase() + '|' + (requested ? requested.sort().join(',') : 'ALL');

    // Cache lookup (only if full result or exact requested set cached)
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ ...cached.data, _cached: true });
    }

    let propertyData = { address };
    if (needAI) {
      const aiData = await getPropertyDetailsFromGemini(address);
      propertyData = { ...aiData };
    }

    // Crime (only if requested)
    if (wants('crime')) {
      const crimeData = await getCrimeData(address);
      propertyData.crime = { ...(propertyData.crime || {}), ...crimeData };
    }
    // Property value enrichment (ZIP preferred, fallback to Metro/MSA)
    if (wants('property_value')) {
      await ensureZillowLoaded();
      await ensurePpsfLoaded();
      if (zillowValues && (zillowValues.zipMap || zillowValues.msaMap)) {
        const zip = extractZip(address);
        let pv = null;
        if (zip && zillowValues.zipMap?.has(zip)) {
          pv = { type: 'zip', key: zip, ...zillowValues.zipMap.get(zip) };
        } else {
        // Try to derive "City, ST" for MSA match
        const cityStateMatch = address.match(/([^,]+),\s*([A-Z]{2})\s+\d{5}/i);
        if (cityStateMatch) {
          const city = cityStateMatch[1].trim();
          const st = cityStateMatch[2].toUpperCase();
          const msaKey = `${city}, ${st}`.toUpperCase();
          if (zillowValues.msaMap?.has(msaKey)) {
            pv = { type: 'msa', key: msaKey, ...zillowValues.msaMap.get(msaKey) };
          }
        }

      // If still no pv, attempt smarter inference: geocode & nearest metro (state constrained) else fuzzy match
            if (!pv && zillowValues.msaMap && zillowValues.msaMap.size) {
              let inferredCity = null; let inferredState = null;
              // 1. Geocode if Google key present
              if (config.googleApiKey) {
                try {
                  const geoResp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${config.googleApiKey}`);
                  if (geoResp.ok) {
                    const geoJson = await geoResp.json();
                    const comp = geoJson.results?.[0]?.address_components || [];
                    const locality = comp.find(c => c.types.includes('locality')) || comp.find(c => c.types.includes('postal_town'));
                    const admin1 = comp.find(c => c.types.includes('administrative_area_level_1'));
                    inferredCity = (locality && locality.long_name) || null;
                    inferredState = (admin1 && admin1.short_name) || null;
                  }
                } catch (e) {
                  console.warn('Geocode for metro inference failed:', e.message);
                }
              }
              // 2. If still missing, fall back to simple regex parse (city before second comma)
              if (!inferredCity || !inferredState) {
                const parts = address.split(',').map(p=>p.trim());
                if (parts.length >= 2) {
                  inferredCity = inferredCity || parts[parts.length-2];
                  const stMatch = parts[parts.length-1].match(/\b([A-Z]{2})\b/);
                  if (stMatch) inferredState = inferredState || stMatch[1];
                }
              }
              if (inferredCity && inferredState) {
                const targetCityUpper = inferredCity.toUpperCase();
                const targetStateUpper = inferredState.toUpperCase();
                // Direct contains / startsWith search first
                let bestKey = null;
                for (const key of zillowValues.msaMap.keys()) {
                  if (key.endsWith(`, ${targetStateUpper}`)) {
                    const cityPart = key.split(',')[0];
                    if (cityPart === targetCityUpper) { bestKey = key; break; }
                    if (!bestKey && cityPart.startsWith(targetCityUpper)) bestKey = key; // partial match
                  }
                }
                // Fuzzy Levenshtein if still none
                if (!bestKey) {
                  const levenshtein = (a,b)=>{ const m=[...Array(b.length+1)].map((_,i)=>i); for(let i=1;i<=a.length;i++){ let prev=i-1; m[0]=i; for(let j=1;j<=b.length;j++){ const tmp=m[j]; m[j]=a[i-1]===b[j-1]?prev:Math.min(prev,m[j-1],m[j])+1; prev=tmp;} } return m[b.length]; };
                  let bestDist = Infinity;
                  for (const key of zillowValues.msaMap.keys()) {
                    if (key.endsWith(`, ${targetStateUpper}`)) {
                      const cityPart = key.split(',')[0];
                      const dist = levenshtein(cityPart, targetCityUpper);
                      if (dist < bestDist) { bestDist = dist; bestKey = key; }
                    }
                  }
                  if (bestDist > 3) bestKey = null; // discard poor match
                }
                // Nearest metro approach if still none or to refine selection
                let nearestKey = null; let nearestMiles = Infinity;
                let addressLoc = null;
                if (config.googleApiKey) addressLoc = await geocode(address);
                if (addressLoc) {
                  const candidates = [];
                  for (const key of zillowValues.msaMap.keys()) {
                    if (key.endsWith(`, ${targetStateUpper}`)) candidates.push(key);
                  }
                  // Geocode each candidate city center ("City, ST") and compute distance
                  for (const key of candidates) {
                    const cityLoc = await geocode(key);
                    if (!cityLoc) continue;
                    const miles = haversineMiles(addressLoc, cityLoc);
                    if (miles < nearestMiles) { nearestMiles = miles; nearestKey = key; }
                  }
                }
                const chosenKey = nearestKey || bestKey;
                if (chosenKey) {
                  const entry = zillowValues.msaMap.get(chosenKey);
                  pv = { type: 'msa', key: chosenKey, ...entry, inferred: true, distance_miles: isFinite(nearestMiles) ? +nearestMiles.toFixed(1) : null };
                }
              }
            }
        }
        if (pv) {
        // Build yearly aggregates from series (last available month per year)
        let yearly = [];
        if (pv.series && pv.series.length) {
          const byYear = new Map();
          for (const pt of pv.series) {
            const year = pt.ym.slice(0,4);
            // overwrite so last month wins
            byYear.set(year, pt.value);
          }
          yearly = Array.from(byYear.entries())
            .sort((a,b)=>a[0].localeCompare(b[0]))
            .map(([year, zhvi])=>({ year, zhvi }));
        }
        // Region options (other MSAs within same state) to allow user selection of alternate surrounding areas
        let region_options = null;
        if (pv.type === 'msa' && zillowValues?.msaMap) {
          try {
            const stateCode = (pv.key.split(',').pop() || '').trim();
            if (stateCode) {
              region_options = Array.from(zillowValues.msaMap.keys())
                .filter(k => k.endsWith(`, ${stateCode}`))
                .sort();
            }
          } catch {}
        }
        propertyData.property_value = {
          type: pv.type,
          region: pv.key,
          latest_month: pv.date,
          zhvi: pv.value,
          source: 'Zillow Home Value Index (local CSV)',
              note: pv.type === 'msa' ? (pv.inferred ? 'Nearest metro-level median (inferred) – informational only.' : 'Metro-level median (no ZIP match) – informational only.') : 'ZIP-level median – informational only.',
          dataset_loaded_at: zillowValues.loadedAt ? zillowValues.loadedAt.toISOString() : null,
          dataset_downloaded_at: zillowDownloadTimestamp ? zillowDownloadTimestamp.toISOString() : null,
          distance_miles: (pv.distance_miles !== undefined ? pv.distance_miles : null),
          yearly,
          series: Array.isArray(pv.series) ? pv.series.slice(-240) : [], // include up to last 20 years monthly for chart fallback
          region_options
        };
        // Attach price per sqft; if we matched a ZIP, derive MSA key independently.
        if (zillowPpsf && zillowPpsf.msaMap) {
          let ppsfKey = null;
            if (pv.type === 'msa') ppsfKey = pv.key.toUpperCase();
            else ppsfKey = findMsaKeyForAddress(address, zillowPpsf.msaMap);
          if (ppsfKey && zillowPpsf.msaMap.has(ppsfKey)) {
            const ppsfEntry = zillowPpsf.msaMap.get(ppsfKey);
            propertyData.property_value.price_per_sqft = {
              latest_month: ppsfEntry.date,
              value: ppsfEntry.value,
              series: ppsfEntry.series.slice(-240),
              metro_key: ppsfKey,
              inferred_from_zip: pv.type === 'zip'
            };
          }
        }
        } else {
          propertyData.property_value = { note: 'No matching ZIP or Metro (MSA) in loaded dataset.', dataset_loaded_at: zillowValues.loadedAt ? zillowValues.loadedAt.toISOString() : null, dataset_downloaded_at: zillowDownloadTimestamp ? zillowDownloadTimestamp.toISOString() : null };
        }
      } else {
        propertyData.property_value = { note: 'Zillow dataset not loaded (set ZILLOW_ZIP_ZHVI_CSV in .env).' };
      }
    }
    if (needAI) propertyData = normalizePropertyData(propertyData);

    // If selective return, strip unrequested keys
    if (requested) {
      const filtered = {};
      for (const key of Object.keys(propertyData)) {
        if (wants(key)) filtered[key] = propertyData[key];
      }
      // Always include address so downstream features (place details) have context.
      filtered.address = address;
      propertyData = filtered;
    }

    cache.set(cacheKey, { data: propertyData, expiresAt: Date.now() + CACHE_TTL });
    res.json(propertyData);
  } catch (error) {
    console.error('Error fetching property details:', error);
    const status = /not configured/i.test(error.message) ? 500 : 502;
    res.status(status).json({ error: error.message || 'Failed to retrieve property details.' });
  } finally {
    console.log(`Handled /api/getPropertyDetails in ${Date.now() - start}ms`);
  }
});

app.post('/api/getPlaceDetails', async (req, res) => {
  const { placeName, address } = req.body;

  if (!placeName || !address) {
    return res.status(400).json({ error: 'Missing placeName or address' });
  }

  try {
    const geocodeResult = await mapsClient.geocode({
      params: {
        address: address,
        key: config.googleApiKey,
      },
    });

    const location = geocodeResult.data.results[0].geometry.location;

    const placeResult = await mapsClient.placesNearby({
      params: {
        location: location,
        radius: 16093, // 10 miles in meters
        keyword: placeName,
        key: config.googleApiKey,
      },
    });

    const place = placeResult.data.results[0];

    const distanceResult = await mapsClient.distancematrix({
      params: {
        origins: [address],
        destinations: [`place_id:${place.place_id}`],
        key: config.googleApiKey,
        units: 'imperial',
      },
    });

    const element = distanceResult.data.rows[0].elements[0];

    const origin = geocodeResult.data.results[0].geometry.location;
    const destination = place.geometry.location;

    const bearing = Math.atan2(destination.lng - origin.lng, destination.lat - origin.lat);
    const degrees = bearing * (180 / Math.PI);
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(degrees / 45) & 7;
    const direction = directions[index];

    res.json({
      distance: element.distance.text,
      duration: element.duration.text,
      url: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
      direction: direction,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to get place details' });
  }
});

// Simple FBI key test endpoint: optional state param (default WA) and year range shortened to one year.
app.get('/api/testFbiKey', async (req, res) => {
  if (!config.fbiApiKey) return res.status(400).json({ ok: false, error: 'Missing FBI_API_KEY' });
  const state = (req.query.state || 'WA').toUpperCase();
  const now = new Date();
  const year = now.getFullYear() - 2; // pick a likely complete year
  const path = `/estimates/states/${state}/${year}/${year}?per_page=1&page=1`;
  try {
    const attempts = [];
    const base = 'https://api.usa.gov/crime/fbi/sapi/api';
    const key = config.fbiApiKey;
    const variants = [
      { name: 'header:X-API-Key', headers: { 'X-API-Key': key } },
  { name: 'header:X-Api-Key', headers: { 'X-Api-Key': key } },
      { name: 'query:api_key', q: { api_key: key } },
      { name: 'query:API_KEY', q: { API_KEY: key } },
      { name: 'query:apikey', q: { apikey: key } },
      { name: 'query:key', q: { key } }
    ];
    const [p, existingQuery] = path.split('?');
    const existingParams = new URLSearchParams(existingQuery || '');
    let winner = null;
    for (const v of variants) {
      const params = new URLSearchParams(existingParams.toString());
      if (v.q) Object.entries(v.q).forEach(([k,val]) => params.set(k, val));
      const url = `${base}${p}?${params.toString()}`;
      const r = await fetch(url, { headers: v.headers || {} });
      const body = await r.text();
      let parsed; try { parsed = JSON.parse(body); } catch(_) {}
      const sample = parsed?.results?.[0] || null;
      attempts.push({ variant: v.name, status: r.status, ok: r.ok, error: parsed?.error || parsed?.message, samplePresent: !!sample });
      if (r.ok) { winner = { variant: v.name, url, sample, status: r.status }; break; }
    }
    res.json({ overall_ok: !!winner, winner, attempts, note: !winner ? 'All auth variants failed (likely invalid / unauthorized key).' : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Debug endpoint to confirm keys are loading (masked)
app.get('/api/debugEnv', (req, res) => {
  const mask = (k) => k ? `${k.slice(0,4)}...${k.slice(-4)} (len:${k.length})` : null;
  res.json({
    gemini_present: !!config.geminiApiKey,
    google_present: !!config.googleApiKey,
    fbi_present: !!config.fbiApiKey,
  zillow_csv: process.env.ZILLOW_ZIP_ZHVI_CSV || null,
    fbi_masked: mask(config.fbiApiKey)
  });
});

// Simple health check for Cloud Run / uptime probes
app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, uptime_s: process.uptime() });
});

app.listen(port, host, () => {
  // Determine a likely LAN IPv4 address
  const nets = os.networkInterfaces();
  let lan = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        lan = net.address;
        break;
      }
    }
    if (lan) break;
  }
  console.log(`Server listening on:`);
  console.log(`  Local:   http://localhost:${port}`);
  if (lan) console.log(`  Network: http://${lan}:${port}`);
  else console.log('  Network: (no external IPv4 detected)');
  const mask = (k) => k ? `${k.slice(0,4)}...${k.slice(-4)} (len:${k.length})` : '(missing)';
  console.log('Loaded API keys:');
  console.log(`  FBI_API_KEY: ${mask(config.fbiApiKey)}`);
  console.log(`  GEMINI_API_KEY: ${mask(config.geminiApiKey)}`);
  console.log(`  GOOGLE_API_KEY: ${mask(config.googleApiKey)}`);
});

// Endpoint to refresh Zillow dataset on-demand
app.post('/api/refreshZillow', async (req, res) => {
  try {
    const result = await refreshZillowDataset();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Return value series for a specific region key (MSA) so frontend can switch regions without re-running AI sections
app.post('/api/regionValues', async (req, res) => {
  try {
    const { region } = req.body || {};
    if (!region) return res.status(400).json({ error: 'Missing region' });
    await ensureZillowLoaded();
    await ensurePpsfLoaded();
    if (!zillowValues?.msaMap?.has(region.toUpperCase())) {
      return res.status(404).json({ error: 'Region not found' });
    }
    const entry = zillowValues.msaMap.get(region.toUpperCase());
    // Build yearly
    let yearly = [];
    if (entry.series && entry.series.length) {
      const byYear = new Map();
      for (const pt of entry.series) { byYear.set(pt.ym.slice(0,4), pt.value); }
      yearly = Array.from(byYear.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([year, zhvi])=>({year, zhvi}));
    }
    const resp = {
      type: 'msa',
      region: region.toUpperCase(),
      latest_month: entry.date,
      zhvi: entry.value,
      yearly,
      series: entry.series.slice(-240)
    };
    // attach PPSF if available
    if (zillowPpsf?.msaMap?.has(region.toUpperCase())) {
      const ppsfEntry = zillowPpsf.msaMap.get(region.toUpperCase());
      resp.price_per_sqft = { latest_month: ppsfEntry.date, value: ppsfEntry.value, series: ppsfEntry.series.slice(-240), metro_key: region.toUpperCase() };
    }
    res.json(resp);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});