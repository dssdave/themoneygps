// Filename: api/ai-search.js (Enhanced Context + Citations)

const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const MODEL_NAME = "gemini-1.5-flash";
const API_KEY = process.env.GEMINI_API_KEY;
const MAX_CHUNKS_PER_TIMEFRAME = 4; // Slightly fewer per timeframe to allow more total context
const MAX_CHUNKS_GENERAL = 8;
const MAX_CHUNK_LENGTH = 600; // Slightly longer chunks might help context
const MAX_TOTAL_CONTEXT_CHARS = MAX_CHUNKS_PER_TIMEFRAME * 2 * MAX_CHUNK_LENGTH; // Rough limit
// --- End Configuration ---

// --- Load Transcript Data (with date parsing) ---
const dataPath = path.resolve(process.cwd(), 'search_data.json');
let transcriptData = [];
let dataLoadError = null;
try {
    if (fs.existsSync(dataPath)) {
        const jsonData = fs.readFileSync(dataPath, 'utf-8');
        transcriptData = JSON.parse(jsonData).map(item => {
            let date = null;
            let dateString = item.date || "N/A"; // Keep original string too
            if (item.date && /^\d{8}$/.test(item.date)) {
                try {
                    const year = parseInt(item.date.substring(0, 4), 10);
                    const month = parseInt(item.date.substring(4, 6), 10) - 1;
                    const day = parseInt(item.date.substring(6, 8), 10);
                    date = new Date(Date.UTC(year, month, day));
                } catch (e) { /* ignore */ }
            }
            // Ensure unique ID if possible, fallback to filename
            const uniqueId = item.id || item.filename || `item-${Math.random()}`;
            return { ...item, jsDate: date, dateString: dateString, uniqueId: uniqueId };
        });
        transcriptData.sort((a, b) => (a.jsDate && b.jsDate) ? a.jsDate - b.jsDate : 0);
    } else {
        console.warn(`AI Function: search_data.json not found at ${dataPath}.`);
        dataLoadError = "Transcript data file not found on server.";
    }
} catch (error) {
    console.error("AI Function: Error loading/processing search_data.json:", error);
    dataLoadError = "Failed to load/process transcript data on the server.";
}
// --- End Load Transcript Data ---

// --- Helper: Chunking Function ---
function chunkText(text, maxLength = MAX_CHUNK_LENGTH) {
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
if (API_KEY) { genAI = new GoogleGenerativeAI(API_KEY); model = genAI.getGenerativeModel({ model: MODEL_NAME }); }
else { console.error("AI Function: GEMINI_API_KEY not set."); }

// --- Helper: Find Relevant Chunks with Date Filtering ---
function findRelevantChunks(query, dateRange = null, maxChunks = MAX_CHUNKS_GENERAL) {
    if (transcriptData.length === 0) return [];
    const queryLower = query.toLowerCase();
    const queryKeywords = queryLower.split(/\s+/).filter(w => w.length > 2);
    let allChunks = [];

    transcriptData.forEach(item => {
        if (dateRange && item.jsDate) {
            if ((dateRange.start && item.jsDate < dateRange.start) || (dateRange.end && item.jsDate >= dateRange.end)) {
                return; // Skip item if outside date range
            }
        } else if (dateRange && !item.jsDate) {
             return; // Skip if date range specified but item has no valid date
        }

        const textChunks = chunkText(item.text || '');
        textChunks.forEach((chunk, chunkIndex) => {
            let score = 0;
            const chunkLower = chunk.toLowerCase();
            const titleLower = (item.title || '').toLowerCase();
            queryKeywords.forEach(word => {
                if (chunkLower.includes(word)) score++;
                if (titleLower.includes(word)) score += 0.5;
            });
            // Boost score slightly if query is directly in chunk
            if (chunkLower.includes(queryLower)) score += 1;

            if (score > 0) {
                allChunks.push({
                    chunkText: chunk,
                    score: score,
                    title: item.title || 'N/A',
                    date: item.dateString || 'N/A', // Use original date string
                    filename: item.filename, // Keep filename for potential linking/ID
                    chunkId: `${item.uniqueId}-${chunkIndex}` // Unique ID for the chunk
                });
            }
        });
    });

    allChunks.sort((a, b) => b.score - a.score); // Sort highest score first
    return allChunks.slice(0, maxChunks); // Return top N chunks
}
// --- End Helper ---

// --- Helper: Basic Intent Detection (Refined) ---
function detectComparisonIntent(query) {
    const lowerQuery = query.toLowerCase();
    const comparisonWords = ['compare', 'vs', 'versus', 'what happened after', 'later', 'follow up', 'progress', 'evolution', 'change over time'];
    const datePattern = /\b(in|since|after|before|around|by|from)\s+(\d{4})\b/g;
    const dateRangePattern = /\b(\d{4})\s*(-|to|vs|through|until)\s*(\d{4})\b/g;

    let hasComparisonWord = comparisonWords.some(word => lowerQuery.includes(word));
    let dates = [];
    let match;

    // Extract specific years mentioned
    while ((match = datePattern.exec(lowerQuery)) !== null) {
        dates.push(parseInt(match[2], 10));
    }
     while ((match = dateRangePattern.exec(lowerQuery)) !== null) {
        dates.push(parseInt(match[1], 10));
        dates.push(parseInt(match[3], 10));
    }
    const distinctYears = [...new Set(dates)].sort((a, b) => a - b);

    // Detect if comparison seems likely
    if (hasComparisonWord || distinctYears.length >= 2) {
         // Basic extraction of keywords and date ranges
         let keywords = query;
         comparisonWords.forEach(w => keywords = keywords.replace(new RegExp(w, 'gi'), ''));
         dates.forEach(y => keywords = keywords.replace(new RegExp(y.toString(), 'g'), ''));
         keywords = keywords.replace(/(in|since|after|before|around|by|from|vs|to|-|through|until)/gi, '').replace(/\s+/g, ' ').trim();

         // Define date ranges more carefully
         let dateRange1 = null;
         let dateRange2 = null;
         if (distinctYears.length > 0) {
             // Range 1: Up to the end of the first mentioned year
             dateRange1 = { end: new Date(Date.UTC(distinctYears[0] + 1, 0, 1)) };
         }
          if (distinctYears.length > 1) {
             // Range 2: From the start of the second (or last if >2) mentioned year onwards
             dateRange2 = { start: new Date(Date.UTC(distinctYears[distinctYears.length - 1], 0, 1)) };
          } else if (hasComparisonWord && distinctYears.length === 1) {
              // If only one year mentioned but comparison words used, look before and after
              dateRange1 = { end: new Date(Date.UTC(distinctYears[0] + 1, 0, 1)) }; // Before/during year
              dateRange2 = { start: new Date(Date.UTC(distinctYears[0] + 1, 0, 1)) }; // After year
          }

        return { isComparison: true, keywords: keywords || query, dateRange1, dateRange2 };
    }

    return { isComparison: false, keywords: query };
}
// --- End Helper ---

// --- Main Handler ---
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
        let contextChunks = []; // Will store { title, date, chunkText, chunkId }
        let finalPrompt;
        let totalChars = 0;

        if (intent.isComparison) {
            console.log("Comparison intent detected. Keywords:", intent.keywords);
            const chunks1 = findRelevantChunks(intent.keywords, intent.dateRange1, MAX_CHUNKS_PER_TIMEFRAME);
            const chunks2 = findRelevantChunks(intent.keywords, intent.dateRange2, MAX_CHUNKS_PER_TIMEFRAME);
            console.log(`Found ${chunks1.length} chunks (time 1), ${chunks2.length} (time 2).`);
            // Combine, ensuring unique chunks and respecting total length limit
            const combined = [...chunks1, ...chunks2];
            const seenChunkIds = new Set();
            for (const chunk of combined) {
                 if (!seenChunkIds.has(chunk.chunkId) && totalChars + chunk.chunkText.length < MAX_TOTAL_CONTEXT_LENGTH) {
                     contextChunks.push(chunk);
                     seenChunkIds.add(chunk.chunkId);
                     totalChars += chunk.chunkText.length;
                 }
            }
            // Sort combined chunks by date for better flow in prompt
            contextChunks.sort((a, b) => {
                const dateA = transcriptData.find(d => d.uniqueId === a.chunkId.split('-')[0])?.jsDate;
                const dateB = transcriptData.find(d => d.uniqueId === b.chunkId.split('-')[0])?.jsDate;
                return (dateA && dateB) ? dateA - dateB : 0;
            });

            if (contextChunks.length > 0) {
                const contextText = contextChunks.map(c => `--- Transcript: ${c.title} (${c.date}) ---\n${c.chunkText}`).join('\n\n');
                finalPrompt = `Analyze and compare statements regarding the user query based on the following excerpts from 'The Money GPS' transcripts and your general knowledge. Cite the specific transcript titles and dates used in your reasoning. Be concise.\n\nUser Query: "${query}"\n\nRelevant Excerpts (sorted chronologically):\n[START CONTEXT]\n${contextText}\n[END CONTEXT]\n\nAnalysis and Comparison:`;
            }

        } else { // General Query
            console.log("Performing general context search.");
            contextChunks = findRelevantChunks(intent.keywords, null, MAX_CHUNKS_GENERAL);
            console.log(`Found ${contextChunks.length} general context chunks.`);
            if (contextChunks.length > 0) {
                const contextText = contextChunks.map(c => `--- Transcript: ${c.title} (${c.date}) ---\n${c.chunkText}`).join('\n\n');
                finalPrompt = `Based on the following transcript excerpts from 'The Money GPS' and your general knowledge, answer the user's question concisely. Cite the specific transcript titles and dates used in your reasoning.\n\nUser Question: "${query}"\n\nRelevant Transcript Excerpts:\n[START CONTEXT]\n${contextText}\n[END CONTEXT]\n\nAnswer:`;
            }
        }

        // If no context found at all
        if (contextChunks.length === 0) {
            console.log("No relevant context found for query.");
            finalPrompt = `Answer the following question based on your general knowledge: "${query}" \n(Note: No specific relevant excerpts from 'The Money GPS' transcripts were found for this query).`;
        }

        // --- 2. Call Gemini API ---
        console.log("Sending request to Gemini API...");
        const generationConfig = { temperature: 0.6, maxOutputTokens: 2048 }; // Slightly more creative for analysis
        const safetySettings = [ /* Standard safety settings */ ];
        const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: finalPrompt }] }], generationConfig, safetySettings });

        // --- 3. Process and Return Response (including sources used in context) ---
        const responseCandidate = result?.response?.candidates?.[0];
        if (!responseCandidate?.content?.parts?.[0]?.text) { /* ... handle blocked/empty ... */
             const finishReason = responseCandidate?.finishReason || 'UNKNOWN'; console.warn("Gemini response blocked/empty. Reason:", finishReason);
             let errorMessage = `AI model response issue (Reason: ${finishReason}).`; if (finishReason === 'SAFETY') errorMessage = 'AI response blocked due to safety settings.';
             return response.status(200).json({ answer: `Sorry, ${errorMessage}`, sources: [] }); // Return empty sources on error
        }
        const responseText = responseCandidate.content.parts[0].text;
        console.log("Received response from Gemini.");

        // Prepare source info based on the context we SENT (Gemini citation is harder)
        const sourcesUsed = contextChunks.map(chunk => {
            // Correct Youtube URL Base
            const youtubeSearchBase = "https://www.youtube.com/results?search_query=";
            const encodedTitle = encodeURIComponent(chunk.title);
            const youtubeSearchUrl = `${youtubeSearchBase}${encodedTitle}`;
            return {
                title: chunk.title,
                date: chunk.date,
                youtubeSearchUrl: youtubeSearchUrl
            };
        });
        // De-duplicate sources based on title and date before sending
        const uniqueSources = Array.from(new Map(sourcesUsed.map(s => [`${s.title}-${s.date}`, s])).values());

        response.status(200).json({
            answer: responseText,
            sources: uniqueSources // Send source info to frontend
        });

    } catch (error) {
        console.error("Error in AI search handler:", error);
        const errorMessage = error.message || 'An unknown server error occurred.';
        response.status(500).json({ answer: `Sorry, an error occurred processing the AI search: ${errorMessage}`, sources: [] });
    }
};