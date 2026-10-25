#!/usr/bin/env node
/** Structural integration checks on a completed mock run; not a model-quality test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(process.argv[2] || '.');
const data = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(dir, 'scenarios.json'), 'utf8'));
assert.equal(data.protocol.mode, 'pipeline-only', '只验证假模型管线，避免把模型结果当成程序断言');
assert.equal(data.protocol.complete, true);
assert.equal(data.rows.length, 240);
assert.ok(data.rows.every((r) => !r.error));
const row = (id, variant) => { const r = data.rows.find((x) => x.scenarioId === id && x.variant === variant); assert.ok(r); return r; };
const text = (r) => r.messages.map((m) => m.content).join('\n');
let assertions = 4;
for (const s of cases) {
  const current = row(s.id, 'current');
  const raw = text(current);
  assert.ok(current.messages.length > 0); assertions++;
  assert.ok(!text(row(s.id, 'no_memory')).includes(s.value) || s.publicAfter); assertions++;
  if (s.category === 'audience' && !s.publicAfter) {
    assert.ok(!raw.includes(s.value));
    assert.ok(text(row(s.id, 'shared_history')).includes(s.value)); assertions += 2;
  }
  if (s.publicAfter) { assert.ok(raw.includes(s.value)); assertions++; }
  if (s.category === 'cross_scene') {
    assert.ok(raw.includes(s.value));
    if (s.ageDays > 7) assert.equal(current.recentExperiences.length, 0);
    assert.ok(text(row(s.id, 'no_recent')).includes(s.value)); assertions += 2;
  }
  if (s.category === 'correction') {
    const facts = current.injectedMemory.factRecords.filter((r) => r.status === 'active');
    assert.ok(!facts.some((r) => r.text.includes(s.value)));
    assert.ok(!raw.includes(s.value), '失效值不应从近期经历回到当前提示词'); assertions++;
    assert.ok(text(row(s.id, 'no_correction')).includes(s.value)); assertions += 2;
    if (s.expected !== 'unknown') { assert.ok(facts.some((r) => r.text.includes(s.expected))); assertions++; }
  }
  if (s.category === 'source_change') {
    assert.ok(!raw.includes(s.value));
    assert.ok(text(row(s.id, 'no_source_check')).includes(s.value)); assertions += 2;
  }
  if (s.category === 'long_context') {
    assert.equal(raw.includes(s.value), true, '关键记忆须在长人设裁剪后保留'); assertions++;
  }
}
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'isolation.json'))).unchanged, true); assertions++;
const result = { passed: true, assertions, scope: '40x6 fixture routes, isolation and prompt contents; NOT model quality', checkedAt: new Date().toISOString() };
fs.writeFileSync(path.join(dir, 'pipeline-validation.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
