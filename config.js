// Loads .env locally; in Cloud Run secrets are injected directly as env vars
require('dotenv').config();

// Primary: rely on env vars injected by --set-secrets.
// Fallback: if missing at startup, lazily fetch from Secret Manager when first accessed.
let loaded = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  fbiApiKey: process.env.FBI_API_KEY || ''
};

let discoveredProjectId = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
let discovering = null;
async function discoverProjectId(){
  if (discoveredProjectId) return discoveredProjectId;
  if (discovering) return discovering;
  discovering = (async ()=>{
    try {
      const resp = await fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', { headers: { 'Metadata-Flavor':'Google' }, timeout: 1000 });
      if (resp.ok) {
        const txt = await resp.text();
        discoveredProjectId = txt.trim();
        if (process.env.DEBUG_SECRETS) console.log('[secrets] discovered project id via metadata:', discoveredProjectId);
      } else if (process.env.DEBUG_SECRETS) {
        console.warn('[secrets] metadata project id fetch not ok', resp.status);
      }
    } catch(e){ if (process.env.DEBUG_SECRETS) console.warn('[secrets] metadata project id fetch failed', e.message); }
    return discoveredProjectId;
  })();
  return discovering;
}

let secretClient = null;
const secretErrors = [];
async function fetchSecretIfNeeded(keyName, secretId) {
  if (loaded[keyName]) return loaded[keyName];
  try {
    if (!secretClient) {
      const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
      secretClient = new SecretManagerServiceClient();
    }
    const project = discoveredProjectId || await discoverProjectId();
    if (!project) { if (process.env.DEBUG_SECRETS) console.warn('[secrets] project id unavailable yet'); return ''; }
    const name = `projects/${project}/secrets/${secretId}/versions/latest`;
    const [version] = await secretClient.accessSecretVersion({ name });
    const val = version.payload.data.toString('utf8');
    if (val) loaded[keyName] = val.trim();
    if (process.env.DEBUG_SECRETS) console.log('[secrets] fetched', secretId, 'len', loaded[keyName].length);
    return loaded[keyName];
  } catch (e) {
    const msg = `[secrets] fetch failed ${secretId}: ${e.message}`;
    secretErrors.push(msg);
    if (process.env.DEBUG_SECRETS) console.warn(msg);
    return '';
  }
}

module.exports = {
  get geminiApiKey() { return loaded.geminiApiKey; },
  get googleApiKey() { return loaded.googleApiKey; },
  get fbiApiKey() { return loaded.fbiApiKey; },
  // Lazy async helpers (optional usage in code if env missing)
  ensureSecrets: async () => {
    await discoverProjectId();
    await Promise.all([
      fetchSecretIfNeeded('geminiApiKey','GEMINI_API_KEY'),
      fetchSecretIfNeeded('googleApiKey','GOOGLE_API_KEY'),
      fetchSecretIfNeeded('fbiApiKey','FBI_API_KEY')
    ]);
    return loaded;
  },
  secretStatus: () => ({
    geminiLen: loaded.geminiApiKey.length,
    googleLen: loaded.googleApiKey.length,
    fbiLen: loaded.fbiApiKey.length,
    projectId: discoveredProjectId,
    errors: secretErrors.slice(-5)
  }),
  zillowDatasets: {
    zhviWide: process.env.ZILLOW_ZIP_ZHVI_CSV || 'https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv',
    pricePerSqft: process.env.ZILLOW_MSA_PPSF_CSV || 'https://files.zillowstatic.com/research/public_csvs/new_con_median_sale_price_per_sqft/Metro_new_con_median_sale_price_per_sqft_uc_sfrcondo_month.csv',
    newConstructionSales: process.env.ZILLOW_NEW_CON_SALES_CSV || 'https://files.zillowstatic.com/research/public_csvs/new_con_sales_count_raw/Metro_new_con_sales_count_raw_uc_sfrcondo_month.csv?t=1755874217',
    affordabilityIndex: process.env.ZILLOW_AFFORDABILITY_CSV || 'https://files.zillowstatic.com/research/public_csvs/new_homeowner_income_needed/Metro_new_homeowner_income_needed_downpayment_0.20_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv?t=1755874217'
  }
};