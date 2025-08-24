const config = require('./config');

console.log('Config test:');
console.log('GEMINI_API_KEY:', config.geminiApiKey ? 'Present' : 'Missing');
console.log('GOOGLE_API_KEY:', config.googleApiKey ? 'Present' : 'Missing');  
console.log('FBI_API_KEY:', config.fbiApiKey ? 'Present' : 'Missing');
console.log('Port:', config.port);
console.log('Cache TTL:', config.cacheTtlSeconds);
console.log('Config loaded successfully!');
