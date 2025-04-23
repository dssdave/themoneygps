// Filename: api/ai-search.js

// Using require for Node.js environment in Vercel Serverless Functions
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash"; // Use the latest flash model
const API_KEY = process.env.GEMINI_API_KEY; // Get API key from Vercel Env Vars
const MAX_CONTEXT_EXCERPTS = 5; // Max transcript excerpts to send as context
const MAX_EXCERPT_LENGTH = 1500; // Max characters per excerpt
// --- End Configuration ---

// --- Load Transcript Data ---
// Resolve path relative to project root (where vercel deploys from)
const dataPath = path.resolve(process.cwd(), 'search_data.json');
let transcriptData = [];
let dataLoadError = null;
try {
    if (fs.existsSync(dataPath)) {
        const jsonData = fs.readFileSync(dataPath, 'utf-8');
        transcriptData = JSON.parse(jsonData);
        // console.log(`AI Function: Loaded ${transcriptData.length} transcripts.`); // Keep console cleaner in production
    } else {
        console.warn(`AI Function: search_data.json not found at ${dataPath}. Contextual search disabled.`);
    }
} catch (error) {
    console.error("AI Function: Error loading search_data.json:", error);
    dataLoadError = "Failed to load transcript data on the server.";
}
// --- End Load Transcript Data ---

// Initialize Gemini client (only if API key is present)
let genAI;
let model;
if (API_KEY) {
    genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({ model: MODEL_NAME });
} else {
    console.error("AI Function: GEMINI_API_KEY environment variable not set.");
}

// Vercel Serverless Function handler (Node.js runtime)
module.exports = async (request, response) => {
    // Check if POST request
    if (request.method !== 'POST') {
        return response.status(405).json({ message: 'Method Not Allowed' });
    }

    // Check if API key is configured
    if (!genAI || !model) {
         return response.status(500).json({ answer: 'AI Service is not configured correctly on the server (API Key might be missing).' });
    }

    // Check if data loaded correctly (return error if it failed)
    if (dataLoadError) {
        return response.status(500).json({ answer: dataLoadError });
    }
     if (transcriptData.length === 0 && !dataLoadError){
         // Data file might be empty or just wasn't found but didn't error
         console.warn("AI Function: Transcript data is empty. Cannot provide context.");
         // Proceed without context? Or return error? Let's return an informative message.
         // return response.status(200).json({ answer: "Transcript data is not available on the server for contextual search." });
         // Fallback: Allow non-contextual query (remove return above if you want this)
     }


    try {
        const { query } = request.body;
        if (!query || typeof query !== 'string' || query.trim() === '') {
            return response.status(400).json({ answer: 'Query is required and must be a non-empty string.' });
        }

        console.log("AI Search Query Received:", query);

        // --- 1. Find Relevant Context (Simple Keyword Filter) ---
        let relevantExcerpts = "";
        let foundExcerptsCount = 0;

        if (transcriptData.length > 0) {
            const queryLower = query.toLowerCase();
            const queryKeywords = queryLower.split(/\s+/).filter(w => w.length > 2); // Get keywords > 2 chars

            const scoredMatches = transcriptData.map(item => {
                let score = 0;
                const textLower = (item.text || '').toLowerCase();
                const titleLower = (item.title || '').toLowerCase();
                queryKeywords.forEach(word => {
                    if (textLower.includes(word)) score++;
                    if (titleLower.includes(word)) score += 2; // Weight title matches more
                });
                return { item, score };
            }).filter(scoredItem => scoredItem.score > 0)
              .sort((a, b) => b.score - a.score); // Sort highest score first

            foundExcerptsCount = Math.min(scoredMatches.length, MAX_CONTEXT_EXCERPTS);

            relevantExcerpts = scoredMatches
                .slice(0, foundExcerptsCount)
                .map(scoredItem => {
                    const item = scoredItem.item;
                    const textExcerpt = (item.text || '').substring(0, MAX_EXCERPT_LENGTH);
                    // Format for clarity in the prompt
                    return `--- Transcript: ${item.title || 'N/A'} (${item.date || 'N/A'}) ---\n${textExcerpt}${item.text && item.text.length > MAX_EXCERPT_LENGTH ? '...' : ''}`;
                })
                .join('\n\n'); // Separate excerpts clearly
        }

         // --- 2. Format Prompt for Gemini (REVISED STRUCTURE) ---
         let finalPrompt;
         if (foundExcerptsCount > 0) {
              console.log(`Found ${foundExcerptsCount} relevant excerpts for context.`);
              // Structure: Provide context first, then ask the question based *only* on it.
              finalPrompt = `Context from 'The Money GPS' transcripts:
[START CONTEXT]
${relevantExcerpts}
[END CONTEXT]

Based ONLY on the provided context above, answer the following user question concisely: "${query}"
If the answer is not found in the context, state that the information is not available in the provided excerpts.
Answer:`;
         } else {
              console.log("No relevant excerpts found. Informing user.");
              // Return a direct message instead of querying Gemini without context
              return response.status(200).json({ answer: "Sorry, I couldn't find specific transcript excerpts matching your keywords to answer that question." });
         }

        // --- 3. Call Gemini API ---
        console.log("Sending request to Gemini API...");
        const generationConfig = {
            temperature: 0.3, // Slightly higher for potentially more nuanced answers based on context
            topK: 1, // Default often fine
            topP: 1, // Default often fine
            maxOutputTokens: 2048,
        };
         const safetySettings = [ // Standard safety settings
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        ];

         const result = await model.generateContent({
             contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
             generationConfig,
             safetySettings,
         });

        // --- 4. Process and Return Response ---
         const responseCandidate = result?.response?.candidates?.[0];

         if (!responseCandidate?.content?.parts?.[0]?.text) {
             const finishReason = responseCandidate?.finishReason || 'UNKNOWN';
             console.warn("Gemini response was blocked or empty. Reason:", finishReason);
             let errorMessage = `AI model did not provide a valid response (Reason: ${finishReason}).`;
             if (finishReason === 'SAFETY') {
                 errorMessage = 'AI response may have been blocked due to safety settings.';
             }
             // Return status 200 but with the error message in the answer field
             return response.status(200).json({ answer: `Sorry, ${errorMessage}` });
         }

        const responseText = responseCandidate.content.parts[0].text;
        console.log("Received response from Gemini.");
        response.status(200).json({ answer: responseText });

    } catch (error) {
        console.error("Error in AI search handler:", error);
        // Provide a slightly more informative error if possible
        const errorMessage = error.message || 'An unknown server error occurred.';
        response.status(500).json({ answer: `Sorry, an error occurred processing the AI search: ${errorMessage}` });
    }
};