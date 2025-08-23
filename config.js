// Loads .env locally; in Cloud Run secrets are injected directly as env vars
require('dotenv').config();

// Cloud Run '--set-secrets=NAME=SECRET:latest' populates process.env.NAME directly.
// We keep this file synchronous so the rest of the app can read keys immediately at startup.
module.exports = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  googleApiKey: process.env.GOOGLE_API_KEY || '',
  fbiApiKey: process.env.FBI_API_KEY || '',
  zillowDatasets: {
    zhviWide: process.env.ZILLOW_ZIP_ZHVI_CSV || 'https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv',
    pricePerSqft: process.env.ZILLOW_MSA_PPSF_CSV || 'https://files.zillowstatic.com/research/public_csvs/new_con_median_sale_price_per_sqft/Metro_new_con_median_sale_price_per_sqft_uc_sfrcondo_month.csv'
  }
};