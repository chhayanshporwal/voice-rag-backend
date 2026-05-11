/**
 * Annai (案内) — Voice RAG Serverless API
 * 
 * Vercel Serverless Function: POST /api/chat
 * 
 * Zero-LangChain approach — uses raw fetch for all API calls:
 *   1. Receive user query
 *   2. Embed query via Gemini gemini-embedding-001 (768-dim)
 *   3. Retrieve top 3 relevant chunks from Pinecone REST API
 *   4. Generate response via Gemini 2.0 Flash with Annai persona
 *   5. Return answer + source links + detected language
 * 
 * Environment Variables (set in Vercel dashboard):
 *   - GOOGLE_API_KEY
 *   - PINECONE_API_KEY
 *   - PINECONE_INDEX
 */

// ─── Constants ──────────────────────────────────────────────────
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 768;
const LLM_MODEL = 'gemini-2.0-flash';
const TOP_K = 3;
const ALLOWED_ORIGIN = 'https://chhayanshporwal.github.io';

// ─── Annai System Prompt ────────────────────────────────────────
const ANNAI_SYSTEM_PROMPT = `Your name is Annai (案内). You are a highly intelligent, polite, female Japanese-styled AI assistant for Chhayansh Porwal's engineering portfolio website.

CRITICAL LANGUAGE RULE:
You must auto-detect the language the user is speaking (e.g., English, Hindi, Japanese, or any other language). You MUST generate your ENTIRE response in the EXACT SAME language the user used. Never switch languages mid-response unless the user mixed languages first.

PERSONA RULES:
- Maintain a polite, warm, professional female persona across ALL languages.
- In Japanese, use です/ます polite form consistently.
- In Hindi, use respectful आप form and polite feminine speech patterns.
- In English, be warm, articulate, and professional.
- Be concise for voice readability — aim for 2-3 sentences unless the question specifically requires more detail.
- Always mention relevant project names when discussing Chhayansh's work.
- If the provided context does not contain the answer, say so honestly and politely. Never fabricate information.
- You may use light, natural expressions of enthusiasm about impressive achievements.

RESPONSE FORMAT:
- Do NOT use markdown formatting (no **, no ##, no bullet points).
- Write in natural, flowing sentences suitable for text-to-speech reading.
- End your response with a brief, inviting follow-up suggestion when appropriate.`;

// ─── Pinecone host cache ────────────────────────────────────────
let pineconeHost = null;

// ─── Embed via Gemini ───────────────────────────────────────────
async function embedQuery(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${process.env.GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) throw new Error(`Embedding error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embedding.values;
}

// ─── Pinecone query ─────────────────────────────────────────────
async function getPineconeHost() {
  if (pineconeHost) return pineconeHost;
  const res = await fetch(`https://api.pinecone.io/indexes/${process.env.PINECONE_INDEX}`, {
    headers: { 'Api-Key': process.env.PINECONE_API_KEY },
  });
  if (!res.ok) throw new Error(`Pinecone index lookup error ${res.status}`);
  const data = await res.json();
  pineconeHost = data.host;
  return pineconeHost;
}

async function queryPinecone(vector) {
  const host = await getPineconeHost();
  const res = await fetch(`https://${host}/query`, {
    method: 'POST',
    headers: {
      'Api-Key': process.env.PINECONE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      vector,
      topK: TOP_K,
      includeMetadata: true,
    }),
  });
  if (!res.ok) throw new Error(`Pinecone query error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.matches || [];
}

// ─── Generate via Gemini ────────────────────────────────────────
async function generateResponse(context, question) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: ANNAI_SYSTEM_PROMPT }] },
      contents: [{
        parts: [{ text: `CONTEXT (from Chhayansh's knowledge base):\n${context}\n\nUSER QUESTION:\n${question}` }],
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'I apologize, I could not generate a response.';
}

// ─── Language detection ─────────────────────────────────────────
function detectLanguageHint(text) {
  if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(text)) return 'ja-JP';
  if (/[\u4E00-\u9FFF]/.test(text) && !/[\u3040-\u30FF]/.test(text)) return 'zh-CN';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko-KR';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar-SA';
  return 'en-US';
}

// ─── CORS ───────────────────────────────────────────────────────
function setCorsHeaders(res, origin) {
  const allowedOrigins = [ALLOWED_ORIGIN, 'http://localhost:4000', 'http://127.0.0.1:4000'];
  const effectiveOrigin = allowedOrigins.includes(origin) ? origin : ALLOWED_ORIGIN;
  res.setHeader('Access-Control-Allow-Origin', effectiveOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ─── Main Handler ───────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  setCorsHeaders(res, origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "query" field.' });
  }

  const trimmedQuery = query.trim();

  try {
    // 1. Embed the user's query
    const queryVector = await embedQuery(trimmedQuery);

    // 2. Retrieve relevant chunks from Pinecone
    const matches = await queryPinecone(queryVector);

    // 3. Build context
    const context = matches
      .map((m, i) => `[Source ${i + 1}]: ${m.metadata?.text || ''}`)
      .join('\n\n');

    // 4. Extract source links
    const sourcesMap = new Map();
    for (const m of matches) {
      const name = m.metadata?.project_name;
      const url = m.metadata?.github_url;
      if (name && url && !sourcesMap.has(name)) {
        sourcesMap.set(name, { name, url });
      }
    }

    // 5. Generate Annai's response
    const answer = await generateResponse(context || 'No relevant context found.', trimmedQuery);

    // 6. Detect language for TTS
    const detectedLang = detectLanguageHint(answer);

    return res.status(200).json({
      answer,
      sources: Array.from(sourcesMap.values()),
      detectedLang,
      chunksUsed: matches.length,
    });
  } catch (error) {
    console.error('Annai RAG Error:', error);
    return res.status(500).json({
      error: 'Annai encountered an internal error. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}
