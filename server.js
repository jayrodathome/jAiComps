const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const os = require('os');
const config = require('./config'); // Configuration (loads env)
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Client } = require("@googlemaps/google-maps-services-js");

const genAI = new GoogleGenerativeAI(config.geminiApiKey);
const mapsClient = new Client({});

const app = express();
const port = process.env.PORT || 3000; // Allow overriding port
const host = process.env.HOST || '0.0.0.0'; // Bind to all interfaces for LAN access

// Simple in-memory cache { address: { data, expiresAt } }
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 900) * 1000; // default 15m
const cache = new Map();

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
    const { address } = req.body || {};
    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Invalid or missing address.' });
    }

    // Cache lookup
    const cached = cache.get(address.toLowerCase());
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ ...cached.data, _cached: true });
    }

    let propertyData = await getPropertyDetailsFromGemini(address);
    const crimeData = await getCrimeData(address);
    propertyData.crime = { ...propertyData.crime, ...crimeData };
    propertyData = normalizePropertyData(propertyData);
    cache.set(address.toLowerCase(), { data: propertyData, expiresAt: Date.now() + CACHE_TTL });
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
    fbi_masked: mask(config.fbiApiKey)
  });
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