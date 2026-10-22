/** 长期记忆的兼容模型。纯函数，不迁移或写入旧聊天。 */
import { createId, hashCode, num } from './util.js';
import { experienceContent } from './recent.js';

const STATES = new Set(['active', 'superseded', 'retracted', 'stale']);
export function sourceKey(source) {
  return `${source?.kind === 'group' ? 'group' : 'private'}:${source?.conversationId || ''}:${source?.messageId || ''}`;
}

/** 内容签名只用于发现源消息变化，不作为密码学认证。 */
export function sourceSignature(message) {
  const content = experienceContent(message);
  return `${content.length}:${hashCode(content)}:${hashCode([...content].reverse().join(''))}`;
}

export function makeMemorySource(message, charId, source = 'private') {
  const kind = message.groupId || source.startsWith('group:') ? 'group' : 'private';
  return {
    kind, conversationId: kind === 'group' ? String(message.groupId || source.slice(6)) : String(charId),
    messageId: String(message.id || ''), at: num(message.at),
    speakerId: String(message.speakerId || (message.role === 'user' ? 'user' : charId)),
    signature: sourceSignature(message),
  };
}

export function normalizeMemory(raw = {}) {
  const records = Array.isArray(raw.factRecords) ? raw.factRecords : (Array.isArray(raw.facts) ? raw.facts : []).map((text, index) => ({
    id: `legacy-${index}-${hashCode(String(text))}`, text: String(text), status: 'active',
    origin: 'legacy', sources: [], sourceStatus: 'unverified', createdAt: num(raw.updatedAt), updatedAt: num(raw.updatedAt),
  }));
  const factRecords = records.filter((r) => r && String(r.text || '').trim()).map((r, index) => ({
    ...r, id: String(r.id || `legacy-${index}-${hashCode(String(r.text))}`), text: String(r.text).trim(),
    status: STATES.has(r.status) ? r.status : 'active', origin: ['model', 'manual', 'legacy', 'game'].includes(r.origin) ? r.origin : 'legacy',
    sources: Array.isArray(r.sources) ? r.sources.filter((s) => s && s.messageId && s.conversationId).map((s) => ({ ...s })) : [],
    createdAt: num(r.createdAt), updatedAt: num(r.updatedAt),
    sourceStatus: r.sourceStatus === 'verified' && r.sources?.length ? 'verified' : 'unverified',
  }));
  return {
    ...raw, summary: String(raw.summary || ''), factRecords,
    facts: factRecords.filter((r) => r.status === 'active').map((r) => r.text),
    summarySources: Array.isArray(raw.summarySources) ? raw.summarySources.map((s) => ({ ...s })) : [],
    summaryStatus: ['active', 'stale', 'unverified'].includes(raw.summaryStatus) ? raw.summaryStatus : 'unverified',
    summaryCursors: raw.summaryCursors || {}, summarizedUpTo: num(raw.summarizedUpTo),
    updatedAt: num(raw.updatedAt), revision: num(raw.revision), schemaVersion: 2,
  };
}

export function memorySummary(memory) {
  const m = normalizeMemory(memory);
  return m.summaryStatus === 'stale' ? '' : m.summary;
}

/** 同等相关时优先新事实；上限统一为40条，不再固定取旧列表的前30条。 */
export function selectMemoryFacts(memory, queryText = '', limit = 40) {
  const m = normalizeMemory(memory);
  const query = String(queryText || '').toLowerCase();
  const words = new Set(query.match(/[a-z0-9]{2,}/g) || []);
  for (const run of query.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) words.add(run.slice(i, i + 2));
  }
  return m.factRecords.map((r, index) => ({ r, index,
    score: [...words].reduce((sum, word) => sum + (r.text.toLowerCase().includes(word) ? 1 : 0), 0),
  })).filter(({ r }) => r.status === 'active')
    .sort((a, b) => b.score - a.score || b.r.updatedAt - a.r.updatedAt || b.index - a.index)
    .slice(0, Math.max(0, limit)).map(({ r }) => r.text);
}

export function blockedMemorySource(memory, source) {
  return normalizeMemory(memory).factRecords.some((r) => r.blocked && r.sources.some((s) =>
    sourceKey(s) === sourceKey(source) && s.signature === source.signature));
}

export function correctFact(memory, id, replacement) {
  const m = normalizeMemory(memory);
  const record = m.factRecords.find((r) => r.id === id);
  if (!record || !['active', 'stale'].includes(record.status)) throw new Error('这条记忆已改变，请刷新后重试');
  const text = String(replacement || '').trim();
  if (!text || text.length > 500) throw new Error('请输入1至500字的纠正内容');
  const now = Date.now();
  record.status = 'superseded'; record.blocked = true; record.updatedAt = now;
  m.factRecords.push({ id: createId('fact'), text, status: 'active', origin: 'manual', sources: [],
    sourceStatus: 'unverified', createdAt: now, updatedAt: now, replaces: id });
  m.summaryStatus = 'stale';
  return normalizeMemory(m);
}

export function retractFact(memory, id) {
  const m = normalizeMemory(memory);
  const record = m.factRecords.find((r) => r.id === id);
  if (!record || !['active', 'stale'].includes(record.status)) throw new Error('这条记忆已改变，请刷新后重试');
  record.status = 'retracted'; record.blocked = true; record.updatedAt = Date.now();
  m.summaryStatus = 'stale';
  return normalizeMemory(m);
}

/** 只把模型给出的有效sourceIds映射到本轮已验证的消息，绝不伪造来源。 */
export function mergeExtractedMemory(memory, parsed, sourceMap, { rebuild = false } = {}) {
  const m = normalizeMemory(memory), now = Date.now();
  let invalidCitation = false;
  const blockedTexts = new Set(m.factRecords.filter((r) => r.blocked).map((r) => r.text));
  if (rebuild) for (const r of m.factRecords) {
    if (r.status === 'active' && r.origin !== 'manual') r.status = 'superseded';
  }
  for (const value of Array.isArray(parsed.facts) ? parsed.facts : []) {
    const text = String(typeof value === 'string' ? value : value?.text || '').trim().slice(0, 500);
    if (!text || blockedTexts.has(text)) continue;
    const ids = typeof value === 'object' && Array.isArray(value.sourceIds) ? value.sourceIds : [];
    // 新结构若声称有来源却给出未知ID，整条拒绝；旧模型的字符串兼容为“来源未记录”。
    if (ids.some((id) => !sourceMap.has(String(id)))) { invalidCitation = true; continue; }
    const sources = [...new Set(ids.map(String))].map((id) => sourceMap.get(id));
    if (sources.some((s) => blockedMemorySource(m, s))) continue;
    const existing = m.factRecords.find((r) => r.status === 'active' && r.text === text);
    if (existing) continue;
    m.factRecords.push({ id: createId('fact'), text, status: 'active', origin: 'model', sources,
      sourceStatus: sources.length ? 'verified' : 'unverified', createdAt: now, updatedAt: now });
  }
  // 不截断持久层的旧记录；只有提示词选择有界，历史纠错记录始终可查。
  m.summary = String(parsed.summary ?? m.summary).slice(0, 1500);
  m.summarySources = [...sourceMap.values()];
  // 无来源旧错误无法可靠做语义去重；有人工纠正/撤回时摘要也可能复述旧错误，保守停用。
  m.summaryStatus = invalidCitation || m.factRecords.some((r) => r.blocked) ? 'stale' : (m.summarySources.length ? 'active' : 'unverified');
  return normalizeMemory(m);
}
