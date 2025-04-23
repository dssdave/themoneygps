// Filename: api/ai-search.js (with Chunking)

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash";
const API_KEY = process.env.GEMINI_API_KEY;
const MAX_CONTEXT_CHUNKS = 10; // How many relevant chunks to find
const MAX_CHUNK_LENGTH = 500;  // Approx length of each chunk (characters)
const MAX_TOTAL_CONTEXT_LENGTH = MAX_CONTEXT_CHUNKS * MAX_CHUNK_LENGTH * 1.2; // Safety buffer for total context
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

// --- Helper: Chunking Function ---
function chunkText(text, maxLength = MAX_CHUNK_LENGTH) {
    const chunks = [];
    // Simple chunking by splitting paragraphs first, then sentences.
    const paragraphs = text.split(/\n\s*\n/); // Split by blank lines (paragraphs)
    for (const paragraph of paragraphs) {
        if (!paragraph.trim()) continue;
        // If paragraph is short enough, add it as one chunk
        if (paragraph.length <= maxLength) {
            chunks.push(paragraph);
        } else {
            // If paragraph is too long, split by sentences (simple approach)
            // Regex tries to split by sentence-ending punctuation followed by space/newline
            const sentences = paragraph.split(/(?<=[.?!])\s+/);
            let currentChunk = "";
            for (const sentence of sentences) {
                if (!sentence.trim()) continue;
                if (currentChunk.length + sentence.length + 1 <= maxLength) {
                    currentChunk += (currentChunk ? " " : "") + sentence;
                } else {
                    // Add current chunk if it has content
                    if (currentChunk) chunks.push(currentChunk);
                    // Start new chunk, handle sentence longer than max length
                    currentChunk = sentence.length <= maxLength ? sentence : sentence.substring(0, maxLength) + "...";
                }
            }
            // Add the last chunk if it has content
            if (currentChunk) chunks.push(currentChunk);
        }
    }
    return chunks.filter(chunk => chunk.trim() !== ''); // Ensure no empty chunks
}
// --- End Helper ---


// Initialize Gemini client
let genAI;
let model;
if (API_KEY) { /* ... same init logic ... */
    genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({ model: MODEL_NAME });
} else { console.error("AI Function: GEMINI_API_KEY not set."); }

// Vercel Serverless Function handler
module.exports = async (request, response) => {
    if (request.method !== 'POST') { /* ... */ return response.status(405).json({ message: 'Method Not Allowed' }); }
    if (!genAI || !model) { /* ... */ return response.status(500).json({ answer: 'AI Service not configured.' }); }
    if (dataLoadError) { /* ... */ return response.status(500).json({ answer: dataLoadError }); }

    try {
        const { query } = request.body;
        if (!query || typeof query !== 'string' || query.trim() === '') { /* ... */ return response.status(400).json({ answer: 'Query required.' }); }

        console.log("AI Search Query Received:", query);

        // --- 1. Find Relevant Context (Chunk-Based Keyword Filter) ---
        let relevantContext = "";
        let foundChunksCount = 0;

        if (transcriptData.length > 0) {
            const queryLower = query.toLowerCase();
            const queryKeywords = queryLower.split(/\s+/).filter(w => w.length > 2);
            let allChunks = [];

            // Create chunks from all transcripts and score them
            transcriptData.forEach(item => {
                const textChunks = chunkText(item.text || '');
                textChunks.forEach(chunk => {
                    let score = 0;
                    const chunkLower = chunk.toLowerCase();
                    const titleLower = (item.title || '').toLowerCase();
                    queryKeywords.forEach(word => {
                        if (chunkLower.includes(word)) score++;
                        // Optionally weight title match for chunks from that transcript
                        if (titleLower.includes(word)) score += 0.5; // Lower weight for title now
                    });
                    if (score > 0) {
                        allChunks.push({
                            chunkText: chunk,
                            score: score,
                            title: item.title || 'N/A',
                            date: item.date || 'N/A'
                        });
                    }
                });
            });

            // Sort all found chunks by score
            allChunks.sort((a, b) => b.score - a.score);

            // Select top chunks for context, respecting total length
            let currentContextLength = 0;
            const selectedChunks = [];
            for (const chunkInfo of allChunks) {
                if (foundChunksCount >= MAX_CONTEXT_CHUNKS) break;
                if (currentContextLength + chunkInfo.chunkText.length > MAX_TOTAL_CONTEXT_LENGTH) break;

                selectedChunks.push(chunkInfo);
                currentContextLength += chunkInfo.chunkText.length;
                foundChunksCount++;
            }

            // Format the selected chunks for the prompt
            relevantContext = selectedChunks
                .map(chunkInfo => `--- Transcript: ${chunkInfo.title} (${chunkInfo.date}) ---\n${chunkInfo.chunkText}`)
                .join('\n\n');
        }
         // --- End Context Finding ---

         // --- 2. Format Prompt & Call Gemini ---
         let finalPrompt;
         if (foundChunksCount > 0) {
              console.log(`Found ${foundChunksCount} relevant chunks for context.`);
              finalPrompt = `Context from 'The Money GPS' transcripts:
[START CONTEXT]
${relevantContext}
[END CONTEXT]

Based ONLY on the provided context above, answer the following user question concisely: "${query}"
If the answer is not found in the context, state that the information is not available in the provided excerpts.
Answer:`;
         } else {
              console.log("No relevant chunks found. Informing user.");
              return response.status(200).json({ answer: "Sorry, I couldn't find specific transcript excerpts matching your keywords to answer that question." });
         }

        // --- (Call Gemini API - same as before) ---
        console.log("Sending request to Gemini API...");
        const generationConfig = { temperature: 0.3, maxOutputTokens: 2048 };
        const safetySettings = [ /* ... Standard safety settings ... */
             { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }, { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }, { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }, { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
         ];

        const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: finalPrompt }] }], generationConfig, safetySettings });

        // --- (Process and Return Response - same as before) ---
        const responseCandidate = result?.response?.candidates?.[0];
        if (!responseCandidate?.content?.parts?.[0]?.text) { /* ... handle blocked/empty response ... */
             const finishReason = responseCandidate?.finishReason || 'UNKNOWN'; console.warn("Gemini response blocked/empty. Reason:", finishReason);
             let errorMessage = `AI model response issue (Reason: ${finishReason}).`; if (finishReason === 'SAFETY') errorMessage = 'AI response blocked due to safety settings.';
             return response.status(200).json({ answer: `Sorry, ${errorMessage}` });
        }
        const responseText = responseCandidate.content.parts[0].text;
        console.log("Received response from Gemini.");
        response.status(200).json({ answer: responseText });

    } catch (error) {
        console.error("Error in AI search handler:", error);
        const errorMessage = error.message || 'An unknown server error occurred.';
        response.status(500).json({ answer: `Sorry, an error occurred processing the AI search: ${errorMessage}` });
    }
};