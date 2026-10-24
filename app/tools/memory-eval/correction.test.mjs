import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMemorySource, normalizeMemory, correctFact, retractFact } from '../../core/memory.js';
import { buildMessages } from '../../core/prompt.js';
import { buildGroupMessages } from '../../core/group.js';
import { estimateTokens } from '../../core/util.js';

const char = { id: 'c_regression', name: '测试角色', persona: {} };
const oldMessage = { id: 'm_old', charId: char.id, role: 'user', at: 100,
  content: '读书小组的集合地点是青栎书屋。' };
const question = { id: 'm_now', charId: char.id, role: 'user', at: 200, content: '读书小组现在在哪里集合？' };
const settings = { context: { timeAware: false, affinity: false, budgetTokens: 8000 } };
function fixture(kind = 'private', operation = 'correct') {
  const message = kind === 'group' ? { ...oldMessage, groupId: 'g_source', charId: 'g_source', audienceIds: [char.id] } : oldMessage;
  const original = normalizeMemory({ factRecords: [{ id: 'fact_old', text: oldMessage.content, status: 'active', origin: 'model',
    sources: [makeMemorySource(message, char.id)], sourceStatus: 'verified' }] });
  const memory = operation === 'correct' ? correctFact(original, 'fact_old', '读书小组的集合地点是蓝鲸书屋。') : retractFact(original, 'fact_old');
  const experience = { id: message.id, ownerId: char.id, source: kind === 'group' ? 'group:g_source' : `private:${char.id}`,
    at: message.at, content: message.content, speakerName: '用户' };
  return { message, memory, original, experience };
}
const text = (built) => built.messages.map((m) => m.content).join('\n');

for (const operation of ['correct', 'retract']) for (const kind of ['private', 'group']) {
  test(`${operation}/${kind}: 私聊与群聊均不通过近期经历复活旧来源，输入对象不变`, () => {
    const f = fixture(kind, operation), before = JSON.stringify(f);
    const opts = { settings, runtime: {}, memory: f.memory, recentExperiences: [f.experience] };
    const a = buildMessages(char, [question], opts);
    const b = buildGroupMessages({ ...opts, speaker: char, members: [char], group: { id: 'g_dest' },
      history: [{ ...question, groupId: 'g_dest', audienceIds: [char.id] }], budgetTokens: 8000 });
    for (const built of [a, b]) {
      assert.ok(!text(built).includes('青栎书屋'));
      if (operation === 'correct') assert.ok(text(built).includes('蓝鲸书屋'));
    }
    assert.equal(JSON.stringify(f), before);
  });
}
test('当前私聊历史中的已更正来源同样停用，保留当前提问', () => {
  const f = fixture();
  const built = buildMessages(char, [f.message, question], { settings, runtime: {}, memory: f.memory });
  assert.ok(!text(built).includes('青栎书屋'));
  assert.ok(text(built).includes(question.content));
});
test('当前群聊历史中的已更正来源也不再注入或触发世界书', () => {
  const f = fixture('group');
  const built = buildGroupMessages({ speaker: { ...char, lorebook: [{ keys: ['青栎书屋'], content: 'INVALID_LORE' }] }, members: [char],
    group: { id: 'g_source' }, memory: f.memory, settings, runtime: {},
    history: [f.message, { ...question, groupId: 'g_source', audienceIds: [char.id] }] });
  assert.ok(!text(built).includes('青栎书屋'));
  assert.ok(!text(built).includes('INVALID_LORE'));
});
test('小预算的群聊精简经历也遵守相同屏蔽，保留无关经历与总预算', () => {
  const f = fixture();
  const safe = { ...f.experience, id: 'm_safe', at: 90, content: 'SAFE_RECENT：带上笔记本。' };
  for (const budget of [400, 1000, 2000, 4000, 8000]) {
    const built = buildGroupMessages({ speaker: { ...char, persona: { personality: '长人设'.repeat(2000) } }, members: [char],
      group: { id: 'g_dest' }, memory: f.memory, settings, runtime: {}, recentExperiences: [safe, f.experience],
      history: [{ ...question, audienceIds: [char.id] }], budgetTokens: budget });
    assert.ok(!text(built).includes('青栎书屋'));
    assert.ok(built.messages.reduce((n, m) => n + estimateTokens(m.content), 0) <= budget);
    if (budget >= 1000) assert.ok(text(built).includes('SAFE_RECENT'));
  }
});
test('引用旧消息的快照不会绕过屏蔽，但保留这条消息的新提问', () => {
  const f = fixture();
  const quoted = { ...question, quoted: { id: oldMessage.id, role: 'user', content: oldMessage.content } };
  const snapshot = JSON.stringify(quoted);
  const built = buildMessages(char, [quoted], { settings, runtime: {}, memory: f.memory });
  assert.ok(!text(built).includes('青栎书屋'));
  assert.ok(text(built).includes(question.content));
  assert.equal(JSON.stringify(quoted), snapshot);
});
test('改过内容的原消息、其他会话的同ID、未更正来源均不误伤', () => {
  const f = fixture();
  const changed = { ...f.message, content: 'NEW_SOURCE：现在改为云杉工坊。' };
  assert.ok(text(buildMessages(char, [changed, question], { settings, runtime: {}, memory: f.memory })).includes('NEW_SOURCE'));
  const other = { ...f.experience, source: 'group:g_other' };
  assert.ok(text(buildMessages(char, [question], { settings, runtime: {}, memory: f.memory, recentExperiences: [other] })).includes('青栎书屋'));
  assert.ok(text(buildMessages(char, [f.message, question], { settings, runtime: {}, memory: f.original })).includes('青栎书屋'));
});
