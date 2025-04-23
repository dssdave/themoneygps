// Filename: api/ai-search.js

// Using require for Node.js environment in Vercel Serverless Functions
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash"; // Use the latest flash model
const API_KEY = process.env.GEMINI_API_KEY; // Access API key from Vercel Env Vars
const MAX_CONTEXT_EXCERPTS = 5; // How many relevant transcripts to send
const MAX_EXCERPT_LENGTH = 1500; // Max characters per excerpt
// --- End Configuration ---

// --- Load Transcript Data ---
const dataPath = path.resolve(process.cwd(), 'search_data.json');
let transcriptData = [];
let dataLoadError = null;
try {
    if (fs.existsSync(dataPath)) {
        const jsonData = fs.readFileSync(dataPath, 'utf-8');
        transcriptData = JSON.parse(jsonData);
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
         return response.status(500).json({ answer: 'AI Service is not configured correctly on the server (API Key missing).' });
    }

     // Check if data loaded correctly (optional based on desired behavior if file missing)
    if (dataLoadError) {
        // Maybe allow non-contextual questions? For now, let's return error if data needed.
        // return response.status(500).json({ answer: dataLoadError });
    }

    try {
        // Vercel automatically parses JSON body for POST if Content-Type is correct
        const { query } = request.body;
        if (!query || typeof query !== 'string' || query.trim() === '') {
            return response.status(400).json({ answer: 'Query is required and must be a non-empty string.' });
        }

        console.log("AI Search Query Received:", query);

        // --- 1. Find Relevant Context (Simple Keyword Filter) ---
        let relevantExcerpts = "";
        let foundExcerptsCount = 0;

        if (transcriptData.length > 0) { // Only search if data was loaded
            const queryLower = query.toLowerCase();
            // Simple check if query words appear in text or title
             const scoredMatches = transcriptData.map((item, index) => {
                let score = 0;
                const textLower = (item.text || '').toLowerCase();
                const titleLower = (item.title || '').toLowerCase();
                queryLower.split(/\s+/).forEach(word => {
                    if (word.length > 2) { // Ignore short words
                        if (textLower.includes(word)) score++;
                        if (titleLower.includes(word)) score += 2;
                    }
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
                    return `--- Transcript: <span class="math-inline">\{item\.title \|\| 'N/A'\} \(</span>{item.date || 'N/A'}) ---\n${textExcerpt}${item.text && item.text.length > MAX_EXCERPT_LENGTH ? '...' : ''}`;
                })
                .join('\n\n'); // Separate excerpts clearly
        }

         // --- 2. Format Prompt for Gemini ---
         let finalPrompt;
         if (foundExcerptsCount > 0) {
              console.log(`Found ${foundExcerptsCount} relevant excerpts for context.`);
              finalPrompt = `Based ONLY on the following transcript excerpts from 'The Money GPS', answer the user's question concisely. If the answer isn't in the excerpts, state that clearly based on the provided context.\n\nUSER QUESTION: "<span class="math-inline">\{query\}"\\n\\nRELEVANT EXCERPTS\:\\n</span>{relevantExcerpts}\n\nANSWER:`;
         } else {
               console.log("No relevant excerpts found. Sending query without specific context.");
               // Decide how to handle no context - ask generally or state no context found?
               // Option 1: Ask generally (might hallucinate or use outside knowledge)
               // finalPrompt = `Answer the following question: ${query}`;
               // Option 2: State no context (safer)
               return response.status(200).json({ answer: "Sorry, I couldn't find specific transcript excerpts matching your keywords to answer that question." });
         }

        // --- 3. Call Gemini API ---
        console.log("Sending request to Gemini API...");
        const generationConfig = { temperature: 0.3, maxOutputTokens: 2048 }; // Slightly creative, reasonable output limit
        const safetySettings = [ /* ... Standard safety settings ... */
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
         // Use optional chaining for safer access
         const responseCandidate = result?.response?.candidates?.[0];
         if (!responseCandidate?.content?.parts?.[0]?.text) {
             const finishReason = responseCandidate?.finishReason || 'UNKNOWN';
             console.warn("Gemini response was blocked or empty. Reason:", finishReason);
             let errorMessage = `AI model did not provide a response (Reason: ${finishReason}).`;
             if (finishReason === 'SAFETY') errorMessage = 'AI response blocked due to safety settings.';
             return response.status(200).json({ answer: `Sorry, ${errorMessage}` });
         }

        const responseText = responseCandidate.content.parts[0].text;
        console.log("Received response from Gemini.");
        response.status(200).json({ answer: responseText });

    } catch (error) {
        console.error("Error in AI search handler:", error);
        // Provide a slightly more informative error if possible
        const errorMessage = error.message || 'An unknown error occurred.';
        response.status(500).json({ answer: `Sorry, an error occurred processing the AI search: ${errorMessage}` });
    }
};