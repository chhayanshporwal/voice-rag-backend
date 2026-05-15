/**
 * Annai (案内) — Voice RAG Serverless API v2
 * 
 * Vercel Serverless Function: POST /api/chat
 * 
 * Features:
 *   1. Conversational memory — rewrites pronoun-dependent queries into standalone questions
 *   2. Multi-lingual support restricted to English & Hindi
 *   3. Premium TTS fallback chain: ElevenLabs → Google Cloud TTS
 *   4. Returns text response + Base64 audio in a single JSON payload
 * 
 * Environment Variables (set in Vercel dashboard):
 *   - GOOGLE_API_KEY
 *   - PINECONE_API_KEY
 *   - PINECONE_INDEX
 *   - ELEVENLABS_API_KEY
 *   - ELEVENLABS_VOICE_ID
 *   - GOOGLE_CLOUD_TTS_API_KEY
 */

// ─── Constants ──────────────────────────────────────────────────
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIM = 768;
const LLM_MODEL = 'gemini-1.5-flash';
const TOP_K = 3;
const ALLOWED_ORIGIN = 'https://chhayanshporwal.github.io';

// ─── Annai System Prompt ────────────────────────────────────────
const ANNAI_SYSTEM_PROMPT = `Your name is Annai (案内). You are a highly intelligent, polite, female AI assistant for Chhayansh Porwal's engineering portfolio website.

CRITICAL LANGUAGE RULE:
You are strictly restricted to responding ONLY in English or Hindi.
- If the user writes in English → respond entirely in English.
- If the user writes in Hindi → respond entirely in Hindi using Devanagari script.
- If the user writes in ANY OTHER language (Japanese, Chinese, French, Spanish, etc.) → respond in English with exactly this message: "I apologize, but I am currently only configured to speak English and Hindi. Please ask your question in either language and I will be happy to help!"

PERSONA RULES:
- Maintain a polite, warm, professional female persona.
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

// ─── Conversational Memory: Contextualize Query ─────────────────
/**
 * If the user's latest query depends on conversational context (pronouns,
 * references like "that project", "his", "it"), use the LLM to rewrite it
 * into a fully standalone question suitable for vector retrieval.
 */
async function contextualizeQuery(query, history) {
  if (!history || history.length === 0) return query;

  const historyText = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Annai'}: ${m.content}`)
    .join('\n');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: `You are a query rewriter. Given a conversation history and a follow-up question, rewrite the follow-up question to be a standalone question that can be understood without the conversation history. Do NOT answer the question — only rewrite it. If the question is already standalone, return it unchanged. Output ONLY the rewritten question, nothing else.`,
        }],
      },
      contents: [{
        parts: [{
          text: `CONVERSATION HISTORY:\n${historyText}\n\nFOLLOW-UP QUESTION:\n${query}\n\nSTANDALONE QUESTION:`,
        }],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 128,
      },
    }),
  });

  if (!res.ok) {
    console.warn(`Contextualization failed (${res.status}), using original query.`);
    return query;
  }

  const data = await res.json();
  const rewritten = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  return rewritten || query;
}

// ─── Generate via Gemini (with conversation history) ────────────
async function generateResponse(context, question, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${process.env.GOOGLE_API_KEY}`;

  // Build multi-turn contents array
  const contents = [];

  // Inject conversation history as prior turns
  if (history && history.length > 0) {
    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }],
      });
    }
  }

  // Add the current user question with retrieved context
  contents.push({
    role: 'user',
    parts: [{ text: `CONTEXT (from Chhayansh's knowledge base):\n${context}\n\nUSER QUESTION:\n${question}` }],
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: ANNAI_SYSTEM_PROMPT }] },
      contents,
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
  return 'en-US';
}

// ─── TTS Fallback Architecture ──────────────────────────────────
/**
 * Synthesize speech from text using a two-tier fallback:
 *   Primary:  ElevenLabs (eleven_multilingual_v2)
 *   Fallback: Google Cloud Text-to-Speech (Neural2 voices)
 *
 * Returns a Base64-encoded MP3 string, or null if both fail.
 */
async function generateSpeech(text, langCode) {
  // ── Primary: ElevenLabs ──
  try {
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    if (elevenLabsKey) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'xi-api-key': elevenLabsKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.4,
            use_speaker_boost: true,
          },
        }),
      });

      if (res.ok) {
        const buffer = await res.arrayBuffer();
        return Buffer.from(buffer).toString('base64');
      }

      console.warn(`ElevenLabs TTS failed (${res.status}): ${res.statusText}. Falling back to Google Cloud TTS.`);
    }
  } catch (err) {
    console.warn('ElevenLabs TTS error:', err.message, '— falling back to Google Cloud TTS.');
  }

  // ── Fallback: Google Cloud TTS ──
  try {
    const gcTtsKey = process.env.GOOGLE_CLOUD_TTS_API_KEY;
    if (!gcTtsKey) {
      console.warn('GOOGLE_CLOUD_TTS_API_KEY not set, skipping TTS fallback.');
      return null;
    }

    // Select voice based on detected language
    const voiceName = langCode === 'hi-IN' ? 'hi-IN-Neural2-A' : 'en-US-Neural2-F';
    const voiceLang = langCode === 'hi-IN' ? 'hi-IN' : 'en-US';

    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${gcTtsKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: voiceLang,
          name: voiceName,
          ssmlGender: 'FEMALE',
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1.0,
          pitch: 1.0,
        },
      }),
    });

    if (!res.ok) {
      console.warn(`Google Cloud TTS failed (${res.status}): ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    return data.audioContent || null; // Already Base64-encoded by Google
  } catch (err) {
    console.warn('Google Cloud TTS error:', err.message);
    return null;
  }
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

  const { query, history } = req.body || {};
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty "query" field.' });
  }

  const trimmedQuery = query.trim();
  // Sanitize history: accept array of {role, content}, limit to last 6
  const sanitizedHistory = Array.isArray(history)
    ? history
        .filter((m) => m && typeof m.role === 'string' && typeof m.content === 'string')
        .slice(-6)
    : [];

  try {
    // 1. Contextualize the query using conversation history
    const standaloneQuery = await contextualizeQuery(trimmedQuery, sanitizedHistory);

    // 2. Embed the standalone query
    const queryVector = await embedQuery(standaloneQuery);

    // 3. Retrieve relevant chunks from Pinecone
    const matches = await queryPinecone(queryVector);

    // 4. Build context
    const context = matches
      .map((m, i) => `[Source ${i + 1}]: ${m.metadata?.text || ''}`)
      .join('\n\n');

    // 5. Extract source links
    const sourcesMap = new Map();
    for (const m of matches) {
      const name = m.metadata?.project_name;
      const url = m.metadata?.github_url;
      if (name && url && !sourcesMap.has(name)) {
        sourcesMap.set(name, { name, url });
      }
    }

    // 6. Generate Annai's response (with conversation history)
    const answer = await generateResponse(context || 'No relevant context found.', trimmedQuery, sanitizedHistory);

    // 7. Detect language for TTS
    const detectedLang = detectLanguageHint(answer);

    // 8. Synthesize speech (ElevenLabs → Google Cloud TTS fallback)
    let audioBase64 = null;
    try {
      audioBase64 = await generateSpeech(answer, detectedLang);
    } catch (ttsErr) {
      console.warn('TTS pipeline failed entirely:', ttsErr.message);
    }

    return res.status(200).json({
      answer,
      sources: Array.from(sourcesMap.values()),
      detectedLang,
      chunksUsed: matches.length,
      audioBase64,
    });
  } catch (error) {
    console.error('Annai RAG Error:', error);
    let models = [];
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`);
      const data = await res.json();
      models = data.models.map(m => m.name);
    } catch(e) {}
    
    return res.status(500).json({
      error: 'Annai encountered an internal error. Please try again.',
      details: error.message,
      availableModels: models
    });
  }
}
