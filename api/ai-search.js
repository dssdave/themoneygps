// Filename: api/ai-search.js

// Import necessary modules
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash"; // Lightweight model, adjust if needed
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
    // Only attempt to load if the file exists
    if (fs.existsSync(dataPath)) {
        const jsonData = fs.readFileSync(dataPath, 'utf-8');
        transcriptData = JSON.parse(jsonData);
        // console.log(`AI Function: Loaded ${transcriptData.length} transcripts.`); // Keep console cleaner
    } else {
         // If file doesn't exist, proceed without data, but log it.
         // The function can still potentially answer general knowledge questions if needed,
         // but context-based answers won't work. Or we can throw an error.
         console.warn(`AI Function: search_data.json not found at ${dataPath}. Contextual search disabled.`);
         // dataLoadError = "Transcript data file not found on server."; // Option: Set error
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

// Define the Vercel Serverless Function handler
export default async function handler(request, response) {
    // Check if POST request
    if (request.method !== 'POST') {
        return response.status(405).json({ message: 'Method Not Allowed' });
    }

    // Check if data loaded correctly (optional based on desired behavior if file missing)
    if (dataLoadError) {
        // return response.status(500).json({ message: dataLoadError });
    }

    // Check if API key is configured
    if (!genAI || !model) {
         return response.status(500).json({ answer: 'AI Service is not configured correctly on the server (API Key might be missing).' });
    }

    try {
        const { query } = request.body; // Get user query from request body
        if (!query || typeof query !== 'string' || query.trim() === '') {
            return response.status(400).json({ answer: 'Query is required.' });
        }

        console.log("AI Search Query Received:", query);

        // --- 1. Find Relevant Context (Simple Keyword Filter) ---
        let relevantExcerpts = "";
        let foundExcerptsCount = 0;

        if (transcriptData.length > 0) { // Only search if data was loaded
            const queryLower = query.toLowerCase();
            // Basic relevance scoring (count occurrences)
            const scoredMatches = transcriptData.map((item, index) => {
                let score = 0;
                const textLower = (item.text || '').toLowerCase();
                const titleLower = (item.title || '').toLowerCase();
                // Simple check if query words appear (can be improved)
                queryLower.split(/\s+/).forEach(word => {
                     if (word.length > 2) { // Ignore very short words
                         if (textLower.includes(word)) score++;
                         if (titleLower.includes(word)) score += 2; // Weight title matches more
                     }
                });
                return { item, score, originalIndex: index }; // Keep original index if needed
            }).filter(scoredItem => scoredItem.score > 0)
              .sort((a, b) => b.score - a.score); // Sort by score descending

            foundExcerptsCount = Math.min(scoredMatches.length, MAX_CONTEXT_EXCERPTS);

            relevantExcerpts = scoredMatches
                .slice(0, foundExcerptsCount)
                .map(scoredItem => {
                    const item = scoredItem.item;
                    const textExcerpt = (item.text || '').substring(0, MAX_EXCERPT_LENGTH);
                    return `Title: ${item.title || 'N/A'}\nDate: ${item.date || 'N/A'}\nExcerpt: <span class="math-inline">\{textExcerpt\}</span>{item.text && item.text.length > MAX_EXCERPT_LENGTH ? '...' : ''}`;
                })
                .join('\n\n---\n\n');
        }

         let finalPrompt;
         if (foundExcerptsCount > 0) {
              console.log(`Found ${foundExcerptsCount} relevant excerpts for context.`);
              finalPrompt = `You are an assistant answering questions based ONLY on the following provided transcript excerpts from 'The Money GPS'. Do not use any outside knowledge. Be concise and directly answer the question. If the answer cannot be found in the excerpts, clearly state that the information is not available in the provided context.\n\nUser Question: <span class="math-inline">\{query\}\\n\\nRelevant Context\:\\n</span>{relevantExcerpts}\n\nAnswer:`;
         } else {
              console.log("No relevant excerpts found for query. Sending query without specific context.");
               // Fallback: Ask Gemini directly, but frame it cautiously
               finalPrompt = `Answer the following question: ${query}. Note: I could not find specific context in 'The Money GPS' transcripts matching your keywords.`;
               // OR: Return immediately if no context found (uncomment line below)
               // return response.status(200).json({ answer: "Sorry, I couldn't find any relevant transcripts in the data to answer that question based on your keywords." });
         }


        // --- 2. Call Gemini API ---
        console.log("Sending request to Gemini API...");
        const generationConfig = {
            temperature: 0.2,
            topK: 1,
            topP: 1,
            maxOutputTokens: 2048, // Reduced token limit for safety
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

        // --- 3. Process and Return Response ---
         if (!result.response || !result.response.candidates || result.response.candidates.length === 0 || !result.response.candidates[0].content) {
             const finishReason = result.response?.candidates?.[0]?.finishReason || 'UNKNOWN';
             console.warn("Gemini response was blocked or empty. Reason:", finishReason);
             let errorMessage = `AI model did not provide a response (Reason: ${finishReason}).`;
             if (finishReason === 'SAFETY') errorMessage = 'AI response blocked due to safety settings.';
             return response.status(200).json({ answer: `Sorry, ${errorMessage}` });
         }

        const responseText = result.response.candidates[0].content.parts[0].text;
        console.log("Received response from Gemini.");
        response.status(200).json({ answer: responseText });

    } catch (error) {
        console.error("Error in AI search handler:", error);
        response.status(500).json({ answer: 'Sorry, an error occurred while processing the AI search request.' });
    }
}