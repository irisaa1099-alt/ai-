import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, scoreAnswer } from './scenarios.mjs';
import { usageFor, writeReport } from './report.mjs';

test('40 frozen inputs have unique IDs, 5 balanced categories and hidden answers absent from questions', () => {
  assert.equal(SCENARIOS.length, 40);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 40);
  for (const category of new Set(SCENARIOS.map((s) => s.category))) assert.equal(SCENARIOS.filter((s) => s.category === category).length, 8);
  for (const s of SCENARIOS) { assert.ok(!s.question.includes(s.value)); assert.ok(!s.question.includes(s.replacement)); }
});
test('strict scorer catches wrong/contradictory/hidden values, truncation and API error', () => {
  const known = SCENARIOS.find((s) => s.category === 'correction' && s.expected !== 'unknown');
  assert.equal(scoreAnswer(known, known.expected).pass, true);
  assert.equal(scoreAnswer(known, `${known.expected}，不是${known.value}`).oldFact, true);
  assert.equal(scoreAnswer(known, known.value).pass, false);
  assert.equal(scoreAnswer(known, known.expected, { truncated: true }).pass, false);
  assert.equal(scoreAnswer(known, '', { error: true }).status, 'error');
  const hidden = SCENARIOS.find((s) => s.category === 'audience' && s.expected === 'unknown');
  assert.equal(scoreAnswer(hidden, '“不知道。”').pass, true);
  assert.equal(scoreAnswer(hidden, `不知道，大概${hidden.value}`).leak, true);
  assert.equal(scoreAnswer(hidden, '大概某处吧').pass, false);
});
test('usage never substitutes estimates; cache pricing and missing usage are explicit', () => {
  assert.equal(usageFor([{}]).input, null);
  const c = { response: { usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 500 } } };
  const p = { inputPerMillion: 2, cachedInputPerMillion: 1, outputPerMillion: 4 };
  assert.equal(usageFor([c], p).estimatedCost, 0.0019);
  assert.equal(usageFor([c, {}], p).estimatedCost, null);
  assert.equal(usageFor([c], null).estimatedCost, null);
});
test('partial run reports attempted denominators and excludes API errors from pairs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-eval-report-test-'));
  try {
    const s = SCENARIOS[0];
    const good = { scenarioId: s.id, category: s.category, variant: 'current', text: s.expected,
      score: scoreAnswer(s, s.expected), elapsedMs: 10 };
    const bad = { ...good, variant: 'no_memory', error: 'HTTP 401', score: scoreAnswer(s, '', { error: true }) };
    const protocol = { mode: 'live', version: 'test', variants: ['current', 'no_memory'], expectedCells: 4, complete: false,
      configuration: { provider: 'test', model: 'test', answerParams: {} } };
    const summary = writeReport({ out: dir, protocol, rows: [good, bad], preparations: [], calls: [], scenarios: [s],
      isolation: { unchanged: true, before: { fileCount: 0 }, after: { fileCount: 0 } }, stopReason: 'upstream_error' });
    assert.equal(summary.stats.find((x) => x.variant === 'no_memory').attempted, 1);
    assert.equal(summary.pairwise[0].pairs, 0);
    assert.equal(summary.complete, false);
    assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /未完成/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
