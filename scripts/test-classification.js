#!/usr/bin/env node
/**
 * Test script for video classification (Sadhguru vs non-Sadhguru).
 * Run from server/: node scripts/test-classification.js
 *
 * Requires GEMINI_API_KEY or Vertex AI (GOOGLE_CLOUD_PROJECT) in .env
 */

import 'dotenv/config';
import { classifySadguruVideo, classifySadguruVideoBatch } from '../src/services/vertexAiService.js';

const TEST_VIDEOS = [
  { _id: 't1', title: 'Sadhguru on Inner Engineering - Full Talk' },
  { _id: 't2', title: 'How to Make Pasta - Easy Recipe' },
  { _id: 't3', title: 'Sadhguru Explains the Science of Yoga' },
  { _id: 't4', title: 'Top 10 Travel Destinations 2024' },
  { _id: 't5', title: 'Sadhguru at United Nations - Speech' },
  { _id: 't6', title: 'Cooking Dal - Indian Lentil Recipe' },
];

async function main() {
  console.log('Testing batch video classification...\n');
  console.log('Config:');
  console.log('  GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✓ set' : '✗ not set');
  console.log('  GOOGLE_CLOUD_PROJECT:', process.env.GOOGLE_CLOUD_PROJECT || '(not set)');
  console.log('  VERTEX_AI_MODEL:', process.env.VERTEX_AI_MODEL || 'gemini-2.5-flash');
  console.log('  GEMINI_MODEL:', process.env.GEMINI_MODEL || 'gemini-2.5-flash');
  console.log('');

  try {
    const results = await classifySadguruVideoBatch(TEST_VIDEOS);
    let passed = 0;
    for (const v of TEST_VIDEOS) {
      const value = results.get(String(v._id));
      const label = value || '(missing)';
      const ok = value === 'sadhguru' || value === 'non sadhguru';
      console.log(`${ok ? '✓' : '✗'} "${v.title}" → ${label}`);
      if (ok) passed++;
    }
    console.log('');
    console.log(`Results: ${passed}/${TEST_VIDEOS.length} classified`);
    if (passed < TEST_VIDEOS.length) process.exit(1);
    console.log('\nBatch classification test passed.');
  } catch (err) {
    console.error('Batch test failed:', err.message);
    process.exit(1);
  }
}

main();
