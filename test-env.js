// Test environment loading
require('dotenv').config();
console.log('Direct env check:');
console.log('ZILLOW_ZIP_ZHVI_CSV:', process.env.ZILLOW_ZIP_ZHVI_CSV);
console.log('ZILLOW_PPSF_CSV:', process.env.ZILLOW_PPSF_CSV);

const config = require('./config');
console.log('\nConfig check:');
console.log('zhviWide:', config.zillowDatasets.zhviWide);
console.log('pricePerSqft:', config.zillowDatasets.pricePerSqft);
