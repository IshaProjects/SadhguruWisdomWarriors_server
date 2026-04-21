import fs from 'fs';
import path from 'path';
import os from 'os';
import { VertexAI } from '@google-cloud/vertexai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.VERTEX_AI_LOCATION || 'us-central1';
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

// Support credentials from env var (for DigitalOcean, etc.) — write to temp file so Vertex AI can use it
const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (credentialsJson && project) {
  try {
    const tmpPath = path.join(os.tmpdir(), `vertex-credentials-${project}-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, credentialsJson, 'utf8');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  } catch (err) {
    console.error('[VertexAI] Failed to write credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON:', err.message);
  }
}

let vertexAI = null;
let genAI = null;

if (project) {
  vertexAI = new VertexAI({ project, location });
}
if (geminiApiKey) {
  genAI = new GoogleGenerativeAI(geminiApiKey);
}

const SADHGURU_KEYWORDS = [
  // Core Sadhguru & Isha
  'sadhguru',
  'ishafoundation',
  'isha',
  'innerengineering',
  'adiyogi',
  'yoga',
  'meditation',
  'spirituality',
  'sadhguruquotes',
  'hathayoga',
  'ishayoga',
  'ishayogacenter',
  'cauverycalling',
  'savesoil',
  'consciousness',
  'consciousliving',
  'conscious',
  'miracleofmind',
  'shiva',
  'consciousplanet',
  'soundsofisha',
  'devi',
  'lingabhairavi',
  'sadhguruwisdom',
  'dhyanalinga',

  // Programs & Offerings
  'innerengineeringonline',
  'iecompletion',
  'bhavaspandana',
  'shoonyameditation',
  'samyama',
  'ishavolunteers',
  'ishalife',
  'ishaashram',
  'ishaevents',
  'sacredspaces',
  'mahadev',
  'pranayama',
  'kriyayoga',
  'meditationpractice',
  'guidedmeditation',
  'yogapractice',
  'spiritualpractice',
  'dailysadhana',
  'energybody',
  'sadhanapada',

  // Spiritual Concepts
  'innerpeace',
  'bliss',
  'joyfulliving',
  'mindfulness',
  'selfawareness',
  'awakening',
  'enlightenment',
  'transformation',
  'stillness',
  'silence',
  'devotion',
  'gratitude',
  'divineenergy',
  'presence',
  'awareness',
  'culture',
  'sanatandharma',
];

const normalizeForKeywordMatch = (s) =>
  String(s || '')
    .toLowerCase()
    // "Ignore spaces" as requested; keep punctuation as-is.
    .replace(/\s+/g, '');

const normalizedKeywords = SADHGURU_KEYWORDS.map(normalizeForKeywordMatch);

function getKeywordHits({ title, description }) {
  const combined = normalizeForKeywordMatch(`${title || ''} ${description || ''}`);
  const hits = [];
  for (let i = 0; i < normalizedKeywords.length; i++) {
    const kw = normalizedKeywords[i];
    if (kw && combined.includes(kw)) hits.push(SADHGURU_KEYWORDS[i]);
  }
  // Keep the prompt shorter by de-duping while preserving first-seen order.
  return [...new Set(hits)];
}

function extractGeminiText(response) {
  if (!response) return '';
  if (typeof response.text === 'function') return response.text().trim();
  if (typeof response.text === 'string') return response.text.trim();
  return '';
}

function classifyByRuleScore({ title, description }) {
  // Per requirement: all configured keywords are treated as strong anchors.
  const keywordHits = getKeywordHits({ title, description });
  const hasStrongAnchor = keywordHits.length > 0;
  const score = hasStrongAnchor ? 5 : 0;

  if (score >= 5) {
    return { classification: 'sadhguru', score, keywordHits, hasStrongAnchor, isAmbiguous: false };
  }

  if (score <= 0 && !hasStrongAnchor) {
    return { classification: 'non sadhguru', score, keywordHits, hasStrongAnchor, isAmbiguous: false };
  }

  return { classification: null, score, keywordHits, hasStrongAnchor, isAmbiguous: true };
}

const PROMPT = `You are a classifier. Given a YouTube video title and description, determine if the video is a Sadhguru video.
A Sadhguru video is content that features Sadhguru (the Indian yogi and mystic) - his teachings, speeches, interviews, or content directly from him.

Evidence keywords detected in the title/description (case-insensitive, spaces ignored). Use these as weak hints only:
Keywords:
{KEYWORD_HITS}

Title: {TITLE}
Description: {DESCRIPTION}

Answer with exactly one word: YES or NO.`;

/**
 * Classifies a video (title + optional description) as Sadguru video or not.
 * Uses Gemini API (GEMINI_API_KEY) if set — simpler, works without GCP.
 * Otherwise uses Vertex AI (GOOGLE_CLOUD_PROJECT).
 */
export async function classifySadguruVideo(title, description = '') {
  if (!title || typeof title !== 'string') {
    return false;
  }

  const safeTitle = title.replace(/"/g, '');
  const safeDescription = String(description || '').slice(0, 4000).replace(/"/g, '');
  const ruleResult = classifyByRuleScore({ title: safeTitle, description: safeDescription });
  if (!ruleResult.isAmbiguous) {
    return ruleResult.classification === 'sadhguru';
  }
  const { keywordHits } = ruleResult;

  const prompt = PROMPT.replace('{KEYWORD_HITS}', keywordHits.length ? keywordHits.join(', ') : 'NONE')
    .replace('{TITLE}', safeTitle)
    .replace('{DESCRIPTION}', safeDescription);

  // Prefer Gemini API (Google AI Studio) — simpler setup, no Vertex AI needed
  if (genAI) {
    const modelId = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const model = genAI.getGenerativeModel({ model: modelId });
    const result = await model.generateContent(prompt);
    const text = extractGeminiText(result.response).toUpperCase();
    return text.startsWith('YES');
  }

  // Fall back to Vertex AI
  if (!vertexAI) {
    throw new Error(
      'Configure GEMINI_API_KEY (from aistudio.google.com) or GOOGLE_CLOUD_PROJECT for Vertex AI.'
    );
  }

  const modelId = process.env.VERTEX_AI_MODEL || 'gemini-2.5-flash';
  const model = vertexAI.getGenerativeModel({ model: modelId });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  const response = result.response;
  const text =
    response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() || '';
  return text.startsWith('YES');
}

const BATCH_SIZE = 25;

/**
 * Batch classify multiple videos in a single API call.
 * @param {Array<{_id: string, title: string}>} videos
 * @returns {Promise<Map<string, string>>} Map of videoId -> 'sadhguru' | 'non sadhguru'
 */
export async function classifySadguruVideoBatch(videos) {
  if (!videos || videos.length === 0) {
    return new Map();
  }

  const results = new Map();

  const unresolved = [];
  for (const v of videos) {
    const ruleResult = classifyByRuleScore({
      title: v.title || '',
      description: v.description || '',
    });
    if (!ruleResult.isAmbiguous) {
      results.set(String(v._id), ruleResult.classification);
    } else {
      unresolved.push(v);
    }
  }

  for (let i = 0; i < unresolved.length; i += BATCH_SIZE) {
    const batch = unresolved.slice(i, i + BATCH_SIZE);
    const batchInput = batch.map((v) => ({
      id: String(v._id),
      title: (v.title || '').replace(/"/g, "'"),
      description: String(v.description || '')
        .slice(0, 4000)
        .replace(/"/g, "'"),
      keywordHits: getKeywordHits({
        title: v.title || '',
        description: v.description || '',
      }),
    }));
    const batchPrompt = `You are a classifier. For each YouTube video, using its title and description (and ONLY as weak hints, the detected keyword evidence), determine if it is a Sadguru video.
A Sadhguru video features Sadhguru (the Indian yogi and mystic) - his teachings, speeches, interviews, or content directly from him.

Evidence keywords detected in the title/description are provided per video as keywordHits (case-insensitive, spaces ignored). Use them as weak hints only:

Videos to classify (JSON array):
${JSON.stringify(batchInput)}

Return ONLY a JSON object. Key = video id, value = "sadhguru" or "non sadhguru".
Example: {"id1":"sadhguru","id2":"non sadhguru"}
No other text.`;

    try {
      let text = '';
      if (genAI) {
        const modelId = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        const model = genAI.getGenerativeModel({ model: modelId });
        const result = await model.generateContent(batchPrompt);
        text = extractGeminiText(result.response);
      } else if (vertexAI) {
        const modelId = process.env.VERTEX_AI_MODEL || 'gemini-2.5-flash';
        const model = vertexAI.getGenerativeModel({ model: modelId });
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: batchPrompt }] }],
        });
        text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      } else {
        throw new Error('Configure GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT.');
      }

      const jsonStr = text.replace(/```json\s*/i, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      for (const [id, value] of Object.entries(parsed)) {
        const v = String(value).toLowerCase();
        results.set(id, v === 'sadhguru' ? 'sadhguru' : 'non sadhguru');
      }
    } catch (err) {
      throw err;
    }
  }

  return results;
}
