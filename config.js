require('dotenv').config();

module.exports = {
  geminiApiKey: process.env.GEMINI_API_KEY,
  googleApiKey: process.env.GOOGLE_API_KEY,
  fbiApiKey: process.env.FBI_API_KEY,
  zillowDatasets: {
    zhviWide: process.env.ZILLOW_ZIP_ZHVI_CSV,
    pricePerSqft: process.env.ZILLOW_MSA_PPSP_CSV,
  },
};
