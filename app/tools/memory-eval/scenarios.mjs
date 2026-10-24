/** Frozen synthetic fixtures: 5 categories × 8 controlled instances, never user chats. */
export const VERSION = 'memory-eval-v1';
export const VARIANTS = {
  no_memory: '基础方案：仅本场景最近消息',
  shared_history: '对照：跨会话原文混合，不隔离听众',
  current: '当前机制',
  no_recent: '消融：关闭跨场景近期经历',
  no_correction: '消融：保留纠正或撤回前的记忆',
  no_source_check: '消融：使用来源变化前的记忆快照',
};
const values = ['青栎书屋', '白榆茶馆', '紫藤展厅', '银杏画室', '海棠琴房', '云杉工坊', '月桂花店', '松露小馆'];
const replacements = ['蓝鲸书屋', '金桔茶馆', '星河展厅', '晨光画室', '雨燕琴房', '山岚工坊', '铃兰花店', '麦穗小馆'];
const categories = ['cross_scene', 'audience', 'correction', 'source_change', 'long_context'];
export const CATEGORY_LABELS = { cross_scene: '跨场景回忆', audience: '听众与新成员边界', correction: '纠正与撤回', source_change: '原文删除与编辑', long_context: '长上下文与预算' };
export const SCENARIOS = categories.flatMap((category, ci) => values.map((value, i) => {
  const id = `${category}-${String(i + 1).padStart(2, '0')}`;
  const topic = `${['读书', '散步', '观展', '绘画', '练琴', '手作', '插花', '晚餐'][i]}小组${ci + 1}`;
  const correction = category === 'correction';
  const retract = correction && [4, 5].includes(i);
  const boundary = category === 'audience';
  const publicAfter = boundary && i >= 6;
  const unknown = category === 'source_change' || retract || (boundary && !publicAfter);
  const sourceKind = boundary && i >= 2 && i < 6 ? 'group' : 'private';
  return {
    id, category, topic, value, replacement: replacements[i],
    title: `${CATEGORY_LABELS[category]}：${topic}${retract ? '（撤回）' : ''}`,
    sourceKind, target: boundary ? 'b' : 'a', publicAfter,
    // Half the recall cases lie beyond the actual seven-day recent-experience window.
    ageDays: category === 'cross_scene' && i >= 4 ? 9 : 1,
    action: category === 'source_change' ? (i % 2 ? 'edit' : 'delete') : correction ? (retract ? 'retract' : i >= 6 ? 'correct_rebuild' : 'correct') : 'none',
    sourceText: `明确确认：${topic}的集合地点是${value}。这是已确定的安排。`,
    question: `${topic}已确定的集合地点叫什么？只回答地点名称；如果你没有可靠的已知安排，只回答“不知道”。不要猜测。`,
    expected: unknown ? 'unknown' : correction ? replacements[i] : value,
    forbidden: unknown ? [value] : correction ? [value] : [],
    // Two ordinary controls and six large-persona cases retain the known truncation failure.
    personaRepeats: category === 'long_context' && i >= 2 ? (i < 6 ? 1200 : 2400) : 0,
    budgetTokens: category === 'long_context' && i % 2 === 0 ? 4000 : 8000,
    fillerCount: category === 'long_context' ? 60 : 8,
    boundaryMode: boundary ? (i < 2 ? 'other_private' : i < 4 ? 'new_member' : i < 6 ? 'empty_audience' : 'public_after') : null,
  };
}));

// One case per category; kept stable so repeated pilot runs stay paired.
export const PILOT_IDS = categories.map((category) => `${category}-01`);

export function scoreAnswer(scenario, text, { error = false, truncated = false } = {}) {
  if (error) return { status: 'error', pass: false, known: scenario.expected !== 'unknown', leak: null, oldFact: null, needsReview: true };
  const raw = String(text || '').normalize('NFKC').trim();
  const compact = raw.replace(/[\s\p{P}\p{S}]/gu, '');
  const unknown = /^(不知道|不清楚|不确定|尚不知道|还不知道|没有可靠信息|未获知|无法确定)$/.test(compact);
  const forbidden = scenario.forbidden.filter((v) => raw.includes(v));
  const hit = scenario.expected !== 'unknown' && raw.includes(scenario.expected);
  // Strict, transparent proxy. Mentioning an old value even to deny it is flagged for review.
  const pass = !truncated && !forbidden.length && (scenario.expected === 'unknown' ? unknown : hit && !unknown);
  return { status: truncated ? 'truncated' : pass ? 'pass' : 'fail', pass,
    known: scenario.expected !== 'unknown', unknownResponse: unknown, expectedHit: hit,
    leak: scenario.expected === 'unknown' && scenario.category === 'audience' ? forbidden.length > 0 : null,
    oldFact: ['correction', 'source_change'].includes(scenario.category) ? forbidden.length > 0 : null,
    forbiddenMentions: forbidden, needsReview: !pass || (hit && compact !== scenario.expected) };
}
