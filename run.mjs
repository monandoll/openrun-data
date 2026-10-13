// Runs the trend pipeline (GitHub Actions) and stores results as JSON files in this repo.
// data/list.json is served to the app through openrun-api (/v1/list).
import { stageA, stageB } from './trend.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
mkdirSync('data', { recursive: true });
const f = (k) => 'data/' + k.replace(/^or:/, '').replace(/[^a-z0-9_-]/gi, '_') + '.json';
const env = {
  NAVER_SEARCH_ID: process.env.NAVER_ID, NAVER_SEARCH_SECRET: process.env.NAVER_SECRET,
  KV: { get: async (k) => (existsSync(f(k)) ? readFileSync(f(k), 'utf8') : null), put: async (k, v) => writeFileSync(f(k), v) },
};
console.log('A', JSON.stringify(await stageA(env), null, 1));
console.log('B', JSON.stringify(await stageB(env), null, 1));
