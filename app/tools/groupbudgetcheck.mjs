#!/usr/bin/env node
/** 群聊输入预算回归：纯函数、合成记录，不读写数据库、不启动服务或请求模型。 */
import assert from 'node:assert/strict';
import { CHARACTER_TEMPLATES, templateToCharacter } from '../data/templates.js';
import { buildGroupMessages, GroupRound } from '../core/group.js';
import { estimateTokens } from '../core/util.js';

const at = Date.UTC(2026, 9, 22, 12);
const marker = 'RECENT_RESERVED_图书馆约定';
const settings = { user: { name: '测试用户' }, context: { timeAware: false, affinity: false } };
const recent = [{ ownerId: 'c_test', id: 'p_recent', source: 'private:c_test', sourceName: '私聊',
  speakerName: '测试用户', at, content: `${marker}：明天九点在图书馆一起复习。` }];
const other = { ...templateToCharacter(CHARACTER_TEMPLATES[0]), id: 'c_other', name: '测试同伴' };
const group = { id: 'g_test', name: '测试群', members: ['c_test', 'c_other'], memberSince: {} };
const baseSpeaker = { id: 'c_test', name: '测试角色', persona: {} };
let passed = 0;
const results = [];

function build(overrides = {}) {
  return buildGroupMessages({ speaker: baseSpeaker, members: [baseSpeaker, other], group,
    settings, memory: { summary: '', facts: [] }, runtime: {}, recentExperiences: recent,
    history: [{ role: 'user', content: 'CURRENT_TURN_继续聊计划。', audienceIds: ['c_test'], at }],
    budgetTokens: 8000, ...overrides });
}
function verify(result, budget, label) {
  const actual = result.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  assert.equal(result.meta.total, actual, `${label}: meta与实际消息估算不一致`);
  assert.equal(result.meta.breakdown.reduce((n, b) => n + b.tokens, 0), actual, `${label}: 分项记账不一致`);
  assert.ok(actual <= budget, `${label}: ${actual} > ${budget}`);
  assert.ok(result.meta.breakdown.every((b) => b.tokens >= 0), `${label}: 出现负分项`);
  for (const m of result.messages) assert.ok(m.content.isWellFormed(), `${label}: Unicode被裁坏`);
  return result.messages.map((m) => m.content).join('\n');
}
function check(name, run) {
  run(); passed++;
  console.log(`✓ ${name}`);
}

for (const budget of [1000, 2000, 4000, 8000]) {
  for (const historyCount of [1, 40]) {
    for (const template of CHARACTER_TEMPLATES) {
      const speaker = { ...templateToCharacter(template), id: 'c_test' };
      const history = Array.from({ length: historyCount }, (_, i) => ({ id: `g_m${i}`,
        role: i % 2 ? 'assistant' : 'user', speakerId: i % 2 ? 'c_other' : 'user',
        speakerName: i % 2 ? '测试同伴' : '测试用户',
        content: `${i === historyCount - 1 ? 'CURRENT_TURN_' : ''}${historyCount === 1 ? '我们来聊聊明天的计划。' : `第${i + 1}条合成测试消息：我们计划明天上午九点在图书馆一起复习，下午整理学习笔记，并在小组讨论中轮流说明各自的解题过程。`}`,
        audienceIds: ['c_test', 'c_other'], at: at - 1000 * (historyCount - i), status: 'done',
      }));
      const result = build({ speaker, members: [speaker, other], history, budgetTokens: budget });
      const label = `${template.id}/${historyCount}/${budget}`;
      const text = verify(result, budget, label);
      assert.ok(text.includes(marker), `${label}: 近期经历被挤出`);
      assert.ok(text.includes('CURRENT_TURN_'), `${label}: 最新发言被挤出`);
      assert.ok(text.includes('绝不能替他们说话'), `${label}: 必要群聊规则被挤出`);
      assert.ok(!result.meta.insufficientBudget, `${label}: 常规预算不应完全拒绝装配`);
      assert.ok(result.meta.breakdown.find((b) => b.kind === 'recent').tokens <= Math.min(1200, Math.floor(budget * 0.2)) + 1,
        `${label}: 近期经历超过20%/1200上限（额外1个为分隔符取整）`);
      assert.match(result.messages.at(-1).content, /现在轮到你（.+）在群里发言/);
      if (budget === 8000) assert.ok(text.includes('【群聊铁律（必须遵守）】'), `${label}: 默认预算丢失完整规则`);
      results.push({ template: template.id, budget, historyCount, total: result.meta.total,
        recentTokens: result.meta.breakdown.find((b) => b.kind === 'recent').tokens,
        kept: result.meta.kept, degraded: result.meta.degraded });
      passed++;
    }
  }
}

check('很长的单条消息、角色设定、示例与世界书不会突破总预算', () => {
  const speaker = { ...baseSpeaker, persona: { personality: '人设资料'.repeat(10000) },
    examples: [{ user: '示例问题'.repeat(1000), ai: '示例回答'.repeat(1000) }],
    lorebook: [{ keys: ['CURRENT_TURN'], content: '世界观资料'.repeat(3000), enabled: true }] };
  for (const budget of [1000, 2000, 4000, 8000]) {
    const r = build({ speaker, budgetTokens: budget,
      history: [{ role: 'user', content: 'CURRENT_TURN_' + '长消息😀'.repeat(10000), audienceIds: ['c_test'], at }] });
    const text = verify(r, budget, '超长单条');
    assert.ok(text.includes(marker)); assert.ok(text.includes('CURRENT_TURN_'));
    assert.ok(r.meta.degraded); assert.ok(r.meta.degradationReasons.length);
  }
});

check('未听到的历史、外人经历与其他角色私密规则不进入提示词或触发世界书', () => {
  const speaker = { ...baseSpeaker, lorebook: [{ keys: ['UNHEARD_KEY'], content: 'LORE_LEAK', enabled: true }] };
  for (const budget of [1000, 4000, 8000]) {
    const r = build({ speaker, budgetTokens: budget,
      history: [
        { role: 'user', content: 'CURRENT_TURN_继续讨论。', audienceIds: ['c_test'], at },
        { role: 'user', content: 'UNHEARD_KEY', audienceIds: ['c_other'], at: at + 1 },
      ],
      recentExperiences: [...recent, { ...recent[0], ownerId: 'c_other', content: 'FOREIGN_RECENT' }, { ...recent[0], at: 'bad', content: 'INVALID_DATE' }],
      privateNotes: { c_test: 'OWN_PRIVATE_RULE_只知道自己的身份。', c_other: 'FOREIGN_PRIVATE_RULE' },
    });
    const text = verify(r, budget, '听众边界');
    for (const secret of ['UNHEARD_KEY', 'LORE_LEAK', 'FOREIGN_RECENT', 'FOREIGN_PRIVATE_RULE', 'INVALID_DATE']) assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes('OWN_PRIVATE_RULE')); assert.ok(text.includes(marker));
  }
});

check('默认预算保留本人完整游戏规则并继续隔离局内记录', () => {
  const history = [
    { role: 'user', content: 'ORDINARY_CHAT', audienceIds: ['c_test'], at },
    { role: 'assistant', speakerId: 'c_other', content: 'IN_GAME_ONLY', game: 'werewolf', audienceIds: ['c_test'], at: at + 1 },
    { role: 'system', content: 'GAME_ENDED_ANCHOR', game: 'werewolf', keepGame: true, audienceIds: ['c_test'], at: at + 2 },
  ];
  const note = 'OWN_ROLE_你只知道自己的身份和法官提供的私密消息。'.repeat(15);
  for (const includeGame of [false, true]) {
    const r = build({ history, includeGame, privateNotes: { c_test: note, c_other: 'OTHER_ROLE_SECRET' } });
    const text = verify(r, 8000, '游戏边界');
    assert.ok(text.includes(note)); assert.ok(text.includes('GAME_ENDED_ANCHOR'));
    assert.equal(text.includes('IN_GAME_ONLY'), includeGame);
    assert.ok(!text.includes('OTHER_ROLE_SECRET'));
  }
});

check('不够容纳必要私密规则时明确降级，绝不发送半条游戏身份', () => {
  const r = build({ budgetTokens: 1000, privateNotes: { c_test: 'PRIVATE_ROLE_MUST_BE_WHOLE_' + '必要规则'.repeat(1000) } });
  const text = verify(r, 1000, '私密规则不足');
  assert.ok(r.meta.insufficientBudget && r.meta.degraded);
  assert.ok(text.includes('预算不足')); assert.ok(!text.includes('PRIVATE_ROLE_MUST_BE_WHOLE'));
  assert.equal(r.meta.kept, 0);
});

check('小预算精简经历仍保留来源、时间、说话人和可用内容，无法装入时如实报告', () => {
  const r = build({ budgetTokens: 1000, recentExperiences: [{ ...recent[0], content: marker + '较长的原始发言'.repeat(100) }] });
  const text = verify(r, 1000, '精简经历');
  assert.ok(text.includes(marker)); assert.ok(text.includes('近期经历·精简'));
  for (const provenance of ['"时间"', '"场景":"私聊"', '"说话人":"测试用户"']) assert.ok(text.includes(provenance));
  assert.ok(r.meta.degradationReasons.includes('近期经历改用精简片段'));
  const tiny = build({ budgetTokens: 400 });
  verify(tiny, 400, '经历预算不足');
  assert.ok(tiny.meta.degraded);
  assert.ok(tiny.meta.degradationReasons.some((s) => s.includes('近期经历预算不足')));
});

check('记忆相关性查询只取已听到的最后用户消息，不取较新的未听内容', () => {
  const facts = ['HEARD_FACT_图书馆借书约定', 'UNHEARD_QUERY_FACT_火星任务',
    ...Array.from({ length: 40 }, (_, i) => `普通记录${i}`)];
  const r = build({ memory: { facts }, history: [
    { role: 'user', content: '图书馆', audienceIds: ['c_test'], at },
    { role: 'user', content: '火星', audienceIds: ['c_other'], at: at + 1 },
  ] });
  const text = verify(r, 8000, '记忆查询听众');
  assert.ok(text.includes('HEARD_FACT')); assert.ok(!text.includes('UNHEARD_QUERY_FACT'));
});

check('零、负值、极小与小数预算准确记账，并明确报告必要上下文不足', () => {
  for (const requested of [-1, 0, 1, 10, 100, 1000.9]) {
    const budget = Math.max(0, Math.floor(requested));
    const r = build({ budgetTokens: requested });
    verify(r, budget, '预算边界'); assert.equal(r.meta.budget, budget);
    if (budget < 100) {
      assert.ok(r.meta.insufficientBudget); assert.ok(r.meta.degraded);
      assert.ok(r.meta.degradationReasons.some((s) => s.includes('预算不足')));
    }
  }
});

check('超长名单、话题、用户名仍服从预算，不冒充完整上下文', () => {
  for (const budget of [1000, 2000]) {
    const r = build({ budgetTokens: budget, userName: '超长用户名'.repeat(2000),
      group: { ...group, topic: '超长话题'.repeat(1000) } });
    verify(r, budget, '长名称'); assert.ok(r.meta.insufficientBudget);
  }
});

check('空群保留起头指令；输入对象不会被装配函数修改', () => {
  const opts = { speaker: baseSpeaker, members: [baseSpeaker, other], group,
    settings, history: [], recentExperiences: recent, budgetTokens: 1000 };
  const before = JSON.stringify(opts);
  const r = buildGroupMessages(opts);
  verify(r, 1000, '空群'); assert.ok(r.messages.at(-1).content.includes('起个头'));
  assert.equal(r.meta.kept, 0); assert.equal(JSON.stringify(opts), before);
});

// Node没有浏览器数据库：记忆读取按现有兜底返回空；拦截所有网络，证实拒绝发生在模型调用前。
assert.equal(typeof indexedDB, 'undefined', '该检查必须在无IndexedDB的隔离Node环境运行');
const originalFetch = globalThis.fetch;
let networkCalls = 0, turnStarts = 0, writes = 0;
const errors = [];
try {
  globalThis.fetch = async () => { networkCalls++; throw new Error('测试禁止任何网络请求'); };
  const round = new GroupRound({ group: { ...group, everyoneSpeaks: true, autoDelayMs: 0 },
    members: [baseSpeaker, other], force: true, mode: 'round',
    history: [{ role: 'user', content: '继续聊。', audienceIds: ['c_test', 'c_other'], at }],
    settings: { ...settings, provider: 'ollama', model: 'synthetic-model', context: { ...settings.context, budgetTokens: 1000 } },
    privateNotes: { c_test: '必要的完整私密规则'.repeat(1000) },
    handlers: { onTurnStart: () => turnStarts++, onTurnError: (err) => errors.push(err) },
  });
  round.persist = async () => { writes++; throw new Error('测试禁止持久化'); };
  const result = await round.run();
  assert.equal(result.reason, 'context-budget'); assert.equal(result.turns, 0);
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'context-budget'); assert.equal(errors[0].retryable, false);
  assert.equal(networkCalls, 0); assert.equal(turnStarts, 0); assert.equal(writes, 0);
  assert.ok(round.stopped); assert.equal(round.controller, null);
  passed++;
  console.log('✓ 必要规则预算不足在模型调用前停止整轮、只报一次错误、不自动重试或写消息');
} finally {
  globalThis.fetch = originalFetch;
}

const cases = [1000, 2000, 4000, 8000].flatMap((budget) => [1, 40].map((historyCount) => {
  const rows = results.filter((r) => r.budget === budget && r.historyCount === historyCount);
  return { budget, historyCount, templates: rows.length,
    overBudget: rows.filter((r) => r.total > budget).length,
    missingRecent: rows.filter((r) => r.recentTokens === 0).length,
    maxEstimatedTokens: Math.max(...rows.map((r) => r.total)),
    degraded: rows.filter((r) => r.degraded).length };
}));
console.log(JSON.stringify({ passed, matrixCases: results.length, templateCount: CHARACTER_TEMPLATES.length,
  protocol: 'Pure prompt matrix and isolated Node engine guard; synthetic data only; no database/model access; app estimateTokens, not provider tokenizer.', cases }, null, 2));
