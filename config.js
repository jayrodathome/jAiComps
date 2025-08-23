// Loads .env locally; in Cloud Run secrets are injected directly as env vars
require('dotenv').config();

// Primary: rely on env vars injected by --set-secrets.
// Fallback: if missing at startup, lazily fetch from Secret Manager when first accessed.
let loaded = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  fbiApiKey: process.env.FBI_API_KEY || ''
};

let secretClient = null;
async function fetchSecretIfNeeded(keyName, secretId) {
  if (loaded[keyName]) return loaded[keyName];
  try {
    if (!secretClient) {
      const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
      secretClient = new SecretManagerServiceClient();
    }
    const project = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
    if (!project) return '';
    const [version] = await secretClient.accessSecretVersion({ name: `projects/${project}/secrets/${secretId}/versions/latest` });
    const val = version.payload.data.toString('utf8');
    if (val) loaded[keyName] = val.trim();
    return loaded[keyName];
  } catch (e) {
    if (process.env.DEBUG_SECRETS) console.warn('[secrets] fetch failed', secretId, e.message);
    return '';
  }
}

module.exports = {
  get geminiApiKey() { return loaded.geminiApiKey; },
  get googleApiKey() { return loaded.googleApiKey; },
  get fbiApiKey() { return loaded.fbiApiKey; },
  // Lazy async helpers (optional usage in code if env missing)
  ensureSecrets: async () => {
    await Promise.all([
      fetchSecretIfNeeded('geminiApiKey','GEMINI_API_KEY'),
      fetchSecretIfNeeded('googleApiKey','GOOGLE_API_KEY'),
      fetchSecretIfNeeded('fbiApiKey','FBI_API_KEY')
    ]);
    return loaded;
  },
  zillowDatasets: {
    zhviWide: process.env.ZILLOW_ZIP_ZHVI_CSV || 'https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv',
    pricePerSqft: process.env.ZILLOW_MSA_PPSF_CSV || 'https://files.zillowstatic.com/research/public_csvs/new_con_median_sale_price_per_sqft/Metro_new_con_median_sale_price_per_sqft_uc_sfrcondo_month.csv'
  }
};