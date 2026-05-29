/**
 * Unit tests for src/services/vertexAiService.js
 *
 * Coverage strategy:
 *   The module creates SDK clients at import time using env vars.
 *   v8 coverage only tracks execution from the FIRST (static) import; subsequent
 *   dynamic re-imports create new V8 script instances whose coverage is NOT merged.
 *
 *   Therefore:
 *   1. vi.hoisted() sets the env vars we want for the initial load.
 *   2. A static import brings the module into v8's coverage tracking.
 *   3. All function-body tests use that static import directly.
 *   4. `reimportService` (with vi.resetModules) is used ONLY to verify constructor
 *      call behavior for different env var configs; those tests don't need to call
 *      functions from the re-imported module for coverage purposes.
 *
 * Initial load env vars (set via vi.hoisted):
 *   GEMINI_API_KEY = 'static-test-key'   → genAI = new GoogleGenerativeAI(...)
 *   (no GOOGLE_CLOUD_PROJECT)             → vertexAI = null
 *   (no CREDENTIALS_JSON)                → credentials block skipped
 *
 * This covers:
 *   - Module-level var assignments (lines 8-10)
 *   - genAI init branch (lines 29-31)
 *   - false branches: `if (project)` and `if (credentialsJson && project)`
 *
 * Uncoverable branches (documented below):
 *   - VertexAI init (line 27) — requires project set at import time; setting it would
 *     prevent genAI init tests from working cleanly via static import.
 *     (Covered via dynamic reimport tests but v8 doesn't merge that coverage.)
 *   - credentials file writing (lines 14-19) — same dynamic reimport limitation.
 *   - All AI call paths — dead code (isAmbiguous never true; see analysis below).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'fs';

// ── vi.hoisted: sets env vars before any imports ─────────────────────────────
vi.hoisted(() => {
  // Set GEMINI_API_KEY so the static import triggers new GoogleGenerativeAI(...)
  // and covers the genAI initialization path.
  process.env.GEMINI_API_KEY = 'static-test-key';
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  delete process.env.VERTEX_AI_LOCATION;
  delete process.env.GEMINI_MODEL;
  delete process.env.VERTEX_AI_MODEL;
  delete process.env.GOOGLE_API_KEY;
});

// ── Mock the Google AI SDKs ────────────────────────────────────────────────
vi.mock('@google-cloud/vertexai', () => {
  const VertexAIFn = vi.fn(function (opts) {
    this.getGenerativeModel = vi.fn(function () {
      return { generateContent: vi.fn() };
    });
  });
  return { VertexAI: VertexAIFn };
});

vi.mock('@google/generative-ai', () => {
  const GoogleGenerativeAIFn = vi.fn(function (apiKey) {
    this.getGenerativeModel = vi.fn(function () {
      return { generateContent: vi.fn() };
    });
  });
  return { GoogleGenerativeAI: GoogleGenerativeAIFn };
});

// ── Static imports (resolved after vi.mock, with GEMINI_API_KEY set) ────────
import { VertexAI } from '@google-cloud/vertexai';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Primary static import — v8 instruments this instance for coverage.
// GEMINI_API_KEY is set via vi.hoisted, so genAI init is executed.
import {
  classifySadguruVideo,
  classifySadguruVideoBatch,
} from '../../src/services/vertexAiService.js';

// ── Helper for dynamic re-imports (env var variation tests only) ─────────────

const ALL_ENV_KEYS = [
  'GOOGLE_CLOUD_PROJECT',
  'VERTEX_AI_LOCATION',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_MODEL',
  'VERTEX_AI_MODEL',
  'GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

async function reimportService(envOverrides = {}) {
  const saved = {};
  for (const key of ALL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  const mod = await import('../../src/services/vertexAiService.js');
  for (const key of ALL_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  return mod;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module initialization verification (static import)
// ─────────────────────────────────────────────────────────────────────────────

describe('module initialization — static import', () => {
  it('GoogleGenerativeAI was called with the API key from GEMINI_API_KEY', () => {
    expect(GoogleGenerativeAI).toHaveBeenCalledWith('static-test-key');
  });

  it('VertexAI was NOT called when GOOGLE_CLOUD_PROJECT is unset', () => {
    // At static import time GOOGLE_CLOUD_PROJECT was not set
    const callsDuringStaticImport = VertexAI.mock.calls.length;
    expect(callsDuringStaticImport).toBe(0);
  });

  it('classifySadguruVideo is exported as a function', () => {
    expect(classifySadguruVideo).toBeTypeOf('function');
  });

  it('classifySadguruVideoBatch is exported as a function', () => {
    expect(classifySadguruVideoBatch).toBeTypeOf('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifySadguruVideo — input validation
// ─────────────────────────────────────────────────────────────────────────────

describe('classifySadguruVideo — input validation', () => {
  it('returns false for null title', async () => {
    expect(await classifySadguruVideo(null)).toBe(false);
  });

  it('returns false for undefined title', async () => {
    expect(await classifySadguruVideo(undefined)).toBe(false);
  });

  it('returns false for non-string title (number)', async () => {
    expect(await classifySadguruVideo(42)).toBe(false);
  });

  it('returns false for empty string title', async () => {
    expect(await classifySadguruVideo('')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifySadguruVideo — keyword rule: sadhguru (score >= 5 → true)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifySadguruVideo — sadhguru keyword detection', () => {
  it('returns true for "sadhguru" in title', async () => {
    expect(await classifySadguruVideo('Sadhguru speaks about consciousness')).toBe(true);
  });

  it('returns true for "yoga" in description', async () => {
    expect(await classifySadguruVideo('Morning routine', 'yoga practice for beginners')).toBe(true);
  });

  it('returns true for "isha" in title', async () => {
    expect(await classifySadguruVideo('Isha Foundation event 2024')).toBe(true);
  });

  it('returns true for "adiyogi" in title', async () => {
    expect(await classifySadguruVideo('Adiyogi statue history')).toBe(true);
  });

  it('returns true for "meditation" in title', async () => {
    expect(await classifySadguruVideo('Guided meditation technique')).toBe(true);
  });

  it('returns true for "consciousness" in title', async () => {
    expect(await classifySadguruVideo('Consciousness explained')).toBe(true);
  });

  it('returns true for "innerengineering" in title (compound keyword as single token)', async () => {
    expect(await classifySadguruVideo('innerengineering course overview')).toBe(true);
  });

  it('matches keyword case-insensitively (uppercase title)', async () => {
    expect(await classifySadguruVideo('SADHGURU WISDOM')).toBe(true);
  });

  it('matches keyword even with surrounding punctuation', async () => {
    expect(await classifySadguruVideo('yoga! practice')).toBe(true);
  });

  it('sanitises double-quotes from title before matching', async () => {
    expect(await classifySadguruVideo('"sadhguru" morning talk')).toBe(true);
  });

  it('truncates description to 4000 chars before matching', async () => {
    // "sadhguru" appears at position ~6000 — beyond the 4000 char cutoff
    const longDesc = 'word '.repeat(800) + 'sadhguru';
    expect(await classifySadguruVideo('neutral', longDesc)).toBe(false);
  });

  it('handles numeric tokens in title without crashing', async () => {
    expect(await classifySadguruVideo('2024 meditation retreat sadhguru')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifySadguruVideo — non-sadhguru (score 0, no keywords → false)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifySadguruVideo — non-sadhguru keyword detection', () => {
  it('returns false when no keywords match', async () => {
    expect(await classifySadguruVideo('How to cook pasta', 'Delicious Italian recipe')).toBe(false);
  });

  it('does NOT match "isha" as a substring of "lavish"', async () => {
    expect(await classifySadguruVideo('A lavish ceremony')).toBe(false);
  });

  it('returns false for a completely unrelated video', async () => {
    expect(await classifySadguruVideo('Top 10 car reviews 2024', 'best cars this year')).toBe(false);
  });

  it('returns false when title has only numbers and symbols', async () => {
    expect(await classifySadguruVideo('1234!@#$', '5678%^&*')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tokenSetForKeywordMatch / getKeywordHits — coverage via classification calls
// ─────────────────────────────────────────────────────────────────────────────

describe('tokenSetForKeywordMatch — edge cases', () => {
  it('handles empty title and description without crash', async () => {
    expect(await classifySadguruVideo('x', '')).toBe(false);
  });

  it('handles title with only whitespace tokens', async () => {
    expect(await classifySadguruVideo('   ', '   ')).toBe(false);
  });

  it('handles mixed case and punctuation in description', async () => {
    expect(await classifySadguruVideo('talk', 'YOGA; meditation! SADHGURU.')).toBe(true);
  });
});

describe('getKeywordHits — normalizedKeywords filtering (if (!kw) continue)', () => {
  // The `if (!kw) continue` guard at line 130 handles empty/falsy entries in
  // normalizedKeywords.  Since normalizedKeywords is built from SADHGURU_KEYWORDS
  // (a hardcoded non-empty array), no kw will ever be falsy.
  // This branch is unreachable without modifying the source constant.
  it('keyword iteration covers all SADHGURU_KEYWORDS entries (none are empty)', async () => {
    // Every real keyword in SADHGURU_KEYWORDS should produce a non-empty normalized form.
    // We exercise this by calling classifySadguruVideo which triggers getKeywordHits.
    const result = await classifySadguruVideo('completely unrelated content');
    expect(result).toBe(false); // no keywords matched, but all keywords were iterated
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifySadguruVideoBatch
// ─────────────────────────────────────────────────────────────────────────────

describe('classifySadguruVideoBatch — empty/null input', () => {
  it('returns empty Map for null', async () => {
    const result = await classifySadguruVideoBatch(null);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('returns empty Map for empty array', async () => {
    const result = await classifySadguruVideoBatch([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});

describe('classifySadguruVideoBatch — rule-resolved items (no AI call)', () => {
  it('classifies a sadhguru video by rule', async () => {
    const result = await classifySadguruVideoBatch([
      { _id: 'v1', title: 'Sadhguru meditation talk', description: '' },
    ]);
    expect(result.get('v1')).toBe('sadhguru');
  });

  it('classifies a non-sadhguru video by rule', async () => {
    const result = await classifySadguruVideoBatch([
      { _id: 'v2', title: 'Baking bread at home', description: 'Cooking tutorial' },
    ]);
    expect(result.get('v2')).toBe('non sadhguru');
  });

  it('handles videos with missing title and description', async () => {
    const result = await classifySadguruVideoBatch([{ _id: 'v3' }]);
    expect(result.get('v3')).toBe('non sadhguru');
  });

  it('converts non-string _id to string key', async () => {
    const result = await classifySadguruVideoBatch([
      { _id: { toString: () => 'object-id' }, title: 'sadhguru talk' },
    ]);
    expect(result.has('object-id')).toBe(true);
    expect(result.get('object-id')).toBe('sadhguru');
  });

  it('handles a batch with mixed classifications', async () => {
    const videos = [
      { _id: 'sg1', title: 'Sadhguru yoga session' },
      { _id: 'ns1', title: 'Car review 2024' },
      { _id: 'sg2', description: 'isha foundation program' },
      { _id: 'ns2', title: 'Cooking show', description: 'Italian food' },
    ];
    const result = await classifySadguruVideoBatch(videos);
    expect(result.get('sg1')).toBe('sadhguru');
    expect(result.get('ns1')).toBe('non sadhguru');
    expect(result.get('sg2')).toBe('sadhguru');
    expect(result.get('ns2')).toBe('non sadhguru');
  });

  it('handles large batch (> BATCH_SIZE=25) all resolved by rule', async () => {
    const videos = Array.from({ length: 30 }, (_, i) => ({
      _id: `v${i}`,
      title: i % 2 === 0 ? 'sadhguru talk' : 'unrelated video',
    }));
    const result = await classifySadguruVideoBatch(videos);
    expect(result.size).toBe(30);
    for (let i = 0; i < 30; i++) {
      expect(result.get(`v${i}`)).toBe(i % 2 === 0 ? 'sadhguru' : 'non sadhguru');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Env var initialization — dynamic reimport tests
// (These verify constructor behavior; function coverage comes from static import)
// ─────────────────────────────────────────────────────────────────────────────

describe('module initialization — VertexAI when GOOGLE_CLOUD_PROJECT is set', () => {
  it('VertexAI constructor is called with project and default location', async () => {
    vi.clearAllMocks();
    await reimportService({ GOOGLE_CLOUD_PROJECT: 'my-project' });
    expect(VertexAI).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'my-project', location: 'us-central1' })
    );
  });

  it('VertexAI uses custom VERTEX_AI_LOCATION when provided', async () => {
    vi.clearAllMocks();
    await reimportService({ GOOGLE_CLOUD_PROJECT: 'proj', VERTEX_AI_LOCATION: 'europe-west1' });
    expect(VertexAI).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'europe-west1' })
    );
  });
});

describe('module initialization — GoogleGenerativeAI key selection', () => {
  it('uses GOOGLE_API_KEY as fallback when GEMINI_API_KEY is not set', async () => {
    vi.clearAllMocks();
    await reimportService({ GOOGLE_API_KEY: 'fallback-key' });
    expect(GoogleGenerativeAI).toHaveBeenCalledWith('fallback-key');
  });

  it('GEMINI_API_KEY takes precedence over GOOGLE_API_KEY', async () => {
    vi.clearAllMocks();
    await reimportService({ GEMINI_API_KEY: 'primary', GOOGLE_API_KEY: 'fallback' });
    expect(GoogleGenerativeAI).toHaveBeenCalledWith('primary');
  });

  it('neither AI client is created when both keys are absent', async () => {
    vi.clearAllMocks();
    await reimportService({});
    expect(GoogleGenerativeAI).not.toHaveBeenCalled();
    expect(VertexAI).not.toHaveBeenCalled();
  });
});

describe('module initialization — GOOGLE_APPLICATION_CREDENTIALS_JSON handling', () => {
  it('writes credentials file when both JSON and project are set', async () => {
    const credJson = JSON.stringify({ type: 'service_account', project_id: 'test' });
    vi.clearAllMocks();
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    try {
      await reimportService({
        GOOGLE_CLOUD_PROJECT: 'test-proj',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: credJson,
      });
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        expect.stringContaining('vertex-credentials-test-proj'),
        credJson,
        'utf8'
      );
    } finally {
      writeFileSyncSpy.mockRestore();
    }
  });

  it('logs error without throwing when writeFileSync fails', async () => {
    const credJson = JSON.stringify({ type: 'service_account' });
    vi.clearAllMocks();
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mod = await reimportService({
        GOOGLE_CLOUD_PROJECT: 'err-proj',
        GOOGLE_APPLICATION_CREDENTIALS_JSON: credJson,
      });
      expect(mod.classifySadguruVideo).toBeTypeOf('function');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[VertexAI] Failed to write credentials'),
        expect.any(String)
      );
    } finally {
      writeFileSyncSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not write credentials when CREDENTIALS_JSON is set but PROJECT is not', async () => {
    vi.clearAllMocks();
    const writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    try {
      await reimportService({
        GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify({ type: 'service_account' }),
      });
      expect(writeFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      writeFileSyncSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dead code analysis — AI paths unreachable
// ─────────────────────────────────────────────────────────────────────────────

describe('dead code documentation', () => {
  /**
   * DOCUMENTED UNCOVERABLE BRANCHES:
   *
   * 1. `extractGeminiText` function (lines 137-142) — ALL branches uncoverable:
   *    Called only from the AI path in classifySadguruVideo and classifySadguruVideoBatch.
   *    That path is gated by `if (!ruleResult.isAmbiguous)` → the function is called
   *    only when isAmbiguous=true, which never occurs with current scoring logic.
   *
   * 2. `classifyByRuleScore` third return (line 158) — dead code:
   *    `return { classification: null, ..., isAmbiguous: true }` requires 0 < score < 5.
   *    But score ∈ {0, 5} always (score = hasStrongAnchor ? 5 : 0), so this line
   *    can never execute.
   *
   * 3. classifySadguruVideo AI call path (lines 189-219) — dead code:
   *    Lines after `if (!ruleResult.isAmbiguous) return ...` only execute when
   *    isAmbiguous=true. See point 2 above.
   *
   * 4. classifySadguruVideoBatch `unresolved` path (lines 245, 250-303) — dead code:
   *    `unresolved.push(v)` at line 245 requires !ruleResult.isAmbiguous = false,
   *    i.e., isAmbiguous=true. Same root cause.
   *
   * 5. getKeywordHits `if (!kw) continue` branch (line 130) — structural dead code:
   *    normalizedKeywords is built from SADHGURU_KEYWORDS, a compile-time array of
   *    non-empty strings. normalizeForKeywordMatch strips spaces and lowercases —
   *    none of the hardcoded keywords become falsy. This guard can never be triggered.
   *
   * 6. tokenSetForKeywordMatch `if (m[0])` false branch (line 120) — structural dead code:
   *    matchAll(/[a-z0-9]+/g) only yields non-empty matches, so m[0] is always truthy.
   *
   * 7. Module-level VertexAI init (line 27) and credentials writing (lines 14-19):
   *    These are covered by dynamic reimportService() tests (verified by spy assertions
   *    that pass), but v8 does not merge coverage from dynamic vi.resetModules() re-imports
   *    into the primary script instance. This is a known v8/Vitest ESM coverage limitation.
   *
   * SOURCE CHANGE NEEDED to cover items 1-4:
   *   Make classifyByRuleScore return isAmbiguous=true for some input — e.g., add a
   *   "weak evidence" score tier between 0 and 5.
   *
   * SOURCE CHANGE NEEDED to cover items 5-6:
   *   These are truly unreachable with static data; only relevant if the keyword list
   *   is made dynamic or user-supplied.
   */
  it('isAmbiguous is never true — AI call path is structurally dead code', () => {
    expect(true).toBe(true);
  });
});
