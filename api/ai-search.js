// Filename: api/ai-search.js (with Temporal Comparison & External Knowledge)

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash";
const API_KEY = process.env.GEMINI_API_KEY;
const MAX_CHUNKS_PER_TIMEFRAME = 5; // Max chunks from EACH timeframe for comparison
const MAX_CHUNKS_GENERAL = 10;     // Max chunks for a general query
const MAX_CHUNK_LENGTH = 500;      // Approx length of each chunk (chars)
const MAX_TOTAL_CONTEXT_LENGTH = (MAX_CHUNKS_PER_TIMEFRAME * 2) * MAX_CHUNK_LENGTH * 1.2; // Safety buffer
// --- End Configuration ---

// --- Load Transcript Data ---
const dataPath = path.resolve(process.cwd(), 'search_data.json');
let transcriptData = [];
let dataLoadError = null;
try {
    if (fs.existsSync(dataPath)) {
        const jsonData = fs.readFileSync(dataPath, 'utf-8');
        // Add a JS Date object to each item during load for easier filtering
        transcriptData = JSON.parse(jsonData).map(item => {
            let date = null;
            if (item.date && /^\d{8}$/.test(item.date)) { // Basic check for YYYYMMDD
                try {
                    const year = parseInt(item.date.substring(0, 4), 10);
                    const month = parseInt(item.date.substring(4, 6), 10) - 1; // JS months are 0-indexed
                    const day = parseInt(item.date.substring(6, 8), 10);
                    // Use UTC to avoid timezone issues during comparison
                    date = new Date(Date.UTC(year, month, day));
                } catch (e) { console.warn(`Invalid date format for ${item.filename}: ${item.date}`); }
            }
            return { ...item, jsDate: date }; // Add jsDate property
        });
        // Sort data by date ascending (oldest first) - important for comparisons
        transcriptData.sort((a, b) => (a.jsDate && b.jsDate) ? a.jsDate - b.jsDate : 0);
    } else {
        console.warn(`AI Function: search_data.json not found at ${dataPath}.`);
    }
} catch (error) {
    console.error("AI Function: Error loading/processing search_data.json:", error);
    dataLoadError = "Failed to load/process transcript data on the server.";
}
// --- End Load Transcript Data ---

// --- Helper: Chunking Function ---
function chunkText(text, maxLength = MAX_CHUNK_LENGTH) {
    // ... (chunkText function remains the same as previous version) ...
     const chunks = []; const paragraphs = text.split(/\n\s*\n/);
     for (const paragraph of paragraphs) {
         if (!paragraph.trim()) continue;
         if (paragraph.length <= maxLength) { chunks.push(paragraph); }
         else { const sentences = paragraph.split(/(?<=[.?!])\s+/); let currentChunk = "";
             for (const sentence of sentences) { if (!sentence.trim()) continue; if (currentChunk.length + sentence.length + 1 <= maxLength) { currentChunk += (currentChunk ? " " : "") + sentence; } else { if (currentChunk) chunks.push(currentChunk); currentChunk = sentence.length <= maxLength ? sentence : sentence.substring(0, maxLength) + "..."; } }
             if (currentChunk) chunks.push(currentChunk);
         }
     } return chunks.filter(chunk => chunk.trim() !== '');
}
// --- End Helper ---

// Initialize Gemini client
let genAI;
let model;
if (API_KEY) { /* ... */ genAI = new GoogleGenerativeAI(API_KEY); model = genAI.getGenerativeModel({ model: MODEL_NAME }); }
else { console.error("AI Function: GEMINI_API_KEY not set."); }

// --- Helper: Find Relevant Chunks ---
function findRelevantChunks(query, dateRange = null, maxChunks = MAX_CHUNKS_GENERAL) {
    if (transcriptData.length === 0) return [];

    const queryLower = query.toLowerCase();
    const queryKeywords = queryLower.split(/\s+/).filter(w => w.length > 2);
    let allChunks = [];

    transcriptData.forEach(item => {
        // Date Filtering
        if (dateRange && item.jsDate) {
            if ((dateRange.start && item.jsDate < dateRange.start) || (dateRange.end && item.jsDate >= dateRange.end)) {
                return; // Skip item if outside date range
            }
        } else if (dateRange) {
             return; // Skip if date range specified but item has no valid date
        }

        const textChunks = chunkText(item.text || '');
        textChunks.forEach(chunk => {
            let score = 0;
            const chunkLower = chunk.toLowerCase();
            const titleLower = (item.title || '').toLowerCase();
            queryKeywords.forEach(word => {
                if (chunkLower.includes(word)) score++;
                if (titleLower.includes(word)) score += 0.5;
            });
            if (score > 0) {
                allChunks.push({ chunkText: chunk, score: score, title: item.title || 'N/A', date: item.date || 'N/A' });
            }
        });
    });

    allChunks.sort((a, b) => b.score - a.score); // Sort highest score first
    return allChunks.slice(0, maxChunks); // Return top N chunks
}
// --- End Helper ---

// --- Helper: Basic Intent Detection ---
function detectComparisonIntent(query) {
    const lowerQuery = query.toLowerCase();
    const comparisonWords = ['compare', 'vs', 'versus', 'what happened after', 'later', 'follow up', 'progress'];
    const datePattern = /(in|since|after|before|between)\s+(\d{4})/g; // Matches "in 2021", "since 2020" etc.
    const dateRangePattern = /(\d{4})\s*(-|to|vs)\s*(\d{4})/g; // Matches "2021-2023", "2020 vs 2022"

    let hasComparisonWord = comparisonWords.some(word => lowerQuery.includes(word));
    let dates = [];
    let match;
    while ((match = datePattern.exec(lowerQuery)) !== null) {
        dates.push(parseInt(match[2], 10));
    }
     while ((match = dateRangePattern.exec(lowerQuery)) !== null) {
        dates.push(parseInt(match[1], 10));
        dates.push(parseInt(match[3], 10));
    }

    // Simple logic: if comparison words OR more than one distinct year mentioned
    const distinctYears = [...new Set(dates)];
    if (hasComparisonWord || distinctYears.length >= 2) {
         // Basic extraction of keywords and dates (can be improved)
         let keywords = query; // Start with full query
         comparisonWords.forEach(w => keywords = keywords.replace(new RegExp(w, 'gi'), '')); // Remove comparison words
         dates.sort((a,b) => a-b); // Sort years
         let dateRange1 = dates.length > 0 ? { end: new Date(Date.UTC(dates[0] + 1, 0, 1)) } : null; // Up to end of first year mentioned
         let dateRange2 = dates.length > 1 ? { start: new Date(Date.UTC(dates[1], 0, 1)) } : null; // From start of second year mentioned
         // Crude keyword extraction - better NLP needed for production
         keywords = keywords.replace(/\d{4}/g, '').replace(/(in|since|after|before|between|vs|to|-)/gi, '').trim();

        return { isComparison: true, keywords: keywords || query, dateRange1, dateRange2 };
    }

    return { isComparison: false, keywords: query };
}
// --- End Helper ---


// Vercel Serverless Function handler
module.exports = async (request, response) => {
    // --- Initial Checks ---
    if (request.method !== 'POST') return response.status(405).json({ message: 'Method Not Allowed' });
    if (!genAI || !model) return response.status(500).json({ answer: 'AI Service not configured.' });
    if (dataLoadError) return response.status(500).json({ answer: dataLoadError });
    // --- End Initial Checks ---

    try {
        const { query } = request.body;
        if (!query || typeof query !== 'string' || query.trim() === '') return response.status(400).json({ answer: 'Query required.' });

        console.log("AI Search Query Received:", query);

        // --- 1. Detect Intent & Find Context ---
        const intent = detectComparisonIntent(query);
        let context1 = [];
        let context2 = [];
        let finalPrompt;
        let contextUsed = false;

        if (intent.isComparison) {
            console.log("Comparison intent detected. Keywords:", intent.keywords);
            context1 = findRelevantChunks(intent.keywords, intent.dateRange1, MAX_CHUNKS_PER_TIMEFRAME);
            context2 = findRelevantChunks(intent.keywords, intent.dateRange2, MAX_CHUNKS_PER_TIMEFRAME);
            console.log(`Found ${context1.length} chunks for timeframe 1, ${context2.length} for timeframe 2.`);

            if (context1.length > 0 || context2.length > 0) {
                 contextUsed = true;
                 const context1Text = context1.map(c => `--- Transcript: ${c.title} (${c.date}) ---\n${c.chunkText}`).join('\n\n');
                 const context2Text = context2.map(c => `--- Transcript: ${c.title} (${c.date}) ---\n${c.chunkText}`).join('\n\n');

                 finalPrompt = `Analyze and compare statements regarding the user query based on the following excerpts from 'The Money GPS' transcripts and your general knowledge. Prioritize transcript information. Be concise.\n\nUser Query: "${query}"\n\nContext from Earlier Period (if any):\n[START CONTEXT A]\n${context1Text || "None found."}\n[END CONTEXT A]\n\nContext from Later Period (if any):\n[START CONTEXT B]\n${context2Text || "None found."}\n[END CONTEXT B]\n\nAnalysis:`;
            }
        }

        // If not a comparison or comparison searches found nothing, do a general search
        if (!contextUsed) {
            console.log("Performing general context search.");
            const generalContextChunks = findRelevantChunks(query, null, MAX_CHUNKS_GENERAL);
            console.log(`Found ${generalContextChunks.length} general context chunks.`);

            if (generalContextChunks.length > 0) {
                contextUsed = true;
                const relevantContext = generalContextChunks
                    .map(chunkInfo => `--- Transcript: ${chunkInfo.title} (${chunkInfo.date}) ---\n${chunkInfo.chunkText}`)
                    .join('\n\n');

                 // Note: Prompt allows external knowledge now
                finalPrompt = `Based on the following transcript excerpts from 'The Money GPS' and your general knowledge, answer the user's question concisely. Prioritize information from the transcript context if available.\n\nUser Question: "${query}"\n\nTranscript Context:\n[START CONTEXT]\n${relevantContext}\n[END CONTEXT]\n\nAnswer:`;
            }
        }

        // If still no context found after all searches
        if (!contextUsed) {
             console.log("No relevant context found for query.");
             // Ask Gemini without specific transcript context, allowing general knowledge
             finalPrompt = `Answer the following question based on your general knowledge: "${query}"`;
             // Alternatively, return immediately:
             // return response.status(200).json({ answer: "Sorry, I couldn't find relevant transcript excerpts for your query." });
        }

        // --- 2. Call Gemini API ---
        console.log("Sending request to Gemini API...");
        const generationConfig = { temperature: 0.5, maxOutputTokens: 2048 }; // Temp 0.5 allows some interpretation/analysis
        const safetySettings = [ /* ... Standard safety settings ... */
             { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }, { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }, { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE }, { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
         ];
        const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: finalPrompt }] }], generationConfig, safetySettings });

        // --- 3. Process and Return Response ---
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