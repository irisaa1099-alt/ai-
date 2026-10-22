#!/usr/bin/env node
/**
 * 核心逻辑自测（零依赖，node tools/selftest.mjs）
 *
 * 覆盖纯逻辑模块：工具函数、断句器、模板库、供应商与定价表、提示词装配、角色卡归一化。
 * 这些模块都不依赖 DOM，可以在 Node 里直接跑。
 */

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}\n      ${err.message}`);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const ROOT = new URL('../', import.meta.url);
const load = (rel) => import(new URL(rel, ROOT).href);

console.log('\n=== 1. core/util.js ===');
{
  const u = await load('core/util.js');
  await test('createId 唯一且带前缀', () => {
    const a = u.createId('c');
    const b = u.createId('c');
    assert.ok(a.startsWith('c_'));
    assert.notEqual(a, b);
  });
  await test('escapeHtml 转义危险字符', () => {
    assert.equal(u.escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  });
  await test('estimateTokens：中文≈1字1token，英文更省', () => {
    const zh = u.estimateTokens('你好世界');
    const en = u.estimateTokens('hello world');
    assert.equal(zh, 4);
    assert.ok(en > 0 && en < 4);
  });
  await test('parse 时间格式化', () => {
    const ts = new Date('2024-03-05T14:05:00').getTime();
    assert.equal(u.fmtDate(ts), '2024-03-05 14:05');
    assert.equal(u.fmtTime(ts), '14:05');
  });
  await test('timeContext 结构完整', () => {
    const t = u.timeContext();
    for (const k of ['now', 'hour', 'dateStr', 'weekStr', 'partOfDay', 'isWeekend']) {
      assert.ok(k in t, `缺少 ${k}`);
    }
  });
  await test('clamp / num 安全处理脏输入', () => {
    assert.equal(u.clamp('abc', 0, 10), 0);
    assert.equal(u.clamp(99, 0, 10), 10);
    assert.equal(u.num('3.5', 0), 3.5);
    assert.equal(u.num(undefined, 7), 7);
  });
  await test('stripMarkdown 去掉标记与代码块', () => {
    const s = u.stripMarkdown('# 标题\n**粗体** 和 `代码`\n```js\nlet a=1\n```\nhttps://x.com');
    assert.ok(!s.includes('#'));
    assert.ok(!s.includes('**'));
    assert.ok(!s.includes('```'));
    assert.ok(s.includes('粗体'));
  });
  await test('firstChar 不会把 emoji 切坏（变体选择符 / ZWJ / 肤色）', () => {
    assert.equal(u.firstChar('🕳️'), '🕳️', '变体选择符被切掉了');
    assert.equal(u.firstChar('👨‍👩‍👧'), '👨‍👩‍👧', 'ZWJ 序列被切断了');
    assert.equal(u.firstChar('👍🏽'), '👍🏽', '肤色修饰符被切掉了');
    assert.equal(u.firstChar('林晚'), '林');
    assert.equal(u.firstChar(''), '?');
    assert.equal(u.takeGraphemes('🕳️🌙', 2), '🕳️🌙');
  });

  await test('truncate / firstChar', () => {
    assert.equal(u.truncate('一二三四五', 3), '一二三…');
    assert.equal(u.firstChar('林晚'), '林');
    assert.equal(u.firstChar(''), '?');
  });
  await test('debounce 只执行最后一次', async () => {
    let n = 0;
    const d = u.debounce(() => n++, 20);
    d(); d(); d();
    await u.sleep(50);
    assert.equal(n, 1);
  });
  await test('hashCode 返回 8 位十六进制', () => {
    const h = u.hashCode('你好-a-1.0');
    assert.match(h, /^[0-9a-f]{8}$/);
  });
}

console.log('\n=== 2. voice/splitter.js ===');
{
  const { createSplitter } = await load('voice/splitter.js');
  await test('把 60 字文本逐字喂入 → 得到多句且首句较短', () => {
    const sp = createSplitter();
    const text = '今天天气不错，要不要一起出去走走？我请客。顺便把你上次说的那本书还给你。';
    const out = [];
    for (const ch of text) out.push(...sp.push(ch));
    out.push(...sp.flush());
    assert.ok(out.length >= 2, `句数偏少：${JSON.stringify(out)}`);
    assert.ok(out[0].length <= 30, `首句过长：${out[0]}`);
    assert.equal(out.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  });
  await test('flush 收尾无残留', () => {
    const sp = createSplitter();
    sp.push('没有标点的一段话');
    const tail = sp.flush();
    assert.deepEqual(tail, ['没有标点的一段话']);
    assert.deepEqual(sp.flush(), []);
  });
  await test('reset 清空状态', () => {
    const sp = createSplitter();
    sp.push('第一句。第二句还没完');
    sp.reset();
    assert.deepEqual(sp.flush(), []);
  });
  await test('空 push 返回空数组', () => {
    const sp = createSplitter();
    assert.deepEqual(sp.push(''), []);
  });
}

console.log('\n=== 3. data/models.js ===');
{
  const m = await load('data/models.js');
  await test('供应商元数据完整', () => {
    const need = ['id', 'label', 'kind', 'baseUrl', 'models', 'needKey'];
    for (const [id, p] of Object.entries(m.PROVIDERS_META)) {
      for (const k of need) assert.ok(k in p, `${id} 缺少 ${k}`);
      assert.ok(['openai', 'anthropic', 'gemini', 'ollama'].includes(p.kind), `${id} kind 非法：${p.kind}`);
      assert.ok(Array.isArray(p.models), `${id} models 不是数组`);
    }
    for (const id of ['deepseek', 'openai', 'anthropic', 'gemini', 'ollama']) {
      assert.ok(m.PROVIDERS_META[id], `缺少供应商 ${id}`);
    }
  });
  await test('getProvider 未知返回 custom 副本', () => {
    const p = m.getProvider('不存在的供应商');
    assert.ok(p && p.id);
  });
  await test('预设与参数提示齐全', () => {
    assert.ok(m.DEFAULT_PRESETS.length >= 5);
    assert.ok(Object.keys(m.PARAM_HINTS).length >= 4);
  });
}

console.log('\n=== 4. core/store.js（纯函数部分）===');
{
  const s = await load('core/store.js');
  await test('normalizeCharacter 补齐全部字段（脏输入不崩）', () => {
    const c = s.normalizeCharacter({ name: '林晚' });
    const keys = [
      'id', 'name', 'avatar', 'emoji', 'color', 'gender', 'age', 'job', 'tagline', 'tags', 'group',
      'pinned', 'muted', 'persona', 'systemPrompt', 'examples', 'authorNote', 'affinity',
      'greeting', 'voice', 'model', 'createdAt', 'updatedAt', 'version', 'history',
    ];
    for (const k of keys) assert.ok(k in c, `缺少字段 ${k}`);
    for (const k of ['personality', 'style', 'relationship', 'addressUser', 'world', 'place', 'speech', 'taboo']) {
      assert.ok(k in c.persona, `persona 缺少 ${k}`);
    }
    for (const k of ['provider', 'voiceId', 'rate', 'pitch', 'autoplay', 'cache']) {
      assert.ok(k in c.voice, `voice 缺少 ${k}`);
    }
  });
  await test('normalizeCharacter 处理 null / 数字 / 数组等脏输入', () => {
    for (const bad of [null, undefined, 0, 'abc', [], { name: 123 }, { tags: 'not-array', greeting: null }]) {
      const c = s.normalizeCharacter(bad);
      assert.ok(typeof c.name === 'string' && c.name.length > 0);
      assert.ok(Array.isArray(c.tags));
      assert.ok(Array.isArray(c.greeting) && c.greeting.length > 0);
      assert.ok(typeof c.affinity === 'number');
    }
  });
  await test('toSillyTavern 输出 V2 结构', () => {
    const st = s.toSillyTavern({ name: '林晚', greeting: ['嗨', '又见面了'], examples: [{ user: 'hi', ai: '嗯' }] });
    assert.equal(st.spec, 'chara_card_v2');
    assert.equal(st.data.name, '林晚');
    assert.equal(st.data.first_mes, '嗨');
    assert.deepEqual(st.data.alternate_greetings, ['又见面了']);
  });
  await test('设置默认值完整且深合并不丢字段', () => {
    const d = s.DEFAULT_SETTINGS;
    // 注：budget（月度预算/费用）已按需求从设置与界面移除，不再作为默认字段
    for (const k of ['theme', 'provider', 'model', 'params', 'context', 'voice', 'proactive']) {
      assert.ok(k in d, `默认设置缺少 ${k}`);
    }
    for (const k of ['maxMessages', 'budgetTokens', 'summary', 'timeAware', 'affinity']) {
      assert.ok(k in d.context, `context 缺少 ${k}`);
    }
    // 全局用户档案：昵称/头像/自述/性别（设置 → 我的资料）
    for (const k of ['name', 'avatar', 'persona', 'gender']) {
      assert.ok(k in d.user, `默认设置 user 缺少 ${k}`);
    }
    assert.equal(d.user.gender, '', '性别默认应为空串（= 不设定）');
    assert.ok(!('budget' in d), '默认设置里不应再出现 budget（费用/预算相关入口已删除）');
  });
}

console.log('\n=== 5. core/prompt.js ===');
{
  const p = await load('core/prompt.js');
  const char = {
    id: 'c1', name: '林晚', emoji: '🌙', gender: '女', age: '24', job: '插画师',
    tagline: '安静的插画师', tags: ['温柔'],
    persona: {
      personality: '温柔、略带疏离', mbti: 'INFJ', style: '口语', catchphrase: '……嗯。',
      relationship: '朋友', addressUser: '你', world: '现代都市', place: '画室', speech: '句子短',
      taboo: '不谈政治',
    },
    examples: [{ user: '在吗', ai: '……嗯，在。' }],
    affinity: 60, greeting: ['……你来了。'], systemPrompt: '', authorNote: '', history: [],
  };
  const settings = {
    user: { name: '小陈', persona: '程序员' },
    context: { maxMessages: 10, budgetTokens: 4000, timeAware: true, affinity: true },
  };
  const history = [];
  for (let i = 0; i < 24; i++) {
    history.push({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 条消息内容`, at: Date.now() + i });
  }

  await test('buildSystemPrompt 含身份/性格/称呼/时间/准则', () => {
    const sp = p.buildSystemPrompt(char, {
      settings,
      memory: { summary: '你们上周聊过画画', facts: ['用户养了一只猫叫团子'] },
      runtime: { affinity: 60, mood: 'happy', lastChatAt: Date.now() - 86400000 },
    });
    assert.ok(sp.includes('林晚'));
    assert.ok(sp.includes('INFJ'));
    assert.ok(sp.includes('小陈') || sp.includes('你'));
    assert.ok(sp.includes('时间感知'));
    assert.ok(sp.includes('团子') || sp.includes('猫'));
    assert.ok(sp.includes('不要替对方说话'));
  });

  await test('buildSystemPrompt：用户性别设了才写进「关于对方」', () => {
    const withGender = p.buildSystemPrompt(char, {
      settings: { ...settings, user: { ...settings.user, gender: '女' } },
      memory: {},
      runtime: {},
    });
    assert.ok(withGender.includes('对方的性别是「女」'), `性别没有写进提示词：${withGender.slice(0, 400)}`);
    // 没设过（字段缺失）或选了「不设定」（空串）都不该出现性别行
    const missing = p.buildSystemPrompt(char, { settings, memory: {}, runtime: {} });
    assert.ok(!missing.includes('性别'), '缺字段时不该写进性别');
    const blank = p.buildSystemPrompt(char, {
      settings: { ...settings, user: { ...settings.user, gender: '' } },
      memory: {},
      runtime: {},
    });
    assert.ok(!blank.includes('性别'), '空串性别不该写进提示词');
  });

  await test('buildMessages：预算裁剪生效且 meta 完整', () => {
    const tight = { ...settings, context: { ...settings.context, budgetTokens: 400 } };
    const { messages, meta } = p.buildMessages(char, history, { settings: tight, memory: { summary: '', facts: [] }, runtime: { affinity: 60 } });
    assert.equal(messages[0].role, 'system');
    assert.ok(messages.length >= 2);
    assert.ok(meta.kept <= 10, `kept=${meta.kept} 应 <= maxMessages`);
    assert.ok(meta.dropped > 0, `预算收紧后应当有被裁掉的消息（kept=${meta.kept}, total=${meta.total}）`);
    assert.ok(meta.total > 0 && meta.budget === 400);
    assert.ok(Array.isArray(meta.breakdown) && meta.breakdown.length >= 4);
  });

  await test('buildMessages：宽预算保留全部 maxMessages 条', () => {
    const { meta } = p.buildMessages(char, history, { settings, memory: { summary: '', facts: [] }, runtime: {} });
    assert.equal(meta.kept, 10, `应保留最近 10 条，实际 ${meta.kept}`);
    assert.equal(meta.dropped, 0, `预算充足时不应再裁，实际 dropped=${meta.dropped}`);
  });

  await test('buildMessages：未知输入不崩（空历史、缺角色）', () => {
    const r1 = p.buildMessages(null, [], {});
    assert.ok(Array.isArray(r1.messages) && r1.messages.length >= 1);
    const r2 = p.buildMessages(char, null, { settings });
    assert.ok(Array.isArray(r2.messages));
  });

  await test('matchLore 只返回命中的启用条目', () => {
    const c = {
      lorebook: [
        { keys: ['龙'], content: '龙族设定', enabled: true },
        { keys: ['禁'], content: '禁用条目', enabled: false },
        { keys: ['精灵'], content: '精灵设定', enabled: true },
      ],
    };
    assert.equal(p.matchLore(c, '这里有龙和精灵').length, 2);
    assert.equal(p.matchLore(c, '什么都没提到').length, 0);
    assert.deepEqual(p.matchLore(null, 'x'), []);
    assert.deepEqual(p.matchLore({ lorebook: [] }, '随便'), []);
  });

  await test('buildMessages：分项之和等于 total（记忆不被重复计算）', () => {
    // 回归守：记忆摘要是装进 system 提示词的，已经算在 sysTokens 里；
    // 曾经的 bug 是明细里又把记忆单列一条，导致分项加起来比 total 多出"记忆"那一份，
    // 用户在「设置 → 上下文预算」里看到的就是"分项数字对不上"。
    const mem = { summary: '你和用户一起在老巷子长大，巷口有棵歪脖子槐树。', facts: ['用户的生日是 3 月 5 日', '用户养了一只叫豆豆的猫'] };
    const r = p.buildMessages(char, history, { settings, memory: mem, runtime: { affinity: 60 } });
    const sum = r.meta.breakdown.reduce((n, b) => n + b.tokens, 0);
    assert.equal(sum, r.meta.total, `分项之和 ${sum} != total ${r.meta.total}（分项：${r.meta.breakdown.map((b) => `${b.label}=${b.tokens}`).join(', ')}）`);

    const memoryPart = r.meta.breakdown.find((b) => b.kind === 'memory');
    const sysPart = r.meta.breakdown.find((b) => b.kind === 'system');
    assert.ok(memoryPart.tokens > 0, '带了记忆就必须有非零的"记忆摘要"项');
    assert.ok(sysPart.tokens > 0, '"角色人设与准则"不该被减成 0 或负数');

    // 记忆确实在 system 里（否则这条用例测不到东西）
    assert.ok(r.messages[0].content.includes('歪脖子槐树'), 'system 里应当包含记忆摘要');
    // 人设项 + 记忆项 = 完整 system 的 token 数（记忆归到"记忆摘要"后不再重复）
    const fullSys = sysPart.tokens + memoryPart.tokens;
    assert.ok(fullSys >= memoryPart.tokens, '人设项至少要能容纳 system 本体');
    // 没有记忆时，人设项应当就是完整的 system token 数
    const noMem = p.buildMessages(char, history, { settings, memory: { summary: '', facts: [] }, runtime: {} });
    const noMemSum = noMem.meta.breakdown.reduce((n, b) => n + b.tokens, 0);
    assert.equal(noMemSum, noMem.meta.total, `无记忆时分项之和 ${noMemSum} != total ${noMem.meta.total}`);
    assert.equal(noMem.meta.breakdown.find((b) => b.kind === 'memory').tokens, 0, '没有记忆时该项应为 0');
  });

  await test('buildMessages：世界书命中才注入，未命中不占 token', () => {
    const loreChar = {
      id: 'lc1', name: '测试', persona: {}, examples: [], greeting: ['一'], affinity: 30,
      lorebook: [
        { keys: ['老巷子', '小时候'], content: '老巷子是两人一起长大的地方，巷口有棵歪脖子槐树。', enabled: true },
        { keys: ['禁用词'], content: '这条被关掉了，不该出现。', enabled: false },
      ],
    };
    const base = { settings: { context: {} }, memory: { summary: '', facts: [] }, runtime: {} };
    const hit = p.buildMessages(loreChar, [{ id: '1', role: 'user', content: '还记得老巷子吗？', at: Date.now(), status: 'done' }], base);
    assert.equal(hit.meta.loreHits.length, 1, '应当命中 1 条世界书');
    assert.ok(hit.messages[0].content.includes('歪脖子槐树'), 'system 里没有注入世界书内容');
    assert.ok(hit.meta.breakdown.some((b) => b.kind === 'lore' && b.tokens > 0), 'breakdown 缺少"世界书触发"项');

    const miss = p.buildMessages(loreChar, [{ id: '2', role: 'user', content: '今天天气不错', at: Date.now(), status: 'done' }], base);
    assert.equal(miss.meta.loreHits.length, 0, '无关话题不该命中');
    assert.equal(miss.meta.breakdown.find((b) => b.kind === 'lore').tokens, 0, '未命中不该占用 token');
    assert.ok(!miss.messages[0].content.includes('世界观补充'), '未命中不该注入');

    const off = p.buildMessages(loreChar, [{ id: '3', role: 'user', content: '禁用词出现了', at: Date.now(), status: 'done' }], base);
    assert.equal(off.meta.loreHits.length, 0, '被禁用的条目不该命中');
  });
}

console.log('\n=== 5.5 合并导入的消息 id 重映射（静态检查）===');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../core/store.js', import.meta.url), 'utf8');
  await test('importAll 在合并导入时重映射消息 id', () => {
    assert.ok(/const remap = merge && validIds\.has\(charId\)/.test(src), '缺少消息 id 重映射逻辑');
    assert.ok(/id: remap \? createId\('m'\)/.test(src), '重映射未使用 createId("m")');
  });
  await test('设置恢复只在覆盖导入时发生（条件不再含恒真表达式）', () => {
    assert.ok(!/Array\.isArray\(pack\.settings\) === false/.test(src), '仍存在可疑的恒真条件');
    assert.ok(/if \(!merge && pack\.settings && typeof pack\.settings === 'object'/.test(src), '设置恢复条件未修正');
  });
  await test('wipeAll 报告磁盘清空结果（不再无条件假成功）', () => {
    assert.ok(/return \{\s*ok: !diskFailed/.test(src), 'wipeAll 没有返回 { ok, fileOk, fileError }');
    assert.ok(/fileState\.known === true/.test(src) && /wiped !== true/.test(src), '没有保护曾启用文件服务但当前离线的数据');
  });
}

console.log('\n=== 5.5b 写盘：只改设置不得清空运行时状态（静态检查）===');
{
  const fs = await import('node:fs');
  // 静态检查必须先去掉注释：解释"以前的错误写法"的注释里会原样出现那些坏代码片段
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const src = stripComments(fs.readFileSync(new URL('../core/filestore.js', import.meta.url), 'utf8'));
  await test('待写队列不会把 null 当成"有待写 runtime"', () => {
    // 曾经的 bug：`(statePayload && statePayload.runtime)` 在 statePayload 为 null 时得到 null，
    // 而 sanitizeRuntime(null) === {} → 只改设置也会送 `runtime:{}`，把好感度覆盖成空。
    assert.ok(!/\(statePayload && statePayload\.runtime\)/.test(src), '仍存在会产出 null 的合并写法');
    assert.ok(/const hasRuntimePayload = \(v\) => v !== undefined && v !== null;/.test(src), '缺少 hasRuntimePayload 判定');
    assert.ok(/const prev = statePayload \|\| \{\};/.test(src), '合并前没有把 null 归一成 {}');
  });
  await test('同步补丁只修改明确变化的字段，不清掉其他角色', async () => {
    const { diffChanges, applyChanges } = await load('core/sync.js');
    const before = { user: { name: '我' }, theme: 'dark' };
    const changes = diffChanges(before, { ...before, theme: 'light' });
    const remote = { user: { name: '另一端的新名字' }, theme: 'dark' };
    assert.deepEqual(applyChanges(remote, changes), { ...remote, theme: 'light' });
    assert.deepEqual(applyChanges({ c_a: { affinity: 80 }, c_b: { affinity: 20 } },
      [{ path: ['c_b', 'affinity'], value: 70 }]), { c_a: { affinity: 80 }, c_b: { affinity: 70 } });
    assert.throws(() => applyChanges({}, [{ path: ['__proto__', 'polluted'], value: true }]));
  });
  await test('清空数据的界面分支检查磁盘失败（成功提示只在两边都完成后出现）', async () => {
    const ui = fs.readFileSync(new URL('../ui/settings.js', import.meta.url), 'utf8');
    assert.ok(/res\.ok === false/.test(ui), '设置面板没有检查 wipeAll 的返回值');
    assert.ok(/文件没清掉/.test(ui), '没有面向用户的"磁盘没清掉"提示文案');
  });
}

console.log('\n=== 5.6 群聊引擎 core/group.js ===');
{
  const g = await load('core/group.js');
  const u = await load('core/util.js');
  const members = [
    { id: 'c1', name: '林晚', emoji: '🌙', tags: ['温柔', '插画'], persona: { personality: '温柔、内敛', catchphrase: '……嗯。' } },
    { id: 'c2', name: '阿哲', emoji: '😏', tags: ['毒舌', '同事'], persona: { personality: '嘴毒心软', job: '同事' } },
    { id: 'c3', name: '小满', emoji: '🍰', tags: ['活泼', '学妹'], persona: { personality: '元气满满' } },
  ];

  await test('mentionTargets 认出 @ 到的角色（并区分"用户在点名"）', () => {
    const r = g.mentionTargets('@阿哲 你说呢？顺带问问小满', members, '小陈');
    assert.deepEqual(r.memberIds, ['c2', 'c3']);
    assert.equal(r.user, false);
    assert.equal(g.mentionTargets('@小陈 你来定', members, '小陈').user, true);
    assert.deepEqual(g.mentionTargets('', members, '小陈').memberIds, []);
  });

  await test('planSpeakers：被 @ 的人排第一（关掉"每人至少一次"时按 maxAutoTurns 截断）', () => {
    const ids = g.planSpeakers({
      group: { turnMode: 'smart', maxAutoTurns: 2, everyoneSpeaks: false },
      members,
      history: [],
      text: '阿哲你怎么看',
      force: true,
    });
    assert.equal(ids[0], 'c2', `被提到的角色应排第一，实际 ${JSON.stringify(ids)}`);
    assert.equal(ids.length, 2, `everyoneSpeaks=false 时应截断到 maxAutoTurns=2，实际 ${ids.length}`);
  });

  await test('planSpeakers：自己聊的轮次保证每位成员至少发言一次', () => {
    const ids = g.planSpeakers({
      group: { turnMode: 'smart', maxAutoTurns: 2 }, // everyoneSpeaks 默认开启
      members,
      history: [],
      text: '',
      force: true,
    });
    assert.equal(ids.length, members.length, `3 个人的群应该都轮到，实际 ${ids.length}`);
    assert.deepEqual(
      [...ids].sort(),
      members.map((m) => m.id).sort(),
      `每位成员都要在名单里，实际 ${JSON.stringify(ids)}`
    );
    // 用户说了话的那一轮（不是"他们自己聊"）仍然按 maxAutoTurns 截断
    const reply = g.planSpeakers({ group: { turnMode: 'smart', maxAutoTurns: 2 }, members, history: [], text: '你们好' });
    assert.equal(reply.length, 2, `用户发言的轮次不该被拉满，实际 ${reply.length}`);
    // 只有 1 个成员时也不会死循环/重复
    const one = g.planSpeakers({ group: { turnMode: 'smart', maxAutoTurns: 3 }, members: [members[0]], history: [], text: '', force: true });
    assert.deepEqual(one, ['c1']);
  });

  await test('随机插话：洗牌均匀（不是"随机比较器排序"那种有偏洗牌）', () => {
    // 1) 直接测 shuffle：每个元素落到每个位置的概率都应接近 1/n
    const n = 4;
    const posCount = Array.from({ length: n }, () => new Array(n).fill(0));
    const times = 6000;
    for (let i = 0; i < times; i++) {
      const arr = u.shuffle([0, 1, 2, 3]);
      assert.equal(arr.length, n, 'shuffle 不能丢元素');
      assert.deepEqual([...arr].sort(), [0, 1, 2, 3], 'shuffle 不能改内容');
      arr.forEach((v, idx) => (posCount[v][idx] += 1));
    }
    const expect = times / n;
    for (let v = 0; v < n; v++) {
      for (let idx = 0; idx < n; idx++) {
        const dev = Math.abs(posCount[v][idx] - expect) / expect;
        assert.ok(dev < 0.12, `元素 ${v} 落在第 ${idx} 位的概率偏离过大：${(posCount[v][idx] / times * 100).toFixed(1)}%（期望 25%）`);
      }
    }
    // 2) 测 planSpeakers 的随机模式：4 人取 2，每人的出现率都该接近 50%
    const members4 = [
      { id: 'c1', name: '林晚' },
      { id: 'c2', name: '阿哲' },
      { id: 'c3', name: '小满' },
      { id: 'c4', name: '老周' },
    ];
    const appear = { c1: 0, c2: 0, c3: 0, c4: 0 };
    const runs = 2000;
    for (let i = 0; i < runs; i++) {
      const plan = g.planSpeakers({
        group: { turnMode: 'random', maxAutoTurns: 2, everyoneSpeaks: false },
        members: members4,
        history: [],
        text: '在吗',
      });
      assert.equal(plan.length, 2, `随机模式仍应遵守"一轮最多 2 位"，实际 ${plan.length}`);
      for (const id of plan) appear[id] += 1;
    }
    for (const [id, cnt] of Object.entries(appear)) {
      const pct = (cnt / runs) * 100;
      assert.ok(Math.abs(pct - 50) < 6, `${id} 的出现率 ${pct.toFixed(1)}% 偏离 50% 太多（有偏洗牌会低到 37%）`);
    }
  });

  await test('禁言：被禁言的人不会发言（@ 也没用），全员禁言则全体安静', () => {    const group = { turnMode: 'smart', maxAutoTurns: 3, mutedMembers: ['c2'] };
    const mentioned = g.planSpeakers({ group, members, history: [], text: '@阿哲 你来说', force: false });
    assert.ok(!mentioned.includes('c2'), `被禁言的人不该出现在名单里：${JSON.stringify(mentioned)}`);
    assert.ok(mentioned.length >= 1, '其他成员仍然要能接话');
    // "每人至少一次"的轮次里也要跳过被禁言的，并且上限按"能说话的人数"算
    const all = g.planSpeakers({ group: { ...group, everyoneSpeaks: true }, members, history: [], text: '', force: true });
    assert.deepEqual([...all].sort(), ['c1', 'c3'], `应该只剩没被禁言的两位：${JSON.stringify(all)}`);
    // 全员禁言
    assert.deepEqual(g.planSpeakers({ group: { ...group, muteAll: true }, members, history: [], text: '在吗', force: true }), []);
    assert.deepEqual(g.planSpeakers({ group: { ...group, muteAll: true }, members, history: [], text: '', force: true }), []);
    // 辅助函数
    assert.equal(g.isMuteAll({ muteAll: true }), true);
    assert.equal(g.isMuteAll({}), false);
    assert.deepEqual([...g.mutedIds({ mutedMembers: ['c2', 'c2', ' c9 '] })].sort(), ['c2', 'c9']);
    assert.equal(g.mutedIds({}).size, 0, '没有配置时不该有人被禁言');
  });

  await test('memberTies / topTies：从角色卡资料推出"谁和谁熟"', () => {    const cast = [
      {
        id: 'a',
        name: '林晚',
        group: '二次元',
        tags: ['温柔'],
        persona: { world: '赛博朋克新港', place: '旧城区', personality: '安静' },
      },
      {
        id: 'b',
        name: '阿哲',
        group: '二次元',
        tags: ['温柔', '同事'],
        persona: { world: '赛博朋克新港', place: '旧城区', personality: '嘴毒' },
      },
      { id: 'c', name: '小满', group: '日常', tags: ['活泼'], persona: { world: '未来校园', personality: '元气' } },
      { id: 'd', name: '陌生', group: '', tags: [], persona: {} },
    ];
    const ab = g.memberTies(cast[0], cast[1]);
    assert.ok(ab.score >= 5, `同组同世界同地点同标签应该明显更亲，实际 ${ab.score}`);
    assert.ok(ab.reasons.some((r) => r.includes('二次元')), `缺少同组理由：${ab.reasons.join('/')}`);
    assert.ok(ab.reasons.some((r) => r.includes('共同标签')), `缺少共同标签理由：${ab.reasons.join('/')}`);
    assert.equal(g.memberTies(cast[0], cast[0]).score, 0, '自己和自己不算关系');
    assert.equal(g.memberTies(cast[0], cast[3]).score, 0, '资料毫无交集的人不该有分数');
    const top = g.topTies(cast[0], cast, 2);
    assert.equal(top[0].member.id, 'b', `最熟的人应该是 b，实际 ${top[0].member.id}`);
    assert.equal(top.length, 1, `只应有 1 个"有关系"的人，实际 ${top.length}`);
    // 资料里写到了对方名字 → 强信号
    const mention = g.memberTies(
      { id: 'x', name: '甲', persona: { personality: '和阿哲是发小' } },
      { id: 'y', name: '阿哲', persona: {} }
    );
    assert.ok(mention.score >= 3 && mention.reasons.some((r) => r.includes('资料里提到过')), `名字命中没被识别：${JSON.stringify(mention)}`);
  });

  await test('userRelevance：只有话题跟用户有关时才鼓励回应 TA', () => {
    const hist = [
      { role: 'user', content: '你们聊', speakerId: 'user' },
      { role: 'assistant', speakerId: 'c1', content: '那我先说说我的画' },
      { role: 'assistant', speakerId: 'c2', content: '行啊，你画你的' },
    ];
    const r = g.userRelevance(hist, { userName: '小陈' });
    assert.equal(r.related, false, '最近几条没人提用户、最后一条也不是用户说的 → 不该算相关');
    assert.equal(r.lastFromUser, false);
    assert.equal(g.userRelevance(hist.slice(0, 1), { userName: '小陈' }).related, true, '最后一条是用户说的 → 相关');
    assert.equal(
      g.userRelevance([...hist, { role: 'assistant', speakerId: 'c1', content: '小陈你说呢' }], { userName: '小陈' }).related,
      true,
      '有人提到用户名 → 相关'
    );
    assert.equal(g.userRelevance(hist, { userName: '小陈', topic: '小陈的生日会' }).inTopic, true, '群主题里有用户名 → inTopic');
  });

  await test('planSpeakers：mention 模式没人被 @ 时全体安静', () => {
    const silent = g.planSpeakers({ group: { turnMode: 'mention', maxAutoTurns: 3 }, members, history: [], text: '大家好' });
    assert.deepEqual(silent, [], '只应 @ 模式下不应该有人主动开口');
    const forced = g.planSpeakers({ group: { turnMode: 'mention', maxAutoTurns: 2 }, members, history: [], text: '大家好', force: true });
    assert.equal(forced.length, 2, '强制开聊时仍然要能挑到人');
  });

  await test('planSpeakers：round 模式从"上一个说话的人"之后轮起', () => {
    const history = [{ role: 'assistant', speakerId: 'c2', content: '我啊' }];
    const ids = g.planSpeakers({ group: { turnMode: 'round', maxAutoTurns: 3 }, members, history, text: '' });
    assert.deepEqual(ids, ['c3', 'c1', 'c2'], `轮流顺序不对：${JSON.stringify(ids)}`);
  });

  await test('planSpeakers：刚说完的人不会立刻又抢话（smart）', () => {
    const history = [
      { role: 'assistant', speakerId: 'c1', content: 'a' },
      { role: 'assistant', speakerId: 'c1', content: 'b' },
      { role: 'assistant', speakerId: 'c1', content: 'c' },
    ];
    const ids = g.planSpeakers({ group: { turnMode: 'smart', maxAutoTurns: 1 }, members, history, text: '' });
    assert.notEqual(ids[0], 'c1', '刚连说三句的人不应该又排在第一位');
  });

  await test('planSpeakers：未知输入不崩', () => {
    assert.deepEqual(g.planSpeakers({ members: [], group: {} }), []);
    assert.deepEqual(g.planSpeakers(), []);
    const ids = g.planSpeakers({ members, group: { turnMode: '不存在的策略' }, text: '', force: true });
    assert.ok(ids.length >= 1, '未知策略应退回默认的智能接话');
  });

  await test('formatTranscript：把群消息转成「谁：说了什么」', () => {
    const text = g.formatTranscript(
      [
        { role: 'user', content: '今天谁有空？' },
        { role: 'assistant', speakerId: 'c2', content: '我啊，怎么了' },
        { role: 'assistant', speakerId: 'cX', speakerName: '已删除的角色', content: '路过' },
        { role: 'system', content: '（系统：群聊记录已清空）' },
      ],
      { userName: '小陈', members }
    );
    assert.ok(text.includes('小陈：今天谁有空？'), '用户消息没有带上用户名字');
    assert.ok(text.includes('阿哲：我啊，怎么了'), '角色消息没有带上角色名');
    assert.ok(text.includes('已删除的角色：路过'), '角色被删后应退回 speakerName');
    assert.ok(text.includes('系统：群聊记录已清空'), '系统消息格式不对');
  });

  await test('buildGroupMessages：含群聊规则 / 成员名单 / 群聊记录 / 本轮指令', () => {
    const built = g.buildGroupMessages({
      group: { id: 'g1', name: '深夜食堂', topic: '凌晨三点的居酒屋' },
      speaker: members[0],
      members,
      history: [
        { role: 'user', content: '今天谁有空？' },
        { role: 'assistant', speakerId: 'c2', content: '我啊，怎么了' },
      ],
      settings: { user: { name: '小陈' }, context: {} },
      memory: { summary: '你们常一起吃饭', facts: ['用户养了只猫'] },
      runtime: { affinity: 60 },
      userName: '小陈',
    });
    assert.equal(built.messages[0].role, 'system');
    assert.equal(built.messages[built.messages.length - 1].role, 'user');
    const sys = built.messages[0].content;
    assert.ok(sys.includes('【你现在在一个群聊里'), '缺少群聊场景说明');
    assert.ok(sys.includes('群名：深夜食堂'), '缺少群名');
    assert.ok(sys.includes('凌晨三点的居酒屋'), '缺少群主题/场景');
    assert.ok(sys.includes('你（林晚）、阿哲、小满'), `成员名单不对：${sys.slice(0, 400)}`);
    assert.ok(sys.includes('绝不能替他们说话'), '缺少"不要替其他角色说话"的铁律');
    assert.ok(sys.includes('阿哲：我啊，怎么了'), '群聊记录没有带进提示词');
    assert.ok(sys.includes('林晚'), '没有以说话者的身份装配人设');
    assert.ok(!sys.includes('你现在扮演「阿哲」'), '串了人设：把别的角色当成自己');
    assert.ok(built.messages[1].content.includes('轮到你（林晚）'), '本轮指令没有点名');
    assert.equal(built.meta.mode, 'group');
    assert.equal(built.meta.speakerId, 'c1');
  });

  await test('buildGroupMessages：用户性别与自述合并写进成员名单', () => {
    const opts = {
      group: { id: 'g1', name: '深夜食堂' },
      speaker: members[0],
      members,
      history: [],
    };
    const both = g.buildGroupMessages({ ...opts, settings: { user: { name: '小陈', gender: '男', persona: '程序员' }, context: {} } });
    assert.ok(
      both.messages[0].content.includes('用户「小陈」其人：性别男；程序员'),
      `群名单里没把性别与自述合起来：${both.messages[0].content.slice(0, 400)}`
    );
    const onlyGender = g.buildGroupMessages({ ...opts, settings: { user: { name: '小陈', gender: '女' }, context: {} } });
    assert.ok(onlyGender.messages[0].content.includes('用户「小陈」其人：性别女'), '只设性别时也应写进群名单');
    const none = g.buildGroupMessages({ ...opts, settings: { user: { name: '小陈' }, context: {} } });
    assert.ok(!none.messages[0].content.includes('其人：'), '性别与自述都没设时不该出现「其人」行');
  });

  await test('buildGroupMessages：空群（还没人说话）也能装配出"起个头"的指令', () => {
    const built = g.buildGroupMessages({
      group: { id: 'g2', name: '新群' },
      speaker: members[1],
      members,
      history: [],
      settings: { context: {} },
    });
    assert.ok(built.messages[0].content.includes('【群里还没有人说过话】'), '空群提示缺失');
    assert.ok(built.messages[1].content.includes('先起个头'), '空群的指令应该是"先开口"');
  });

  await test('群聊转写：狼人杀消息默认不进普通提示词（否则局后还在演）', () => {
    const members = [
      { id: 'c1', name: '林晚' },
      { id: 'c2', name: '阿哲' },
    ];
    const history = [
      { role: 'assistant', speakerId: 'c1', content: '今天天气不错', status: 'done' },
      { role: 'system', content: '【法官】狼人杀开始！', status: 'done', game: 'werewolf' },
      { role: 'assistant', speakerId: 'c2', content: '我投 1 号', status: 'done', game: 'werewolf' },
      { role: 'assistant', speakerId: 'c1', content: '我是真预言家', status: 'done', game: 'werewolf' },
      { role: 'assistant', speakerId: 'c2', content: '晚上吃什么', status: 'done' },
    ];
    const normal = g.formatTranscript(history, { userName: '我', members });
    assert.ok(!/法官|狼人杀|我投|预言家/.test(normal), `普通转写不该包含局内内容：${normal}`);
    assert.ok(normal.includes('今天天气不错') && normal.includes('晚上吃什么'), `正常消息要保留：${normal}`);
    const withGame = g.formatTranscript(history, { userName: '我', members, includeGame: true });
    assert.ok(/法官/.test(withGame) && /我投 1 号/.test(withGame), `includeGame 时应当带上局内内容：${withGame}`);
    // 局终公告（keepGame）要留在普通转写里：让角色记得玩过、也知道已经散场
    const withKeep = [
      ...history,
      { role: 'system', content: '【法官】本局狼人杀结束：好人阵营胜利。大家散场，可以继续正常聊天了。', status: 'done', game: 'werewolf', keepGame: true },
    ];
    const kept = g.formatTranscript(withKeep, { userName: '我', members });
    assert.ok(/本局狼人杀结束/.test(kept), `局终公告应当保留：${kept}`);
    assert.ok(!/我投 1 号|我是真预言家/.test(kept), `局内发言仍要屏蔽：${kept}`);

    // 装配提示词时也一样：普通轮次不该看到局内内容
    const char = { id: 'c2', name: '阿哲', persona: {} };
    const built = g.buildGroupMessages({ group: { name: '测试群' }, speaker: char, members, history, settings: {}, userName: '我' });
    const sys = built.messages[0].content;
    assert.ok(!/【法官】/.test(sys) && !/我投 1 号/.test(sys), '普通群聊提示词里不该出现局内消息');
    const built2 = g.buildGroupMessages({ group: { name: '测试群' }, speaker: char, members, history, settings: {}, userName: '我', includeGame: true });
    assert.ok(/【法官】/.test(built2.messages[0].content), 'includeGame 时应当能带回来');
    const builtKeep = g.buildGroupMessages({ group: { name: '测试群' }, speaker: char, members, history: withKeep, settings: {}, userName: '我' });
    const sysKeep = builtKeep.messages[0].content;
    assert.ok(/本局狼人杀结束/.test(sysKeep), '普通提示词里应当保留"本局已结束"这条');
    assert.ok(!/我投 1 号/.test(sysKeep), '普通提示词里仍不该有局内发言');
  });

  await test('stripSpeakerPrefix：去掉模型爱加的「名字：」前缀', () => {
    assert.equal(g.stripSpeakerPrefix('林晚：……嗯。', ['林晚']), '……嗯。');
    assert.equal(g.stripSpeakerPrefix('**阿哲**: 你少来', ['阿哲']), '你少来');
    assert.equal(g.stripSpeakerPrefix('……嗯。', ['林晚']), '……嗯。');
    assert.equal(g.stripSpeakerPrefix(': 只有冒号', ['林晚']), ': 只有冒号');
  });

  await test('TURN_MODES 与 store 的 GROUP_TURN_MODES 一致', async () => {
    const s = await load('core/store.js');
    assert.deepEqual(g.TURN_MODES.map((m) => m.id).slice().sort(), s.GROUP_TURN_MODES.slice().sort());
  });
}

console.log('\n=== 5.7 群聊数据结构（core/store.js 的纯函数部分）===');
{
  const s = await load('core/store.js');
  await test('normalizeGroup 补齐全部字段（脏输入不崩）', () => {
    const keys = [
      'id', 'name', 'avatar', 'emoji', 'color', 'topic', 'members', 'pinned', 'muted',
      'autoTalk', 'turnMode', 'maxAutoTurns', 'autoDelayMs', 'autoVoice', 'greeting',
      'createdAt', 'updatedAt', 'version',
    ];
    for (const bad of [null, undefined, 0, 'abc', [], { members: 'not-array' }]) {
      const g = s.normalizeGroup(bad);
      for (const k of keys) assert.ok(k in g, `缺少字段 ${k}`);
      assert.ok(Array.isArray(g.members));
      assert.ok(g.members.length === 0);
      assert.ok(typeof g.name === 'string' && g.name.length > 0);
    }
  });

  await test('normalizeGroup：成员去重、上限 24、非法策略回退', () => {
    const g = s.normalizeGroup({
      name: '测试群',
      members: ['c1', 'c1', 'c2', '', null, 'c2'],
      turnMode: '乱写的策略',
      maxAutoTurns: 99,
      autoDelayMs: -5,
    });
    assert.deepEqual(g.members, ['c1', 'c2']);
    assert.equal(g.turnMode, 'smart');
    assert.equal(g.maxAutoTurns, 8, '一轮上限应夹到 8');
    assert.equal(g.autoDelayMs, 0, '间隔下限应夹到 0');
  });

  await test('normalizeGroup：能套用设置里的群聊默认项', () => {
    const g = s.normalizeGroup({ name: 'x' }, { turnMode: 'random', maxAutoTurns: 5, autoTalk: false, emoji: '🍻' });
    assert.equal(g.turnMode, 'random');
    assert.equal(g.maxAutoTurns, 5);
    assert.equal(g.autoTalk, false);
    assert.equal(g.emoji, '🍻');
  });

  await test('DEFAULT_SETTINGS 里有群聊默认项', () => {
    const d = s.DEFAULT_SETTINGS.group;
    assert.ok(d, '缺少 settings.group');
    for (const k of ['autoTalk', 'turnMode', 'maxAutoTurns', 'autoDelayMs', 'autoVoice']) {
      assert.ok(k in d, `settings.group 缺少 ${k}`);
    }
    assert.ok(s.GROUP_TURN_MODES.includes(d.turnMode));
  });
}

console.log('\n=== 5.7 狼人杀 core/werewolf.js ===');
{
  const w = await load('core/werewolf.js');
  const wu = await load('ui/werewolf.js'); // 只用到其中的纯函数（票数角标规则）

  await test('板子配置：人数 → 狼/民/神，与规则文件的配置表一致', () => {
    const g = (n) => w.boardFor(n);
    assert.deepEqual([g(6).wolf, g(6).villager, g(6).gods], [2, 2, ['seer', 'witch']]);
    assert.deepEqual([g(7).wolf, g(7).villager, g(7).gods.length], [2, 2, 3]);
    assert.deepEqual([g(9).wolf, g(9).villager, g(9).gods], [3, 3, ['seer', 'witch', 'hunter']]);
    assert.deepEqual([g(12).wolf, g(12).villager, g(12).gods], [4, 4, ['seer', 'witch', 'hunter', 'idiot']]);
    assert.equal(g(6).witchAntidoteOnly, true, '6 人局女巫只有一瓶药');
    assert.equal(g(9).witchAntidoteOnly, false);
    assert.equal(g(5), null, '低于 6 名玩家不能开局');
    assert.equal(g(14), null, '超过 13 名玩家不能开局');
    for (let n = 6; n <= 13; n++) {
      const b = g(n);
      assert.equal(b.cards.length, n, `${n} 人局的牌数应等于人数`);
      assert.equal(b.cards.filter((c) => c === 'wolf').length, b.wolf, `${n} 人局狼数不对`);
      for (const c of b.cards) assert.ok(w.ROLES[c], `未知身份 ${c}`);
    }
    assert.ok(/狼/.test(w.boardLabel(g(9))) && /预言家/.test(w.boardLabel(g(9))), '板子描述要含狼数与神职');
  });

  await test('发牌：一人一张、狼的数量正确、座位从 1 开始', () => {
    const board = w.boardFor(9);
    const players = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '玩家' + i }));
    const dealt = w.assignRoles(players, board);
    assert.equal(dealt.length, 9);
    assert.deepEqual(dealt.map((p) => p.seat), [1, 2, 3, 4, 5, 6, 7, 8, 9], '座位号应从 1 连续排');
    assert.equal(dealt.filter((p) => p.team === 'wolf').length, 3);
    assert.equal(dealt.filter((p) => p.role === 'seer').length, 1);
    assert.equal(dealt.filter((p) => p.role === 'witch').length, 1);
    assert.ok(dealt.every((p) => p.alive === true && p.canVote === true), '开局所有人存活且有票权');
    // 两次发牌不应该总是同一个结果（随机性）
    let diff = false;
    for (let i = 0; i < 30 && !diff; i++) {
      const again = w.assignRoles(players, board);
      if (again.map((p) => p.role).join() !== dealt.map((p) => p.role).join()) diff = true;
    }
    assert.ok(diff, '发牌应当是随机的');
  });

  await test('屠边胜负：狼全出局→好人胜；神清空或民清空→狼胜', () => {
    const mk = (roles) => ({
      players: roles.map(([role, team, god], i) => ({ id: 'p' + i, seat: i + 1, name: 'P' + i, role, team, god, alive: true })),
    });
    const s1 = mk([['wolf', 'wolf', false], ['seer', 'good', true], ['villager', 'good', false]]);
    assert.equal(w.checkWinner(s1), '', '三方都活着时无人获胜');
    s1.players[0].alive = false;
    assert.equal(w.checkWinner(s1), 'good', '狼全出局 → 好人胜');
    const s2 = mk([['wolf', 'wolf', false], ['wolf', 'wolf', false], ['seer', 'good', true], ['villager', 'good', false], ['villager', 'good', false]]);
    s2.players[2].alive = false;
    assert.equal(w.checkWinner(s2), 'wolf', '神职清空 → 狼胜（屠神）');
    const s3 = mk([['wolf', 'wolf', false], ['seer', 'good', true], ['villager', 'good', false]]);
    s3.players[2].alive = false;
    assert.equal(w.checkWinner(s3), 'wolf', '平民清空 → 狼胜（屠民）');
  });

  await test('解析模型回复：座位号 / 弃票 / 发言与投票拆行', () => {
    const allow = [1, 2, 3, 4];
    assert.equal(w.parseSeat('刀杀：3号', allow), 3);
    assert.equal(w.parseSeat('我投 2 号', allow), 2);
    assert.equal(w.parseSeat('就查 4号吧', allow), 4);
    assert.equal(w.parseSeat('3', allow), 3, '只回一个数字也要认');
    assert.equal(w.parseSeat('我怀疑 9 号', allow), null, '不在候选里的座位号要忽略');
    assert.equal(w.parseSeat('不知道', allow), null);
    assert.equal(w.parseDecline('不用药'), true);
    assert.equal(w.parseDecline('投票：弃票'), true);
    assert.equal(w.parseDecline('投 3 号'), false);
    const sp = w.splitSpeechAndVote('我觉得 3 号有问题，先出他。\n投票：3号', allow);
    assert.equal(sp.vote, 3);
    assert.equal(sp.speech, '我觉得 3 号有问题，先出他。');
    const sp2 = w.splitSpeechAndVote('我先听听大家怎么说。\n投票：弃票', allow);
    assert.equal(sp2.vote, null);
    assert.equal(sp2.abstain, true);
    const sp3 = w.splitSpeechAndVote('没什么想说的', allow);
    assert.equal(sp3.vote, null);
    assert.equal(sp3.abstain, false);
    assert.equal(sp3.speech, '没什么想说的', '没有投票行时整段都是发言');

    // 用户实际会写的各种投票写法（都能识别，且别把发言吃掉）
    const cases = [
      ['投票：3号', 3],
      ['投票: 3号', 3],
      ['投票：3', 3],
      ['我的投票：3号', 3],
      ['投3号', 3],
      ['我投 3 号', 3],
      ['投给3号', 3],
      ['票3号', 3],
      ['3号', 3],
      ['我先听听大家怎么说。\n投票：3号', 3],
      ['我先听听。投票：3号', 3], // 一行写完也要认出来
    ];
    for (const [text, want] of cases) {
      const r = w.splitSpeechAndVote(text, allow);
      assert.equal(r.vote, want, `「${text}」应当解析成投 ${want} 号，实际 ${r.vote}`);
      assert.equal(r.abstain, false, `「${text}」不该被当成弃票`);
    }
    // 一行写完时，投票前面的那句要留作发言
    const oneLine = w.splitSpeechAndVote('我觉得 2 号有问题。投票：3号', allow);
    assert.equal(oneLine.vote, 3);
    assert.equal(oneLine.speech, '我觉得 2 号有问题。', `发言被吃掉了：${JSON.stringify(oneLine.speech)}`);
    // 纯投票（没有发言）时不该把投票行当成发言
    const pure = w.splitSpeechAndVote('投票：3号', allow);
    assert.equal(pure.speech, '', `纯投票不该有发言内容：${JSON.stringify(pure.speech)}`);
    // 弃票的几种写法
    for (const t of ['弃票', '投票：弃票', '不投票', '弃权']) {
      const r = w.splitSpeechAndVote(t, allow);
      assert.equal(r.abstain, true, `「${t}」应当算弃票`);
      assert.equal(r.vote, null);
    }
    // 按名字投票
    const players = [
      { seat: 1, name: '林晚' },
      { seat: 2, name: '阿哲' },
      { seat: 3, name: '小满' },
      { seat: 4, name: '老周' },
    ];
    assert.equal(w.parseSeat('投票：林晚', allow, players), 1, '应当支持按名字投票');
    assert.equal(w.splitSpeechAndVote('我投林晚', allow, players).vote, null, '没写"投票："的按名字投不算（避免误判）');
    assert.equal(w.splitSpeechAndVote('投票：林晚', allow, players).vote, 1);
    assert.equal(w.splitSpeechAndVote('投票：小满', allow, players).vote, 3);
    // 只能投存活玩家：不在候选里的名字/号码都不算
    assert.equal(w.parseSeat('投票：老周', [1, 2, 3], players), null, '不在候选里的名字不该算数');
  });

  await test('发言流式预览：气泡里长出来的字与最终那条消息一致（不会先出现再消失）', () => {
    const allow = [1, 2, 3, 4, 5];
    // 模型白天发言的真实格式（见 dayPromptFor）：先说人话，再另起一行写票
    const raws = [
      '我是 3 号，我先说说我的看法：5 号有点可疑，我投 TA。\n投票：5号',
      '我先听听大家怎么说。\n投票：弃票',
      '我投 5 号吧。投票：5号', // 票写在句子尾巴上
      '没什么想说的',
      '投票：3号',
    ];
    for (const raw of raws) {
      const final = w.splitSpeechAndVote(raw, allow).speech;
      // 每个前缀都是一次真实推送：预览必须**始终是最终正文的前缀**。
      // 一旦不是，你就会看到字先冒出来、随后又消失（那正是"整句蹦出来"之后的新毛病）。
      for (let i = 1; i <= raw.length; i++) {
        const pre = w.liveSpeechPreview(raw.slice(0, i));
        assert.ok(
          final.startsWith(pre),
          `「${raw.slice(0, i)}」的预览 ${JSON.stringify(pre)} 不是最终正文 ${JSON.stringify(final)} 的前缀`
        );
      }
      assert.equal(w.liveSpeechPreview(raw), final, `整段写完后预览应当等于最终正文：${JSON.stringify(raw)}`);
    }
    // 半截的票（独占一行 / 接在句子尾巴上）都不能先冒出来再消失
    assert.equal(w.liveSpeechPreview('我是 2 号。\n投票'), '我是 2 号。');
    assert.equal(w.liveSpeechPreview('我是 2 号。\n投票：3'), '我是 2 号。');
    assert.equal(w.liveSpeechPreview('我是 2 号。\n投票：3号'), '我是 2 号。');
    assert.equal(w.liveSpeechPreview('我先听听。投'), '我先听听。');
    assert.equal(w.liveSpeechPreview('我先听听。投票：'), '我先听听。');
    // 正常句子里的"投"不能被误当成票（必须以句读符号起始才算）
    assert.equal(w.liveSpeechPreview('我投 5 号吧'), '我投 5 号吧');
    assert.equal(w.liveSpeechPreview('投票的时候别犹豫'), '投票的时候别犹豫');
    assert.equal(w.liveSpeechPreview('投票：3号'), '', '整段只有一张票时没有可预览的发言');
    assert.equal(w.liveSpeechPreview(''), '');
  });

  await test('发言流式事件：只有公开发言才往聊天页推，且一律先裁成正文', () => {
    const ai = { id: 'c1', name: '林晚', seat: 3 };
    const ev = wu.speechLiveEvent('g1', ai, '我是 3 号，我觉得 5 号可疑。\n投票：5号');
    assert.equal(ev.groupId, 'g1', '事件必须带群 id，否则会画到别的群的聊天页上');
    assert.equal(ev.playerId, 'c1');
    assert.equal(ev.name, '林晚');
    assert.equal(ev.text, '我是 3 号，我觉得 5 号可疑。', '推给界面的必须是正文（投票行要被裁掉）');
    // 写到一半的票：正文只留前半句（否则那半行会先冒出来再消失）
    assert.equal(wu.speechLiveEvent('g1', ai, '我是 3 号。\n投票：5').text, '我是 3 号。');
    // 整段只有一张票：没有正文可显示（气泡上先显示"正在输入…"）
    assert.equal(wu.speechLiveEvent('g1', ai, '投票：5号').text, '');
    // null = 这一轮没有发言（模型空回 / 被停掉）：界面据此收掉气泡
    assert.equal(wu.speechLiveEvent('g1', ai, null).off, true, 'null 要变成"收气泡"事件');
    // 真人自己的发言是自己敲进去的，不需要流式预览
    assert.equal(wu.speechLiveEvent('g1', { id: 'user', name: '我', isUser: true }, '我说的'), null);
    assert.equal(wu.speechLiveEvent('g1', null, '没有发言人'), null);
  });

  await test('规则速查卡：按本局板子生成，关键限制都在', () => {
    const deck = (players) => w.assignRoles(Array.from({ length: players }, (_, i) => ({ id: 'c' + i, name: 'P' + i })), w.boardFor(players));
    const s6 = { players: deck(6), board: w.boardFor(6), log: [], seerChecks: [], witch: { antidote: true, poison: false }, day: 1 };
    const s7 = { players: deck(7), board: w.boardFor(7), log: [], seerChecks: [], witch: { antidote: true, poison: true }, day: 1 };
    const card6 = w.ruleCardFor(s6, false);
    const card7 = w.ruleCardFor(s7, false);
    const short6 = w.ruleCardFor(s6, true);
    for (const key of ['只能刀一个人', '不能自救', '同一晚不能同时用解药和毒药', '屠边', '平票', '出局的人不再发言', '被女巫毒死则不能开枪', '白痴']) {
      assert.ok(card7.includes(key), `规则卡缺少「${key}」`);
    }
    assert.ok(card6.includes('本局女巫只有一瓶解药'), `6 人局要写明女巫只有解药：${card6.slice(0, 60)}`);
    assert.ok(!card7.includes('本局女巫只有一瓶解药'), '7 人局不该说女巫只有解药');
    assert.ok(card6.includes('6 人局 = 2 狼 + 2 民'), `规则卡要写明本局配置：${card6.split(String.fromCharCode(10))[1]}`);
    assert.ok(card7.includes('7 人局 = 2 狼 + 2 民'), '板子配置要跟着人数变');
    assert.ok(short6.includes('只能刀一个人') && short6.length < card6.length, '夜间短版应当更短但仍含关键限制');
    // 女巫的私密信息要说明不能自救、以及本局有没有毒药
    const witch6 = s6.players.find((p) => p.role === 'witch');
    const f6 = w.privateFacts(s6, witch6);
    assert.ok(f6.includes('不能自救'), `女巫要知道不能自救：${f6}`);
    assert.ok(f6.includes('本局你没有毒药'), `6 人局女巫要知道没有毒药：${f6}`);
    const witch7 = s7.players.find((p) => p.role === 'witch');
    assert.ok(!w.privateFacts(s7, witch7).includes('本局你没有毒药'), '7 人局女巫应当有毒药');
    // 狼人要知道"每晚只能刀一个人"
    const wolf = s7.players.find((p) => p.team === 'wolf');
    assert.ok(w.privateFacts(s7, wolf).includes('只能刀一个人'), '狼人要知道每晚只能刀一人');
  });

  await test('盲投：收票期间票数不公开，只有本轮结算完才公布', () => {
    // 这条规则来自真实体验：投票条上挂着"谁现在几票"，等于替还没投的人（尤其是你）做决定
    const state = {
      players: [
        { id: 'a', seat: 3, name: '小满' },
        { id: 'b', seat: 5, name: '老周' },
      ],
      day: 2,
      voteOpen: true, // 正在收票
      voteLive: { 3: 2 }, // 引擎内部的实时票数：**不许对外**
      voteResult: null,
    };
    assert.deepEqual(w.publicVoteTally(state), {}, '收票期间票数必须为空');
    assert.equal(w.tallyText(state, w.publicVoteTally(state)), '', '收票期间界面上一个数字都没有');
    assert.equal(w.tallyText(state), '', '不传 tally 时也不能回退到内部实时票数（voteLive）');
    // 本轮结算完（publishVoteResult 写进 voteResult）才公开
    state.voteOpen = false;
    state.voteResult = { day: 2, round: 0, tally: { 3: 2, 5: 1 } };
    assert.deepEqual(w.publicVoteTally(state), { 3: 2, 5: 1 }, '结算后票数才公开');
    assert.equal(w.tallyText(state, w.publicVoteTally(state)), '3 号 小满 2 票 · 5 号 老周 1 票');
    // 平票 PK 重投：又是"收票中"，重投期间同样不公开（pk 期间的界面靠这个）
    const pkState = { ...state, voteOpen: true, voteResult: null, voteRound: 1 };
    assert.deepEqual(w.publicVoteTally(pkState), {}, 'PK 重投期间票数同样不公开');
    assert.deepEqual(w.publicVoteTally(null), {}, '空输入不能崩');
  });

  await test('HUD 实时摘要：狼队友 / 查验 / 药 / 白痴翻牌', () => {
    const mkState = (players, extra = {}) => ({
      players,
      board: extra.board || w.boardFor(players.length),
      witch: extra.witch || { antidote: true, poison: true },
      seerChecks: extra.seerChecks || [],
      log: [],
    });
    const P = (seat, role, alive = true, name) => {
      const def = w.ROLES[role];
      return { id: 'p' + seat, seat, name: name || '玩家' + seat, role, team: def.team, god: def.god, alive };
    };

    // 狼人：队友是谁（出局的要标出来）
    const wolfState = mkState([P(1, 'wolf'), P(2, 'wolf'), P(3, 'villager'), P(4, 'wolf', false)]);
    const mine = wolfState.players[0];
    assert.equal(
      w.hudExtraFor(wolfState, mine),
      '（狼队友：2 号 玩家2、4 号 玩家4（已出局））',
      '狼人应当看到狼队友，且出局的标出来'
    );
    // 队友全部出局 → 既列出队友（标明出局），又提示你现在是独狼
    const lone = mkState([P(1, 'wolf'), P(2, 'wolf', false), P(3, 'villager')]);
    assert.equal(
      w.hudExtraFor(lone, lone.players[0]),
      '（狼队友：2 号 玩家2（已出局） · 你现在是独狼）',
      '队友全出局时既要能看到是谁、也要提示独狼'
    );
    // 本局只有一只狼
    const solo = mkState([P(1, 'wolf'), P(2, 'villager')]);
    assert.equal(w.hudExtraFor(solo, solo.players[0]), '（你是独狼（本局只有你一只狼））');

    // 预言家：已验几狼几好
    const seerState = mkState([P(1, 'seer'), P(2, 'wolf'), P(3, 'villager'), P(4, 'villager')], {
      seerChecks: [
        { id: 'p2', seat: 2, name: '玩家2', result: 'wolf' },
        { id: 'p3', seat: 3, name: '玩家3', result: 'good' },
        { id: 'p4', seat: 4, name: '玩家4', result: 'good' },
      ],
    });
    assert.equal(w.hudExtraFor(seerState, seerState.players[0]), '（已验 1 狼 / 2 好）');
    assert.equal(w.hudExtraFor(mkState([P(1, 'seer'), P(2, 'villager')]), { role: 'seer', id: 'p1', seat: 1 }), '', '还没查验时不显示');

    // 女巫：两瓶药的状态（6 人局只有解药）
    const witch7 = mkState([P(1, 'witch'), P(2, 'villager')], { witch: { antidote: true, poison: false } });
    assert.equal(w.hudExtraFor(witch7, witch7.players[0]), '（解药还在 · 毒药已用完）');
    const witch6 = mkState([P(1, 'witch'), P(2, 'villager')], { board: w.boardFor(6), witch: { antidote: false, poison: false } });
    assert.equal(w.hudExtraFor(witch6, witch6.players[0]), '（解药已用完（本局只有解药））', '6 人局要说明只有解药');

    // 白痴翻牌
    const idiotState = mkState([P(1, 'idiot'), P(2, 'wolf')]);
    assert.equal(w.hudExtraFor(idiotState, idiotState.players[0]), '', '没翻牌时不显示');
    idiotState.players[0].revealedIdiot = true;
    assert.equal(w.hudExtraFor(idiotState, idiotState.players[0]), '（已翻牌（失去投票权））');

    // 平民没有额外信息
    const villagerState = mkState([P(1, 'villager'), P(2, 'wolf')]);
    assert.equal(w.hudExtraFor(villagerState, villagerState.players[0]), '');
    assert.equal(w.hudExtraFor(null, null), '', '空输入不能崩');
  });

  await test('票数统计：tallyVotes / tallyText', () => {
    const ballots = [{ seat: 3 }, { seat: 3 }, { seat: 5 }, { seat: null }, { seat: 3 }];
    assert.deepEqual(w.tallyVotes(ballots), { 3: 3, 5: 1 }, '弃票（seat=null）不该被计入');
    const players = [
      { id: 'a', seat: 3, name: '小满' },
      { id: 'b', seat: 5, name: '老周' },
    ];
    const state = { players };
    assert.equal(w.tallyText(state, w.tallyVotes(ballots)), '3 号 小满 3 票 · 5 号 老周 1 票', '应当按票数从多到少、带名字');
    assert.equal(w.tallyText(state, {}), '', '没有票时返回空串');
    assert.equal(w.tallyText(state, { 9: 0 }), '', '0 票的条目不显示');
  });

  await test('私密身份：狼看得到同伴、预言家看得到查验，且不泄露别人', () => {
    const board = w.boardFor(9);
    const players = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '玩家' + i }));
    const dealt = w.assignRoles(players, board);
    const state = { players: dealt, log: [], seerChecks: [], witch: { antidote: true, poison: true }, day: 1 };
    const wolf = dealt.find((p) => p.team === 'wolf');
    const other = dealt.find((p) => p.team !== 'wolf');
    const note = w.privateNoteFor(state, wolf);
    assert.ok(note.includes('狼人'), '狼人的私密提示里要写明身份');
    const mates = dealt.filter((p) => p.team === 'wolf' && p.id !== wolf.id);
    for (const m of mates) assert.ok(note.includes(m.name), `狼人应当看到同伴 ${m.name}`);
    const otherNote = w.privateNoteFor(state, other);
    if (other.team === 'good') {
      for (const m of mates) {
        if (other.role === 'seer') continue; // 预言家只知道查验结果，不知道谁是狼（除非查过）
        assert.ok(!otherNote.includes(m.name) || otherNote.includes('查验'), '好人不应直接看到狼的名字');
      }
    }
    const seer = dealt.find((p) => p.role === 'seer');
    state.seerChecks = [{ id: wolf.id, seat: wolf.seat, name: wolf.name, result: 'wolf', day: 1 }];
    const seerNote = w.privateNoteFor(state, seer);
    assert.ok(seerNote.includes(wolf.name) && seerNote.includes('狼人'), '预言家要看到自己查验出的狼');
    const witch = dealt.find((p) => p.role === 'witch');
    assert.ok(/解药/.test(w.privateNoteFor(state, witch)), '女巫要看到自己的药');
  });

  await test('狼人刀人：候选包含所有存活玩家（可自刀、可刀同伴）', async () => {
    const mkState = (players) => ({
      players,
      board: w.boardFor(players.length),
      log: [],
      seerChecks: [],
      witch: { antidote: true, poison: true },
      day: 1,
      phase: 'night',
      night: {},
      voteLive: {},
      lastBallots: [],
      groupId: 'g-wolf',
    });
    const base = () => w.assignRoles(
      Array.from({ length: 7 }, (_, i) => ({ id: 'c' + i, name: 'P' + i })),
      w.boardFor(7)
    );
    // ① 提示词里要列出全部存活玩家，并且写明可以刀同伴/自刀
    const players = base();
    const wolf = players.find((p) => p.team === 'wolf');
    const prompt = w.nightPromptFor(mkState(players), wolf, 'wolf');
    assert.ok(/所有存活玩家都可以选/.test(prompt), `提示词应说明候选范围：${prompt.slice(-120)}`);
    for (const p of players) {
      assert.ok(prompt.includes(`${p.seat} 号 ${p.name}`), `候选里应包含 ${p.seat} 号 ${p.name}`);
    }
    assert.ok(!/不能刀自己人/.test(prompt), '不该再写"不能刀自己人"');
    // ② 引擎真的接受"自刀"
    const selfState = mkState(base());
    const selfWolf = selfState.players.find((p) => p.team === 'wolf');
    const g1 = new w.WerewolfGame({ group: { id: 'g-wolf', name: 't' }, members: [], state: selfState, fastMode: true, human: {}, handlers: {} });
    g1.askLLM = async () => `刀杀：${selfWolf.seat}号`;
    await g1.phaseNight();
    assert.equal(selfState.night.wolfTargetSeat, selfWolf.seat, `应当允许自刀，实际刀了 ${selfState.night.wolfTargetSeat}`);
    // ③ 也接受"刀同伴"
    const mateState = mkState(base());
    const mateWolf = mateState.players.find((p) => p.team === 'wolf');
    const mate = mateState.players.find((p) => p.team === 'wolf' && p.id !== mateWolf.id);
    const g2 = new w.WerewolfGame({ group: { id: 'g-wolf', name: 't' }, members: [], state: mateState, fastMode: true, human: {}, handlers: {} });
    g2.askLLM = async () => `刀杀：${mate.seat}号`;
    await g2.phaseNight();
    assert.equal(mateState.night.wolfTargetSeat, mate.seat, '应当允许刀同伴');
    // ④ 人类是狼时，界面拿到的候选也是全部存活玩家
    const humanState = mkState(base());
    const humanWolf = { ...humanState.players.find((p) => p.team === 'wolf'), isUser: true };
    humanState.players = humanState.players.map((p) => (p.id === humanWolf.id ? humanWolf : p)).concat([{ id: 'user', name: '我', isUser: true, seat: 8, role: 'wolf', team: 'wolf', god: false, alive: true, canVote: true }]);
    humanState.players = humanState.players.filter((p) => !(p.isUser && p.id !== 'user'));
    let humanOptions = null;
    const g3 = new w.WerewolfGame({
      group: { id: 'g-wolf', name: 't' },
      members: [],
      state: humanState,
      fastMode: true,
      human: { wolf: async (req) => { humanOptions = req.options.map((p) => p.seat); return { seat: req.options[0].seat }; } },
      handlers: {},
    });
    g3.askLLM = async () => '';
    await g3.phaseNight();
    const aliveSeats = humanState.players.filter((p) => p.alive).map((p) => p.seat).sort((a, b) => a - b);
    assert.ok(humanOptions && humanOptions.length === aliveSeats.length, `界面候选应为全部存活玩家：${JSON.stringify(humanOptions)} vs ${JSON.stringify(aliveSeats)}`);
  });

  await test('进夜清零：上一轮的票数不会留到夜里', async () => {
    const deck = w.assignRoles(Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, name: 'P' + i, isUser: i === 5 })), w.boardFor(6));
    const state = {
      players: deck,
      board: w.boardFor(6),
      log: [],
      seerChecks: [],
      witch: { antidote: true, poison: false },
      day: 1,
      phase: 'night',
      night: {},
      voteLive: { 1: 7, 8: 1 },
      lastBallots: [{ voterSeat: 1, seat: 8 }],
      groupId: 'g-test',
    };
    const game = new w.WerewolfGame({ group: { id: 'g-test', name: 't' }, members: [], state, human: {}, handlers: {} });
    game.askLLM = async () => '';
    await game.phaseNight();
    assert.deepEqual(game.state.voteLive, {}, `入夜后票数应当清空，实际 ${JSON.stringify(game.state.voteLive)}`);
    assert.deepEqual(game.state.lastBallots, [], '入夜后投票明细也应当清空');
  });

  await test('狼人绝不能认狼：阵营铁律 + 遗言提示 + 认狼检测', () => {
    const board = w.boardFor(7);
    const players = Array.from({ length: 7 }, (_, i) => ({ id: 'c' + i, name: '玩家' + i }));
    const dealt = w.assignRoles(players, board);
    const state = { players: dealt, log: [], seerChecks: [], witch: { antidote: true, poison: true }, day: 2, board: board };
    const wolf = dealt.find((p) => p.team === 'wolf');
    const good = dealt.find((p) => p.team === 'good');

    // ① 阵营铁律：狼人必须被明确要求"任何情况下都不承认"，好人则允许亮身份
    const wolfRule = w.teamRuleFor(wolf);
    assert.ok(/不要承认自己是狼/.test(wolfRule), `狼人铁律没写"不要承认"：${wolfRule}`);
    assert.ok(/遗言/.test(wolfRule), '狼人铁律要覆盖"遗言"这个最容易自曝的场合');
    assert.ok(/悍跳|倒钩/.test(wolfRule), '狼人铁律要给出伪装手段');
    const goodRule = w.teamRuleFor(good);
    assert.ok(!/不要承认自己是狼/.test(goodRule), '好人不需要"不许认狼"这条');
    assert.ok(/亮身份|可以公布/.test(goodRule), '好人应当被允许亮身份');

    // ② 遗言提示：给狼人的版本不能再写"可以公布身份"
    const wolfLw = w.lastWordsPromptFor(state, wolf);
    assert.ok(!/可以公布身份/.test(wolfLw), `狼人遗言提示里不该允许公布身份：${wolfLw.slice(-120)}`);
    assert.ok(/绝对不能承认自己是狼/.test(wolfLw), `狼人遗言提示必须明令禁止认狼：${wolfLw.slice(-140)}`);
    const goodLw = w.lastWordsPromptFor(state, good);
    assert.ok(/可以公布身份/.test(goodLw), '好人遗言仍然可以公布身份');

    // ③ 私密身份 note 里也要带上阵营铁律
    assert.ok(/不要承认自己是狼/.test(w.privateNoteFor(state, wolf)), '私密身份里要含狼人铁律');
    assert.ok(!/不要承认自己是狼/.test(w.privateNoteFor(state, good)), '好人私密身份里不该有狼人铁律');

    // ④ 白天发言提示同样带上铁律
    assert.ok(/不要承认自己是狼/.test(w.dayPromptFor(state, wolf, { withVote: true })), '白天发言提示要含狼人铁律');
  });

  await test('狼人不能出卖同伴：铁律写明 + 遗言提示点明 + 咬同伴检测', () => {
    const board = w.boardFor(9);
    const players = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '玩家' + i }));
    const dealt = w.assignRoles(players, board);
    const state = { players: dealt, log: [], seerChecks: [], witch: { antidote: true, poison: true }, day: 3, board };
    const wolf = dealt.find((p) => p.team === 'wolf');
    const mate = dealt.find((p) => p.team === 'wolf' && p.id !== wolf.id);
    const good = dealt.find((p) => p.team === 'good');

    // ① 铁律必须写明"绝不能出卖同伴"，并给出正确做法（查杀泼给好人）
    const rule = w.teamRuleFor(wolf);
    assert.ok(/绝不能出卖狼同伴/.test(rule), `狼人铁律没写"不能出卖同伴"：${rule}`);
    assert.ok(/泼给好人|落在好人/.test(rule), '铁律要说明假查验该给谁');
    // ② 遗言提示也要点明
    const lw = w.lastWordsPromptFor(state, wolf);
    assert.ok(/绝对不能把狼同伴说成狼/.test(lw), `狼人遗言提示没禁止咬同伴：${lw.slice(-160)}`);
    // ③ 好人这边不该出现"出卖同伴"的说法
    assert.ok(!/绝不能出卖狼同伴/.test(w.teamRuleFor(good)), '好人铁律里不该有狼人专属规则');

    // ④ 检测：指认同伴是狼 = 出卖
    const seat = mate.seat;
    assert.equal(
      w.looksLikeSellingTeammate(`行啊，票送我走，那我就把话留这儿——我是预言家，昨晚验的 ${seat} 号，是狼。`, state, wolf),
      true,
      '悍跳时查杀同伴要能被抓到'
    );
    assert.equal(w.looksLikeSellingTeammate(`${mate.name} 肯定有问题，我建议先出他。`, state, wolf), true, '点名同伴可疑要能抓到');
    assert.equal(w.looksLikeSellingTeammate(`我验了 ${seat} 号，是好人。`, state, wolf), false, '给同伴发金水不算出卖');
    assert.equal(w.looksLikeSellingTeammate(`${seat} 号我保了，他绝对不是狼。`, state, wolf), false, '保同伴不算出卖');
    assert.equal(w.looksLikeSellingTeammate(`投票：${seat}号`, state, wolf), false, '投票行不按"发言咬人"处理');
    // 指认好人则完全正常（这正是狼该做的事）
    const goodSeat = good.seat;
    assert.equal(w.looksLikeSellingTeammate(`我是预言家，昨晚验的 ${goodSeat} 号，是狼。`, state, wolf), false, '查杀好人（正确打法）不该被拦');
    // 好人的发言不受这条限制（好人指认谁都行，包括误指）
    assert.equal(w.looksLikeSellingTeammate(`我觉得 ${seat} 号是狼`, state, good), false, '这条只约束狼人');

    // ⑤ 删句：只删咬同伴那句，投票行和正常内容留着
    const mixed = `我是预言家，昨晚验的 ${seat} 号是狼。不过 ${goodSeat} 号那票投得莫名其妙。\n投票：${goodSeat}号`;
    const cleaned = w.stripTeammateAccusation(mixed, state, wolf);
    assert.ok(!new RegExp(`${seat}\\s*号是狼`).test(cleaned), `咬同伴的句子没删掉：${cleaned}`);
    assert.ok(new RegExp(`投票：${goodSeat}号`).test(cleaned), `投票行不该被删：${cleaned}`);
    assert.ok(new RegExp(`${goodSeat} 号那票`).test(cleaned), '其它正常内容不该被删');
  });

  await test('遗言提示词不带死因：当事人只知道"自己出局了"，不知道是被刀还是被毒', () => {
    // 背景（线上实测）：首夜双死时，两个死者的遗言里分别出现了"狼第一刀砍了本座""被毒了啊"——
    // 因为提示词第一行写着"你刚因为「女巫毒杀」出局了"，而遗言是**公开发言**，
    // 等于替女巫宣布毒药已经用掉、解药已经出手（首夜最贵的一条信息）。
    // 现在死因只留在 state 里（player.deadReason，给"猎人能不能开枪 / 局末复盘"用），
    // 绝不进提示词，并且明令禁止当事人自己替法官宣布死因。见 docs/ARCHITECTURE.md 5.9。
    const board = w.boardFor(9);
    const players = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '玩家' + i }));
    const dealt = w.assignRoles(players, board);
    const state = { players: dealt, log: [], seerChecks: [], witch: { antidote: true, poison: true }, day: 1, board };
    const villager = dealt.find((p) => p.team === 'good' && !p.god);
    const wolf = dealt.find((p) => p.team === 'wolf');
    // 死因的"内部标签"：它们只该在引擎里流转，不该出现在任何给模型看的文字里
    const CAUSE = /(女巫毒杀|狼人刀杀|猎人开枪)/;
    for (const [who, tag] of [
      [villager, '好人'],
      [wolf, '狼人'],
    ]) {
      const lw = w.lastWordsPromptFor(state, who);
      assert.ok(!CAUSE.test(lw), `${tag}的遗言提示不该出现死因内部标签：${lw.slice(0, 120)}`);
      assert.ok(/你刚刚出局了/.test(lw), `${tag}的遗言提示要明确告诉他"已经出局"`);
      assert.ok(/没有人知道你是怎么死的/.test(lw), `${tag}的遗言提示要写明"没人知道死因"`);
      assert.ok(/别说/.test(lw) && /别替法官编/.test(lw), `${tag}的遗言提示要禁止他自己宣布/编造死因`);
      // 遗言该说的东西仍然要说（别把提示词删空了）
      assert.ok(/存活玩家|已经公开发生的事/.test(lw), `${tag}的遗言提示仍然要带公开信息`);
    }
    // 兼容性护栏：老签名是 (state, me, cause)。万一以后有人又把 cause 传进来，它也绝不能出现在提示词里。
    const legacy = w.lastWordsPromptFor(state, villager, '女巫毒杀');
    assert.ok(!CAUSE.test(legacy), `多传的 cause 参数漏进了提示词：${legacy.slice(0, 120)}`);
    // 引擎侧仍然记得死因，但提示词**不读它**：把 deadReason 填上死因再问一次，依然一个字都不出现
    villager.deadReason = '女巫毒杀';
    const afterDeath = w.lastWordsPromptFor(state, villager);
    assert.ok(!CAUSE.test(afterDeath), `提示词不能顺着 deadReason 把死因带出来：${afterDeath.slice(0, 120)}`);
    assert.equal(villager.deadReason, '女巫毒杀', '引擎侧的死因要原样留着（猎人开枪判定、局末复盘要用）');
  });

  await test('认狼检测：抓得住自曝，也不误伤正常发言', () => {
    // 真实出现过的两种认狼（截图里的原文）
    assert.equal(w.looksLikeWolfConfession('得，验得准。我是狼人，不冤。'), true, '「我是狼人」要能抓到');
    assert.equal(w.looksLikeWolfConfession('行，那我认了，我是狼——但 9 号你这话得改改。'), true, '「我是狼」要能抓到');
    assert.equal(w.looksLikeWolfConfession('我承认我是狼，你们票我吧'), true);
    assert.equal(w.looksLikeWolfConfession('不装了，我是狼'), true);
    assert.equal(w.looksLikeWolfConfession('我认狼，剩下的你们自己找'), true);
    assert.equal(w.looksLikeWolfConfession('狼人就是我又怎样'), true);
    // 不能误伤的：指认别人、假设句、正常自证
    assert.equal(w.looksLikeWolfConfession('3 号是狼，我投他'), false, '指认别人不该被当成认狼');
    assert.equal(w.looksLikeWolfConfession('如果我是狼，我早就刀你了'), false, '假设句不算认狼');
    assert.equal(w.looksLikeWolfConfession('我是好人，不信你们查我'), false);
    assert.equal(w.looksLikeWolfConfession('我是狼人杀的忠实玩家'), false, '「狼人杀」这个词不该被误判');
    assert.equal(w.looksLikeWolfConfession(''), false);
    // 删句：只删认狼那句，保留其它发言
    const mixed = '我是狼人，不冤。不过 4 号那票投得莫名其妙，你们最好想清楚。';
    const cleaned = w.stripWolfConfession(mixed);
    assert.ok(!/我是狼人/.test(cleaned), `认狼句没被删掉：${cleaned}`);
    assert.ok(/4 号/.test(cleaned), `正常内容不该被一起删掉：${cleaned}`);
    assert.equal(w.stripWolfConfession('我是狼人'), '', '整段都是认狼时应当返回空串（交给上层换场面话）');
  });

  await test('存档：没有存档时 isActive 为 false（浏览器外调用也不报错）', () => {
    assert.equal(w.loadGame('g-x'), null);
    assert.equal(w.isActive('g-x'), false);
    // 门槛算的是"玩家总数（群成员 + 你）"，不是群成员数：
    // 5 位群成员 + 你 = 6 人局，正好是规则文件里的标准 6 人板（2 狼 2 民 预女）
    assert.equal(w.MIN_PLAYERS, 6);
    assert.equal(w.MAX_PLAYERS, 13);
    assert.equal(w.MIN_MEMBERS, 5);
    assert.equal(w.MAX_MEMBERS, 12);
    assert.equal(w.boardFor(w.MIN_PLAYERS).cards.length, 6, '最少的 6 人局要有 6 张牌');
    assert.equal(w.boardFor(w.MAX_PLAYERS).cards.length, 13, '13 人局（12 位群成员 + 你）也要有牌');
  });

  await test('旧存档兼容：缺 voteOpen / voteResult 的存档按阶段补默认值（不把没投完的票当成已公布）', () => {
    // 归一化逻辑住在 loadGame() 里，所以这里临时装一个最小的 localStorage（Node 里没有）
    const box = new Map();
    const orig = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (k) => (box.has(k) ? box.get(k) : null),
      setItem: (k, v) => box.set(k, String(v)),
      removeItem: (k) => box.delete(k),
      key: (i) => [...box.keys()][i] || null,
      get length() {
        return box.size;
      },
    };
    const put = (groupId, st) => globalThis.localStorage.setItem(`aichat.werewolf.${groupId}`, JSON.stringify(st));
    try {
      // ① 落在投票阶段：那一票还没投完 → 票数继续藏着（voteOpen=true），什么都不公布
      put('g-vote', { groupId: 'g-vote', phase: 'vote', day: 2, fastMode: false, voteLive: { 3: 2 }, voteRound: 0 });
      const voting = w.loadGame('g-vote');
      assert.equal(voting.voteOpen, true, '投票阶段的旧存档要按"收票中"算');
      assert.equal(voting.voteResult, null, '收票中不能有"已公布的结果"');
      assert.deepEqual(w.publicVoteTally(voting), {}, '旧存档在投票期间同样不能泄票');

      // ② 快速模式的白天也在收票（票夹在发言里投的）
      put('g-day', { groupId: 'g-day', phase: 'day', day: 2, fastMode: true, voteLive: { 3: 1 } });
      assert.equal(w.loadGame('g-day').voteOpen, true, '快速模式的白天也是收票期');

      // ③ 已经过了投票（标准模式的白天）：voteLive 是上一轮**已公告**的票数 → 接过来当结果
      put('g-after', { groupId: 'g-after', phase: 'day', day: 3, fastMode: false, voteLive: { 3: 2 }, voteRound: 0 });
      const after = w.loadGame('g-after');
      assert.equal(after.voteOpen, false, '白天的旧存档不在收票');
      assert.deepEqual(after.voteResult, { day: 3, round: 0, tally: { 3: 2 } }, '上一轮的票数要接成"投票结果"');
      assert.deepEqual(w.publicVoteTally(after), { 3: 2 });

      // ④ 这一版新写的存档不被改写（归一化只补缺失字段）
      put('g-new', { groupId: 'g-new', phase: 'vote', day: 1, voteLive: { 3: 2 }, voteOpen: false, voteResult: { day: 1, round: 0, tally: { 3: 2, 5: 1 } } });
      assert.deepEqual(w.loadGame('g-new').voteResult, { day: 1, round: 0, tally: { 3: 2, 5: 1 } }, '已有 voteResult 的存档原样读取');
    } finally {
      if (orig === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = orig;
    }
  });

  /** 造一局 9 人牌（座位 1~7 已经发过言），供下面"发言顺序"那几条用例复用 */
  const orderFixture = () => {
    const board = w.boardFor(9);
    const players = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, name: '角色' + (i + 1) }));
    const dealt = w.assignRoles(players, board);
    const state = {
      groupId: 'g-order',
      day: 1,
      phase: 'day',
      players: dealt,
      log: ['【法官】第 1 天发言开始，按座位顺序依次发言。', `1 号 ${dealt[0].name}：我是预言家，昨晚验的 9 号是好人。`],
      // 8 号正在发言：座位 1~7 都已经说过话了
      spokenSeats: dealt.slice(0, 7).map((p) => p.seat),
      seerChecks: [],
      witch: { antidote: true, poison: true },
      board,
    };
    return { state, seats: dealt };
  };

  await test('发言顺序：告诉发言人他是第几位、谁已经说过、谁还没轮到', () => {
    const { state, seats } = orderFixture();
    const me = seats[7]; // 8 号，前面 1~7 都发过言了
    const o = w.speakOrderFor(state, me);
    assert.equal(o.index, 7, `8 号应当是第 8 位发言，实际下标 ${o.index}`);
    assert.deepEqual(o.spokenBefore.map((p) => p.seat), [1, 2, 3, 4, 5, 6, 7], '前面 1~7 号都应当算"已经说过"');
    assert.deepEqual(o.pending.map((p) => p.seat), [9], '9 号排在他后面，还没轮到');

    const note = w.speakOrderNote(state, me);
    assert.ok(/按座位顺序依次发言/.test(note), `顺序说明要写明"按座位顺序依次发言"：${note}`);
    assert.ok(/你是第 8 位/.test(note), `必须告诉发言人自己是第几位：${note}`);
    assert.ok(/已经发过言的是：1 号/.test(note), `要列出已经发过言的人：${note}`);
    assert.ok(/还没轮到的\*\*：9 号/.test(note), `要点明还没轮到的人（这里是 9 号）：${note}`);
    assert.ok(/还没有机会开口/.test(note), '要说清"他们还没有机会开口"，否则模型会当成故意沉默');
    assert.ok(/不要催他们发言/.test(note), '必须明令禁止催还没轮到的人');

    // 第一个发言的人：没有"已经说过"的人，但后面全是"还没轮到"
    const first = w.speakOrderNote({ ...state, spokenSeats: [] }, seats[0]);
    assert.ok(/你是第 1 位/.test(first) && /还没有人说过话/.test(first), `第一个发言人要说得准确：${first}`);
    assert.ok(/还没轮到的\*\*：2 号/.test(first), '第一个发言人的顺序说明里要含 2 号');

    // 最后一个发言的人：身后没有"还没轮到"的人
    const last = w.speakOrderNote({ ...state, spokenSeats: [1, 2, 3, 4, 5, 6, 7, 8] }, seats[8]);
    assert.ok(!/还没轮到的/.test(last), `最后一个发言人身后不该有"还没轮到"的人：${last}`);

    // PK 发言：顺序＝平票座位（不是存活顺序，也不是白天那一轮说过话的人）
    const pkState = { ...state, spokenSeats: [1, 2, 3, 4, 5, 6, 7, 8, 9] };
    const pkNote = w.speakOrderNote(pkState, seats[7], { pkSeats: [3, 5, 8], spoken: [3, 5] });
    assert.ok(/平票 PK 发言/.test(pkNote), `PK 发言要说清这是什么轮次：${pkNote}`);
    assert.ok(/你是第 3 位/.test(pkNote), `PK 顺序里 8 号是第 3 位：${pkNote}`);
    assert.ok(/已经 PK 发言过的是：3 号/.test(pkNote), `PK 已经说过的人只能来自 PK 记录：${pkNote}`);
    assert.ok(!/还没轮到的/.test(pkNote), `8 号是最后一个 PK 发言人：${pkNote}`);

    // 白天发言提示词必须带上这一段（漏了就等于没修）
    const day = w.dayPromptFor(state, me, { withVote: true });
    assert.ok(/【发言顺序（重要）】/.test(day), '白天发言提示词要含【发言顺序】那一段');
    assert.ok(/你是第 8 位/.test(day), '白天发言提示词要说明他是第几位');
    assert.ok(/别催他们/.test(day), '【发言要求】里要再提醒一次"别催还没轮到的人"');
  });

  await test('顺序发言兜底：催"还没轮到的人不说话"会被抓出来并删句，复盘之前几轮不误伤', () => {
    const { state, seats } = orderFixture();
    const me = seats[7]; // 8 号：身后只有 9 号还没轮到
    const urge = `我更想看看 9 号 ${seats[8].name} 怎么接——被人捞了一整轮还不出声，这反倒比 1 号更值得记一笔。`;
    assert.equal(w.looksLikeSilenceUrge(urge, state, me), true, '线上实测那句（8 号质问还没轮到的 9 号）必须被抓到');

    // 已经发过言的人被点评"沉默"是正常打法（1 号确实说过话）→ 不拦
    assert.equal(w.looksLikeSilenceUrge('1 号一直不出声，我看有问题。', state, me), false, '已经发过言的人不该被这条拦住');
    // 复盘之前几轮 → 不拦
    assert.equal(w.looksLikeSilenceUrge('9 号昨天一整轮都没怎么说话。', state, me), false, '带时间标记的复盘不该被拦');
    // 只是说"等我听完再说" → 不拦
    assert.equal(w.looksLikeSilenceUrge('我先听听 9 号怎么说。', state, me), false, '正常的"想听后面的人说"不该被拦');
    // 身后没人了 → 没什么可催的
    assert.equal(w.looksLikeSilenceUrge('9 号怎么不说话。', state, seats[8]), false, '最后一位发言时身后没人，不该判');

    // 删句：只删催人的那句，正常内容与投票行都留着
    const mixed = `${urge}不过 1 号这查得太干净了。\n投票：1号`;
    const cleaned = w.stripSilenceUrge(mixed, state, me);
    assert.ok(!/还不出声/.test(cleaned), `催人的句子要被删掉：${cleaned}`);
    assert.ok(/不过 1 号这查得太干净了。/.test(cleaned), '正常内容要保留');
    assert.ok(/投票：1号/.test(cleaned), '投票行要保留（它单独走投票逻辑）');
  });

  await test('顺序发言兜底（引擎）：先纠正重说，还犯就删句，整段都在催才换成场面话', async () => {
    const { state, seats } = orderFixture();
    const me = seats[7];
    const urge = `我更想看看 9 号 ${seats[8].name} 怎么接——被人捞了一整轮还不出声，这反倒比 1 号更值得记一笔。`;
    const good = '不过我不急着踩他，1 号这查得太干净了。\n投票：1号';
    const game = new w.WerewolfGame({ group: { id: 'g-order', name: 't' }, members: [], state, human: {}, handlers: {} });

    // ① 模型第一次就催人 → 引擎点名纠正，重说的那条被采用
    const prompts = [];
    game.askLLM = async (player, prompt) => {
      prompts.push(prompt);
      return /【重要纠正】/.test(prompt) ? good : urge;
    };
    const turn = await game.speakTurn(me, { withVote: true });
    assert.equal(prompts.length, 2, `催人后应当纠正重说一次（共 2 次调用），实际 ${prompts.length} 次`);
    assert.ok(/【重要纠正】/.test(prompts[1]), '第二次提问要带【重要纠正】段');
    assert.ok(/9 号/.test(prompts[1]), `纠正段要点名"还没轮到的"是谁：${prompts[1].slice(-160)}`);
    assert.ok(/还没有机会开口/.test(prompts[1]), '纠正段要说清他们还没机会开口');
    assert.equal(turn.speech, good.split('\n')[0], `应当采用重说的发言，实际 ${JSON.stringify(turn.speech)}`);
    assert.equal(turn.vote, 1, '重说的投票行要照常解析出来');
    // 第一次的提示词里必须带着顺序说明（这是主防线）
    assert.ok(/【发言顺序（重要）】/.test(prompts[0]) && /你是第 8 位/.test(prompts[0]), '发言提示词里要有顺序说明');

    // ② 重说还在催 → 把那一句删掉；整段都被删光时换成场面话，但**票不能丢**
    const urgeWithVote = `${urge}\n投票：1号`;
    game.askLLM = async () => urgeWithVote;
    const stuck = await game.speakTurn(me, { withVote: true });
    assert.ok(stuck.speech && !/还不出声/.test(stuck.speech), `重说仍是催人时必须把句子清掉，实际 ${JSON.stringify(stuck.speech)}`);
    assert.equal(stuck.vote, 1, `换成场面话之后投票行也要留着，实际 ${JSON.stringify(stuck.vote)}`);

    // ③ 人类玩家想说什么是他的自由，引擎不改
    game.askLLM = async () => {
      throw new Error('不该给人类玩家补问');
    };
    assert.equal(await game.guardSilenceUrge({ ...me, isUser: true }, urge, 'p', {}), urge, '人类玩家的发言不该被改写');

    // ④ PK 发言同样带顺序说明（顺序＝平票座位，不是存活顺序）
    const pkPrompts = [];
    game.askLLM = async (player, prompt) => {
      pkPrompts.push(prompt);
      return '我没什么要补充的。';
    };
    await game.speakTurn(seats[4], { withVote: false, pk: true, pkSeats: [3, 5, 9], spoken: [3] });
    assert.ok(/平票 PK 发言/.test(pkPrompts[0]), `PK 发言提示词要说清是 PK 轮：${pkPrompts[0].slice(0, 200)}`);
    assert.ok(/你是第 2 位/.test(pkPrompts[0]), 'PK 顺序里 5 号是第 2 位（按平票座位排）');
    assert.ok(/还没轮到的\*\*：9 号/.test(pkPrompts[0]), 'PK 里 9 号还没轮到');
  });
}

console.log('\n=== 6. core/runtime.js（纯函数部分）===');{
  const r = await load('core/runtime.js');
  await test('affinityLabel 分段正确', () => {
    assert.equal(r.affinityLabel(5), '陌生');
    assert.equal(r.affinityLabel(25), '认识');
    assert.equal(r.affinityLabel(45), '熟络');
    assert.equal(r.affinityLabel(65), '亲近');
    assert.equal(r.affinityLabel(80), '交心');
    assert.equal(r.affinityLabel(100), '心意相通');
  });
  await test('detectEmotion 识别常见情绪', () => {
    assert.equal(r.detectEmotion('气死我了，别烦我'), 'angry');
    assert.equal(r.detectEmotion('今天好开心呀'), 'happy');
    assert.equal(r.detectEmotion('我有点难过'), 'sad');
    assert.equal(r.detectEmotion('嗯'), 'neutral');
  });
  await test('inQuietHours 跨午夜判断', () => {
    assert.equal(typeof r.inQuietHours(23, 7), 'boolean');
    assert.equal(r.inQuietHours(9, 9), false);
  });
  await test('daysSince / gapDescription', () => {
    assert.equal(r.daysSince(null), -1);
    assert.equal(r.daysSince(Date.now()), 0);
    assert.ok(r.gapDescription(Date.now() - 3 * 86400000).includes('天'));
  });
}

console.log('\n=== 6.1 运行时冲突合并与代理请求（回归）===');
{
  const file = await load('core/filestore.js');
  await test('好感度允许下降：磁盘较新时不得被浏览器旧值抬高', () => {
    const id = 'c_runtime_check';
    const merged = file.mergeRuntimeSnapshots(
      { [id]: { affinity: 50, updatedAt: 100 } },
      { [id]: { affinity: 49, updatedAt: 200 } },
      new Set([id])
    );
    assert.equal(merged[id].affinity, 49);
    assert.equal(file.mergeRuntimeSnapshots(
      { [id]: { affinity: 48, updatedAt: 300 } },
      { [id]: { affinity: 49, updatedAt: 200 } }
    )[id].affinity, 48, '浏览器较新且未写盘时应保留本地值');
    assert.equal(file.mergeRuntimeSnapshots(
      { [id]: { affinity: 50 } }, { [id]: { affinity: 49 } }
    )[id].affinity, 49, '旧版无时间戳时应遵守磁盘优先');
  });

  const llm = await load('core/llm.js');
  await test('DeepSeek 请求级思考开关：直连只对 DeepSeek 下发', async () => {
    const oldFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await llm.chat({
        provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test-key',
        messages: [{ role: 'user', content: '测试' }], params: { thinking: false },
      });
      await llm.chat({
        provider: 'custom', model: 'custom-model', apiKey: 'test-key', baseUrl: 'https://example.invalid/v1',
        messages: [{ role: 'user', content: '测试' }], params: { thinking: false },
      });
      assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
      assert.equal(Object.hasOwn(requests[1].body, 'thinking'), false, '非 DeepSeek 不应收到专用字段');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('DeepSeek 旧模型名透明迁移且保留思考语义', async () => {
    const oldFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      await llm.chat({
        provider: 'deepseek', model: 'deepseek-chat', apiKey: 'test-key',
        messages: [{ role: 'user', content: '测试' }],
      });
      await llm.chat({
        provider: 'deepseek', model: 'deepseek-reasoner', apiKey: 'test-key',
        messages: [{ role: 'user', content: '测试' }],
      });
      assert.equal(requests[0].model, 'deepseek-flash');
      assert.deepEqual(requests[0].thinking, { type: 'disabled' });
      assert.equal(requests[1].model, 'deepseek-flash');
      assert.deepEqual(requests[1].thinking, { type: 'enabled' });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('思考模式三态：设置里的「跟随模型默认」不下发 thinking（见 5.19）', async () => {
    const models = await load('data/models.js');
    const store = await load('core/store.js');

    // 三态映射是纯函数：界面只调它，不在 ui/settings.js 里另写一套 if
    assert.equal(models.thinkingChoiceOf({}), 'default', '未设置应视为「跟随模型默认」');
    assert.equal(models.thinkingChoiceOf({ thinking: null }), 'default');
    assert.equal(models.thinkingChoiceOf({ thinking: true }), 'on');
    assert.equal(models.thinkingChoiceOf({ thinking: false }), 'off');
    assert.equal(models.thinkingChoiceOf({ thinking: 'yes' }), 'default', '非布尔值一律当默认（脏设置不该让请求变成 enabled）');
    assert.equal(models.thinkingParamOf('on'), true);
    assert.equal(models.thinkingParamOf('off'), false);
    assert.equal(models.thinkingParamOf('default'), null);
    assert.equal(models.thinkingParamOf(undefined), null);
    // 三态必须能原样往返（否则"选完弹回去"或"选默认变成关思考"）
    assert.equal(models.THINKING_CHOICES.length, 3, '三态选项应当是 3 个');
    for (const c of models.THINKING_CHOICES) {
      assert.equal(models.thinkingChoiceOf({ thinking: models.thinkingParamOf(c.value) }), c.value, `选项 ${c.value} 往返不一致`);
    }
    for (const c of models.THINKING_CHOICES) {
      assert.ok(
        typeof c.label === 'string' && c.label.length > 0 && typeof c.desc === 'string' && c.desc.length > 0,
        `选项 ${c.value} 缺少 label/desc`
      );
    }

    // 默认设置（params.thinking = null）必须**不带** thinking 字段：这就是"跟随模型默认"
    const oldFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const base = { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test-key', messages: [{ role: 'user', content: '测试' }] };
      assert.equal(store.DEFAULT_SETTINGS.params.thinking, null, '默认设置应当是「跟随模型默认」');
      await llm.chat({ ...base, params: { ...store.DEFAULT_SETTINGS.params } });
      await llm.chat({ ...base, params: { ...store.DEFAULT_SETTINGS.params, thinking: models.thinkingParamOf('off') } });
      await llm.chat({ ...base, params: { ...store.DEFAULT_SETTINGS.params, thinking: models.thinkingParamOf('on') } });
      assert.equal(Object.hasOwn(requests[0], 'thinking'), false, '「跟随模型默认」不该下发 thinking（下发就等于替用户做了决定）');
      assert.deepEqual(requests[1].thinking, { type: 'disabled' });
      assert.deepEqual(requests[2].thinking, { type: 'enabled' });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('狼人杀自检关闭思考并保留 256 token 余量', async () => {
    const oldFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '我准备好了' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const werewolf = await load('core/werewolf.js');
      const result = await werewolf.preflight({
        provider: 'deepseek', model: 'deepseek-flash', apiKeys: { deepseek: 'test-key' }, useProxy: false,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(request.body.thinking, { type: 'disabled' });
      assert.equal(request.body.max_tokens, 256);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('截断判定：只认 length / max_tokens 一族', () => {
    for (const r of ['length', 'max_tokens', 'MAX_TOKENS', 'max_output_tokens', 'token_limit']) {
      assert.equal(llm.isTruncatedFinish(r), true, `${r} 应当判为截断`);
    }
    for (const r of ['stop', 'end_turn', 'STOP', 'tool_calls', '']) {
      assert.equal(llm.isTruncatedFinish(r), false, `${r} 不该判为截断`);
    }
  });

  await test('chat()：finish_reason=length 上报为 truncated', async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '半句话，枪口' }, finish_reason: 'length' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    try {
      const r = await llm.chat({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', messages: [{ role: 'user', content: 'x' }] });
      assert.equal(r.text, '半句话，枪口');
      assert.equal(r.finishReason, 'length');
      assert.equal(r.truncated, true, '被截断必须能上报，否则上层只能把半句当完整发言');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('chatStream()：finish_reason 单独一个收尾 chunk 时也能识别', async () => {
    const oldFetch = globalThis.fetch;
    // 真实供应商就是这么收尾的：最后那个事件只有 finish_reason，没有正文增量
    const sse = [
      'data: {"choices":[{"delta":{"content":"半句话，枪口"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    globalThis.fetch = async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    try {
      const r = await llm.chatStream(
        { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'k', stream: true, messages: [{ role: 'user', content: 'x' }] },
        {}
      );
      assert.equal(r.text, '半句话，枪口');
      assert.equal(r.finishReason, 'length');
      assert.equal(r.truncated, true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('markTruncatedTail：半句补"……"，说完的话与完整指令不动', async () => {
    const werewolf = await load('core/werewolf.js');
    assert.equal(werewolf.markTruncatedTail('4 号、5 号互相开了一枪，枪口'), '4 号、5 号互相开了一枪，枪口……');
    assert.equal(werewolf.markTruncatedTail('我这'), '我这……');
    assert.equal(werewolf.markTruncatedTail('我说完了。'), '我说完了。');
    assert.equal(werewolf.markTruncatedTail('我说完了……'), '我说完了……');
    assert.equal(werewolf.markTruncatedTail('投票：3号'), '投票：3号', '完整指令不该被补尾巴');
    assert.equal(werewolf.markTruncatedTail('投票：弃票'), '投票：弃票');
    assert.equal(werewolf.markTruncatedTail('我先听听。\n投票：3号'), '我先听听。\n投票：3号');
    assert.equal(werewolf.markTruncatedTail('刀杀：5号'), '刀杀：5号');
    // 收在表情上的正常发言（实测真的有角色以"且尽此杯。🍶"收尾）不该被画蛇添足
    assert.equal(werewolf.markTruncatedTail('且尽此杯。🍶'), '且尽此杯。🍶');
    assert.equal(werewolf.markTruncatedTail('我是 2 号'), '我是 2 号……');
    assert.equal(werewolf.markTruncatedTail(''), '');
  });

  await test('needsUnfinishedMark：只有"以汉字收尾"才算没说完', async () => {
    const werewolf = await load('core/werewolf.js');
    assert.equal(werewolf.needsUnfinishedMark('枪口'), true);
    assert.equal(werewolf.needsUnfinishedMark('我这\n'), true);
    assert.equal(werewolf.needsUnfinishedMark('我记着。'), false);
    assert.equal(werewolf.needsUnfinishedMark('且尽此杯。🍶'), false);
    assert.equal(werewolf.needsUnfinishedMark('投票：3号'), false);
    assert.equal(werewolf.needsUnfinishedMark(''), false);
  });

  await test('被看门狗掐断时留下的半句同样标注"没说完"（且不重试）', async () => {
    const werewolf = await load('core/werewolf.js');
    const oldFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls += 1;
      const signal = init && init.signal;
      const enc = new TextEncoder();
      // 吐出一段半句话之后**永久沉默**，并且像真实网络那样：请求被 abort 时把流打成错误
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"我是 2 号，先说一句，枪口"}}]}\n\n'));
          const kill = () => {
            try {
              controller.error(new DOMException('aborted', 'AbortError'));
            } catch {
              /* 已经关掉了 */
            }
          };
          if (signal) {
            if (signal.aborted) kill();
            else signal.addEventListener('abort', kill);
          }
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    try {
      const members = [];
      for (let i = 1; i <= 11; i += 1) members.push({ id: `c_wq_${i}`, name: `成员${i}` });
      const game = new werewolf.WerewolfGame({
        group: { id: 'g_ww_stall', name: '测试群' },
        members,
        settings: { provider: 'deepseek', model: 'deepseek-flash', apiKeys: { deepseek: 'k' }, useProxy: false, params: {} },
        userName: '我',
        human: {},
        handlers: {},
        askTimeoutMs: 120, // 单次调用的看门狗：120ms 没有新内容就掐断
      });
      const me = game.state.players.find((p) => !p.isUser);
      const text = await game.askLLM(me, werewolf.dayPromptFor(game.state, me), 'day', { live: true });
      assert.ok(text.startsWith('我是 2 号'), `掐断前吐出的内容应当保留，实际 ${JSON.stringify(text)}`);
      assert.ok(text.endsWith('……'), `被掐断的半句必须标成"没说完"，实际 ${JSON.stringify(text)}`);
      assert.equal(calls, 1, '掐断后不该再白试一次非流式');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('狼人杀白天发言：关思考，且被截断时放宽额度重问并采用完整版', async () => {
    const werewolf = await load('core/werewolf.js');
    const oldFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const truncated = bodies.length === 1; // 第一次故意切在句子中间
      const text = truncated
        ? '我是 2 号，先说我的看法：5 号那几句我听不出逻辑，枪口'
        : '我是 2 号，我先说说我的看法。\n投票：5号';
      const sse = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: truncated ? 'length' : 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    try {
      const members = [];
      for (let i = 1; i <= 11; i += 1) members.push({ id: `c_ww_${i}`, name: `成员${i}` });
      const game = new werewolf.WerewolfGame({
        group: { id: 'g_ww_selftest', name: '测试群' },
        members,
        settings: { provider: 'deepseek', model: 'deepseek-flash', apiKeys: { deepseek: 'k' }, useProxy: false, params: {} },
        userName: '我',
        human: {},
        handlers: {},
      });
      const me = game.state.players.find((p) => !p.isUser);
      const text = await game.askLLM(me, werewolf.dayPromptFor(game.state, me), 'day', { live: true });
      assert.equal(bodies.length, 2, `被截断应当重问一次，实际发了 ${bodies.length} 次请求`);
      assert.deepEqual(bodies[0].thinking, { type: 'disabled' }, '白天发言也必须关掉思考（思考会与正文抢 max_tokens）');
      assert.equal(bodies[0].max_tokens, 600, '白天发言的默认额度');
      assert.ok(bodies[1].max_tokens > 600, `重问应当放宽额度，实际 ${bodies[1].max_tokens}`);
      assert.ok(/投票/.test(text), `应当采用重问拿到的完整版，实际 ${JSON.stringify(text)}`);
      assert.ok(!/枪口$/.test(text.trim()), `不该把半句当完整发言，实际 ${JSON.stringify(text)}`);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('代理对话只发送自定义地址，并用请求头携带可选口令', async () => {
    const oldFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await llm.chat({
        provider: 'deepseek', model: 'deepseek-chat', useProxy: true, proxyToken: 'test-token',
        messages: [{ role: 'user', content: '你好' }],
      });
      assert.equal(result.text, 'ok');
      assert.equal(request.url, '/api/llm');
      assert.equal(request.init.headers['X-Aichat-Token'], 'test-token');
      assert.equal(Object.hasOwn(JSON.parse(request.init.body), 'baseUrl'), false, '默认地址不应作为覆盖地址发送');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  await test('代理模式获取模型列表走 /api/models 而非浏览器直连', async () => {
    const oldFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ models: ['server-model'] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      assert.deepEqual(await llm.listModels('openai', '', '', { useProxy: true }), ['server-model']);
      assert.equal(request.url, '/api/models');
      assert.equal(JSON.parse(request.init.body).baseUrl, '');
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
}

console.log('\n=== 7. data/templates.js ===');
{
  let t = null;
  try {
    t = await load('data/templates.js');
  } catch (err) {
    console.log(`  ! 模板库暂时无法加载：${err.message}`);
  }
  if (t) {
    await test('模板数量与分组', () => {
      assert.ok(Array.isArray(t.CHARACTER_TEMPLATES), 'CHARACTER_TEMPLATES 不是数组');
      assert.ok(t.CHARACTER_TEMPLATES.length >= 30, `模板只有 ${t.CHARACTER_TEMPLATES.length} 个，要求 ≥30`);
      assert.ok(t.TEMPLATE_GROUPS.length >= 7, `分组只有 ${t.TEMPLATE_GROUPS.length} 个`);
    });
    await test('每个模板结构完整、id 唯一', () => {
      const ids = new Set();
      for (const tpl of t.CHARACTER_TEMPLATES) {
        assert.ok(tpl.id && !ids.has(tpl.id), `模板 id 重复或缺失：${tpl.id}`);
        ids.add(tpl.id);
        assert.ok(tpl.name, `${tpl.id} 缺 name`);
        assert.ok(tpl.templateName, `${tpl.id} 缺 templateName`);
        assert.ok(tpl.group, `${tpl.id} 缺 group`);
        assert.ok(Array.isArray(tpl.greeting) && tpl.greeting.length >= 1, `${tpl.id} greeting 不足`);
        assert.ok(tpl.persona && typeof tpl.persona === 'object', `${tpl.id} 缺 persona`);
      }
    });
    await test('templateToCharacter 产出合法角色卡', async () => {
      const s = await load('core/store.js');
      const tpl = t.CHARACTER_TEMPLATES[0];
      const c = s.normalizeCharacter(t.templateToCharacter(tpl));
      assert.ok(c.id && c.name);
      assert.ok(typeof c.greeting[0] === 'string' && c.greeting[0].length > 0);
      assert.ok(c.voice && typeof c.voice.rate === 'number');
    });
  }
}

console.log('\n=== 7.5 世界书：切换世界时替换旧条目 ===');
{
  const t = await load('data/templates.js');
  await test('换世界会清掉上一个世界的条目（手写条目保留）', () => {
    const A = t.WORLD_PRESETS[0];
    const B = t.WORLD_PRESETS[1];
    const manual = { keys: ['手写'], content: '我自己写的一条', enabled: true };
    const base = { persona: { world: '' }, lorebook: [manual] };
    const s1 = t.applyWorldPreset(base, A.id);
    assert.equal(s1.lorebook.length, A.lorebook.length + 1, '首次套用应等于 预设条目 + 手写');
    const s2 = t.applyWorldPreset(s1, B.id);
    assert.equal(s2.lorebook.length, B.lorebook.length + 1, '换世界后条目数应为 新预设 + 手写');
    const leak = s2.lorebook.filter((l) => A.lorebook.some((x) => x.content === l.content));
    assert.equal(leak.length, 0, `换世界后仍残留 ${leak.length} 条旧世界设定`);
    assert.ok(s2.lorebook.some((l) => l.content === manual.content), '手写条目被误删');
    assert.ok(s2.lorebook.some((l) => l.content === B.lorebook[0].content), '新世界条目不齐');
  });

  await test('重复套用同一世界不产生重复条目', () => {
    const A = t.WORLD_PRESETS[2];
    const base = { persona: { world: '' }, lorebook: [] };
    const once = t.applyWorldPreset(base, A.id);
    const twice = t.applyWorldPreset(once, A.id);
    assert.equal(twice.lorebook.length, once.lorebook.length, '重复套用产生了重复条目');
  });

  await test('loreMode:merge 保留旧世界条目（需要合并时用）', () => {
    const A = t.WORLD_PRESETS[0];
    const B = t.WORLD_PRESETS[1];
    const base = { persona: { world: '' }, lorebook: [] };
    const s1 = t.applyWorldPreset(base, A.id);
    const merged = t.applyWorldPreset(s1, B.id, { loreMode: 'merge' });
    assert.equal(merged.lorebook.length, A.lorebook.length + B.lorebook.length, 'merge 模式应保留两套');
  });

  await test('清空世界：world 置空，只移除预设条目', () => {
    const A = t.WORLD_PRESETS[0];
    const manual = { keys: ['手写'], content: '我自己写的一条', enabled: true };
    const s1 = t.applyWorldPreset({ persona: { world: '' }, lorebook: [manual] }, A.id);
    const cleared = t.applyWorldPreset(s1, '');
    assert.equal(cleared.persona.world, '', 'world 没有被置空');
    assert.equal(cleared.lorebook.length, 1, '清空后应只剩手写条目');
    assert.equal(cleared.lorebook[0].content, manual.content, '手写条目被误删');
  });

  await test('world 是自定义文案时保守保留条目', () => {
    const A = t.WORLD_PRESETS[0];
    const custom = { persona: { world: '我自己编的世界' }, lorebook: [{ keys: ['自定义'], content: '自定义条目', enabled: true }] };
    const out = t.applyWorldPreset(custom, A.id);
    assert.ok(out.lorebook.some((l) => l.content === '自定义条目'), '自定义来源的条目被误删');
  });
}

console.log('\n=== 7.5 模块健康检查（引用完整性）===');
{
  // 为什么需要这一节：`node --check` 只查语法，查不出"删了函数却忘了 import"这类
  // 引用错误 —— 曾经 core/llm.js 的 dayKey 被误删且没补 import，语法完全正常，
  // 直到某条不相干的界面断言失败才暴露出来。这里对每个模块做一次真加载，
  // 并调用几个纯函数，确保没有 ReferenceError / is not a function。
  const healthTargets = [
    ['core/util.js', (m) => [m.dayKey(Date.now()), m.moodZh('happy'), m.firstChar('🕳️'), m.safeCostWith(() => 1, 'a', 'b', {})]],
    ['core/llm.js', (m) => [typeof m.getUsage, m.estimateCost('openai', 'gpt-4o-mini', { prompt: 100, completion: 50 })]],
    ['core/prompt.js', (m) => [m.buildSystemPrompt({ name: 'X', persona: {} }, { settings: {}, memory: {}, runtime: {} }).length > 0]],
    ['core/runtime.js', (m) => [m.affinityLabel(50), m.detectEmotion('开心')]],
    ['core/store.js', (m) => [m.normalizeCharacter({ name: 'X' }).name, m.getSettings().theme]],
    ['core/group.js', (m) => [typeof m.planSpeakers, typeof m.buildGroupMessages]],
    ['voice/splitter.js', (m) => [m.createSplitter().push('你好。').length >= 1]],
    ['voice/tts.js', (m) => [m.voiceFor({ voice: {} }, { voice: {} }).provider]],
    ['ui/shared.js', (m) => [m.isImageAvatar('/x.png'), m.entityEmoji({ name: '林晚', emoji: '🕳️' }), m.readLS('__nope__', 'x')]],
    ['ui/dom.js', (m) => [typeof m.el]],
    ['ui/icons.js', (m) => [typeof m.icon]],
  ];
  for (const [file, probe] of healthTargets) {
    await test(`${file} 可加载且关键函数可调用`, async () => {
      const m = await load(file);
      let out;
      try {
        out = probe(m);
      } catch (err) {
        throw new Error(`调用失败：${err.message}`);
      }
      assert.ok(Array.isArray(out), '探针返回异常');
      assert.ok(out.every((v) => v !== undefined), `有函数返回 undefined：${JSON.stringify(out)}`);
    });
  }
}

console.log('\n=== 7.6 云端语音配置：密钥与地址必须跟着所选供应商 ===');
{
  const tts = await load('voice/tts.js');

  await test('cloudConfig：选了 Qwen 就绝不用 OpenAI 的密钥与地址', () => {
    // 回归守（跨供应商泄露密钥 + 请求错服务商）：曾经这里是
    //   apiKey  = v.apiKey || keys[provider] || keys.openai
    //   baseUrl = v.baseUrl || urls[provider] || urls.openai
    // 于是"选了 Qwen 但没填 Qwen 密钥"时，一把 OpenAI 的密钥被发到 Qwen 的接口上。
    const c = tts.cloudConfig({
      provider: 'deepseek',
      apiKeys: { openai: 'sk-openai-LEAK', deepseek: 'sk-deepseek' },
      baseUrls: { openai: 'https://proxy.example.com/openai/v1' },
      voice: { ttsProvider: 'qwen' },
    });
    assert.equal(c.provider, 'qwen', `provider 解析错了：${c.provider}`);
    assert.equal(c.apiKey, '', `不该退回 OpenAI 的密钥，实际拿到：${c.apiKey}`);
    assert.ok(!c.baseUrl.includes('proxy.example.com'), `不该退回 OpenAI 的反代地址：${c.baseUrl}`);
    assert.equal(c.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1', `应使用 Qwen 官方地址，实际 ${c.baseUrl}`);
    assert.equal(c.overrideBaseUrl, '', '代理请求不应把官方默认地址误当用户覆盖地址');
  });

  await test('cloudConfig：认所选供应商自己的密钥与反代地址', () => {
    const c = tts.cloudConfig({
      provider: 'deepseek',
      apiKeys: { openai: 'sk-openai', qwen: 'sk-qwen' },
      baseUrls: { openai: 'https://proxy.example.com/openai/v1', qwen: 'https://my-relay.local/qwen/v1' },
      voice: { ttsProvider: 'qwen' },
    });
    assert.equal(c.apiKey, 'sk-qwen', `应取 Qwen 的密钥，实际 ${c.apiKey}`);
    assert.equal(c.baseUrl, 'https://my-relay.local/qwen/v1', `应取 Qwen 的反代地址，实际 ${c.baseUrl}`);
    assert.equal(c.overrideBaseUrl, c.baseUrl, '自定义地址应交给代理并接受白名单校验');
  });

  await test('cloudConfig：custom 没填地址时留空（不偷偷打到 OpenAI）', () => {
    const c = tts.cloudConfig({ apiKeys: { custom: 'sk-x' }, voice: { ttsProvider: 'custom' } });
    assert.equal(c.baseUrl, '', `custom 没有地址时应留空，实际 ${c.baseUrl}`);
    assert.ok(!c.baseUrl.includes('openai'), '不能回落到 OpenAI 地址');
  });

  await test('cloudConfig：本地服务不需要密钥（needKey=false）', () => {
    const ollama = tts.cloudConfig({ voice: { ttsProvider: 'ollama' } });
    assert.equal(ollama.needKey, false, 'ollama 不该要求密钥');
    assert.equal(ollama.baseUrl, 'http://127.0.0.1:11434/v1');
    const openai = tts.cloudConfig({ voice: { ttsProvider: 'openai' } });
    assert.equal(openai.needKey, true, 'openai 必须要求密钥');
    assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
  });

  await test('cloudConfig：供应商中文名用于错误提示', () => {
    const c = tts.cloudConfig({ voice: { ttsProvider: 'qwen' } });
    assert.ok(c.label && c.label.includes('通义'), `label 应给出中文名，实际 ${c.label}`);
  });

  await test('captureVoiceError：取回云端失败原因（speak 永不 reject 的补偿）', async () => {
    // 背景：speaker.speak() 云端失败时会静默降级到浏览器内置，Promise 也不会 reject，
    // 所以"试听"按钮只能靠 cfg.onError 把原因取回来，否则用户只看到"点了没反应"。
    const shared = await load('ui/shared.js');
    const cfg = { provider: 'cloud' };
    const why = shared.captureVoiceError(cfg);
    assert.equal(typeof cfg.onError, 'function', '云端配置必须被挂上 onError');
    assert.equal(why(), '', '还没失败时不该有原因');
    cfg.onError(new Error('还没有为「通义千问（Qwen）」配置 API Key'));
    assert.match(why(), /通义千问/, `原因没取回来：${why()}`);
    // 浏览器内置没有"失败原因"这回事，不该被挂钩子
    const local = { provider: 'webspeech' };
    assert.equal(shared.captureVoiceError(local)(), '');
    assert.equal(local.onError, undefined, '非云端不该挂 onError');
  });
}

console.log('\n=== 7.7 诊断工具：CDP 超时兜底与空闲端口（tools/cdp.mjs）===');
{
  // 这一节守的是"测试工具自身"的可靠性（P2）：
  //   ① CDP 调用超时后必须清掉待办、并让浏览器停下当前执行（否则页面里那段脚本还在跑，
  //      下一条用例跟着超时 —— 就是"一超时就连片超时"）；
  //   ② 正常返回时必须清掉超时定时器（一次狼人杀用例上千条命令，每条留一个 120s 定时器
  //      会一直堆在事件循环里）；
  //   ③ freePort() 要真的给出一个能监听的端口（测试脚本不能再靠"基址+随机数"撞端口）。
  const { Cdp, freePort } = await import(new URL('../tools/cdp.mjs', import.meta.url).href);

  /** 假的调试 socket：记录发出去的命令，并允许测试手动触发回包 */
  function fakeWs() {
    const sent = [];
    const listeners = {};
    return {
      sent,
      addEventListener(ev, fn) {
        (listeners[ev] = listeners[ev] || []).push(fn);
      },
      send(s) {
        sent.push(JSON.parse(s));
      },
      reply(obj) {
        for (const fn of listeners.message || []) fn({ data: JSON.stringify(obj) });
      },
    };
  }

  await test('CDP 超时：reject + 清空待办 + 要求浏览器停止执行', async () => {
    const ws = fakeWs();
    const cdp = new Cdp(ws, { timeoutMs: 40 });
    await assert.rejects(cdp.send('Runtime.evaluate', { expression: 'while(1){}' }, 'sess-1'), /CDP 调用超时/);
    assert.equal(cdp.pending.size, 0, '超时后 pending 里还留着这条调用');
    const term = ws.sent.find((m) => m.method === 'Runtime.terminateExecution');
    assert.ok(term, '超时后没有要求浏览器停止执行（页面里的脚本会继续跑）');
    assert.equal(term.sessionId, 'sess-1', 'terminateExecution 没带会话 id');
  });

  await test('CDP 正常返回：清掉超时定时器，不会事后误报超时', async () => {
    const ws = fakeWs();
    const cdp = new Cdp(ws, { timeoutMs: 40 });
    const p = cdp.send('Runtime.evaluate', { expression: '1+1' }, 's1');
    const id = ws.sent[0].id;
    ws.reply({ id, result: { value: 2 } });
    assert.deepEqual(await p, { value: 2 }, '返回值没透传');
    assert.equal(cdp.pending.size, 0, 'resolve 之后仍有挂起的调用');
    await new Promise((r) => setTimeout(r, 90)); // 超过 timeoutMs
    assert.equal(
      ws.sent.filter((m) => m.method === 'Runtime.terminateExecution').length,
      0,
      '已经返回的调用事后又触发了超时兜底（定时器没清）'
    );
  });

  await test('CDP 出错：reject 且同样清掉定时器', async () => {
    const ws = fakeWs();
    const cdp = new Cdp(ws, { timeoutMs: 40 });
    const p = cdp.send('Runtime.evaluate', {}, 's2');
    const id = ws.sent[0].id;
    ws.reply({ id, error: { message: 'boom', code: -32000 } });
    await assert.rejects(p, /boom/);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(ws.sent.filter((m) => m.method === 'Runtime.terminateExecution').length, 0, '出错后仍触发了超时兜底');
  });

  await test('freePort() 给出的端口可以被真正监听', async () => {
    const net = await import('node:net');
    const port = await freePort();
    assert.ok(port > 0 && port < 65536, `端口不合法：${port}`);
    const srv = net.createServer();
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((r) => srv.close(r));
  });
}

console.log('\n=== 8. 模块导出契约核对 ===');
{
  const expectations = {
    'core/bus.js': ['bus'],
    'core/util.js': [
      'createId', 'uid', 'debounce', 'throttle', 'escapeHtml', 'clsx', 'hashCode', 'pick', 'sleep',
      'clamp', 'fmtTime', 'fmtDay', 'fmtDate', 'relTime', 'isSameDay', 'timeContext', 'num',
      'estimateTokens', 'countChars', 'download', 'readFileAsText', 'readFileAsDataURL', 'copyText',
      'firstChar', 'truncate', 'stripMarkdown',
    ],
    'core/store.js': [
      'listCharacters', 'getCharacter', 'saveCharacter', 'deleteCharacter', 'duplicateCharacter',
      'importCharacter', 'toSillyTavern', 'listMessages', 'appendMessage', 'updateMessage',
      'deleteMessage', 'deleteMessages', 'clearMessages', 'searchMessages', 'getMessage',
      'getMemory', 'saveMemory', 'getSettings', 'setSettings', 'resetSettings', 'exportAll',
      'importAll', 'wipeAll', 'dbStats', 'openDB', 'normalizeCharacter',
      // 群聊
      'normalizeGroup', 'listGroups', 'getGroup', 'saveGroup', 'deleteGroup', 'duplicateGroup',
      'setGroupMembers', 'pruneGroupMembers', 'listGroupMessages', 'appendGroupMessage',
      'updateGroupMessage', 'deleteGroupMessage', 'clearGroupMessages', 'getGroupMessage',
      'countByGroup', 'listGroupRecent', 'searchGroupMessages', 'GROUP_TURN_MODES', 'DEFAULT_GROUP',
      // 收藏夹（私聊 + 群聊合并）
      'listBookmarks', 'countBookmarks',
    ],
    'core/runtime.js': [
      'getRuntime', 'setRuntime', 'bumpAffinity', 'markRead', 'unreadTotal', 'initCharacterRuntime',
      'affinityLabel', 'detectEmotion', 'setMood', 'daysSince',
    ],
    'core/prompt.js': ['buildSystemPrompt', 'buildMessages', 'summarizeIfNeeded', 'rebuildMemory', 'matchLore'],
    'core/group.js': [
      'TURN_MODES', 'USER_SPEAKER', 'GroupRound', 'runGroupRound', 'planSpeakers', 'buildGroupMessages',
      'mentionTargets', 'formatTranscript', 'relevanceScore', 'stripSpeakerPrefix', 'lastSpeakerId',
      'memberName', 'memberEmoji',
    ],
    'core/llm.js': [
      'PROVIDERS', 'chat', 'chatStream', 'listModels', 'estimateCost', 'addUsage', 'getUsage',
      'clearUsage', 'abortController', 'llmErrors', 'isTruncatedFinish',
    ],
    'core/proactive.js': ['initProactive', 'maybeTrigger', 'stopProactive'],
    'data/models.js': ['PROVIDERS_META', 'DEFAULT_PRESETS', 'MODEL_PRICING', 'CHAT_MODELS', 'getProvider', 'PARAM_HINTS',
      // 思考模式三态（见 docs/ARCHITECTURE.md 5.19）：界面只走这两个映射 + 一份选项表
      'THINKING_CHOICES', 'thinkingChoiceOf', 'thinkingParamOf'],
    'data/templates.js': ['TEMPLATE_GROUPS', 'CHARACTER_TEMPLATES', 'templatesByGroup', 'getTemplate', 'templateToCharacter'],
    'voice/splitter.js': ['createSplitter'],
    'voice/tts.js': ['SpeechQueue', 'speaker', 'speakText', 'stopSpeaking', 'voiceAvailable', 'voiceFor', 'clearVoiceCache',
      'CLOUD_VOICE_PRESETS', 'CLOUD_TTS_MODELS'],
    'ui/shared.js': ['presetCombo'],
    'voice/stt.js': ['sttAvailable', 'createRecognizer'],
    'ui/dom.js': ['el', 'frag', 'qs', 'qsa', 'clear', 'mount', 'on', 'autoGrow', 'scrollToBottom', 'isNearBottom'],
    'ui/icons.js': ['icons', 'icon'],
    'ui/toast.js': ['toast', 'confirmDialog', 'promptDialog', 'modal'],
    'ui/sidebar.js': ['renderSidebar', 'refreshSidebar', 'openNewCharacterDialog', 'openGlobalSearch'],
    'ui/chat.js': ['renderChat', 'refreshMessages', 'openSearchDialog', 'focusMessage'],
    'ui/groupchat.js': [
      'renderGroupChat', 'refreshGroupMessages', 'renderGroupPanel', 'stopGroupRound', 'isGroupBusy',
      'openGroupSearchDialog', 'appendGroupNotice', 'focusGroupMessage',
    ],
    'ui/groupeditor.js': ['openGroupEditor', 'openMemberPicker', 'openNewGroupDialog'],
    'core/werewolf.js': [
      // 常量与板子
      'TEAM_WOLF', 'TEAM_GOOD', 'ROLES', 'BOARDS', 'USER_ID',
      'MIN_PLAYERS', 'MAX_PLAYERS', 'MIN_MEMBERS', 'MAX_MEMBERS',
      'boardFor', 'boardLabel', 'teamName', 'assignRoles',
      // 状态与判定
      'aliveOf', 'countAlive', 'checkWinner', 'tallyVotes', 'tallyText', 'publicVoteTally', 'bySeat', 'byId', 'seatList',
      // 提示词装配（信息边界见 docs/ARCHITECTURE.md 5.9）
      'publicLogText', 'privateFacts', 'ruleCardFor', 'teamRuleFor', 'hudExtraFor', 'privateNoteFor',
      'nightPromptFor', 'dayPromptFor', 'votePromptFor', 'lastWordsPromptFor',
      'speakOrderFor', 'speakOrderNote', 'looksLikeSilenceUrge', 'stripSilenceUrge',
      // 解析与认狼兜底
      'parseSeat', 'parseDecline', 'splitSpeechAndVote', 'liveSpeechPreview', 'markTruncatedTail', 'looksLikeWolfConfession', 'stripWolfConfession',
      // 存档与引擎
      'saveGame', 'loadGame', 'clearGame', 'isActive', 'preflight', 'runWerewolf', 'WerewolfGame',
    ],
    'ui/werewolf.js': [
      'openWerewolfPanel', 'stopWerewolf', 'werewolfActive', 'isPanelOpen',
      'submitUserText', 'awaitingSpeech', 'awaitingAction', 'speechLiveEvent',
    ],
    'ui/favorites.js': ['openFavorites'],
    'ui/editor.js': ['openCharacterEditor', 'openTemplateGallery'],
    'ui/settings.js': ['openSettings'],
    'ui/app.js': ['bootstrap'],
  };
  for (const [file, names] of Object.entries(expectations)) {
    await test(`${file} 导出完整`, async () => {
      let mod;
      try {
        mod = await load(file);
      } catch (err) {
        throw new Error(`无法 import：${err.message}`);
      }
      const missing = names.filter((n) => !(n in mod));
      assert.equal(missing.length, 0, `缺少导出：${missing.join(', ')}`);
    });
  }
}

console.log(`\n================ 结果：${passed} 通过 / ${failed} 失败 ================`);
if (failed) {
  console.log('\n失败详情：');
  failures.forEach((f) => console.log(' - ' + f));
}
process.exit(failed ? 1 : 0);
