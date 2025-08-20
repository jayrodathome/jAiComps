const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config'); // Configuration (loads env)
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(config.geminiApiKey);

const app = express();
const port = process.env.PORT || 3000; // Allow overriding port

// Simple in-memory cache { address: { data, expiresAt } }
const CACHE_TTL = (parseInt(process.env.CACHE_TTL_SECONDS, 10) || 900) * 1000; // default 15m
const cache = new Map();

// Enable CORS so our front-end (running on a different port) can call this server
app.use(cors());
// Enable the server to understand JSON in request bodies
app.use(express.json());

// Basic rate limiting to protect the endpoint
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 15, // max requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

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
The JSON object must strictly follow this structure and data types. Do not add any extra text, explanations, or markdown formatting like \`\`\`json around the output.

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
    console.error("Error during Gemini API call or JSON parsing:", e);
    // Include the raw response in the error for easier debugging
    throw new Error(`Failed to get a valid JSON response from the AI model. Raw response: ${e.message}`);
  }
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

    const propertyData = await getPropertyDetailsFromGemini(address);
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

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});