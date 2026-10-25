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

/**
 * 纠正/撤回同时约束原文入口，避免失效事实从近期经历或当前历史绕回提示词。
 * 只过滤记录过的同一来源、同一版本；不改原消息，不猜测其他语义相似消息。
 */
export function filterMemoryContext(items, memory, { charId, source = 'private', recent = false } = {}) {
  const list = Array.isArray(items) ? items : [];
  const blocked = new Map();
  for (const record of normalizeMemory(memory).factRecords) {
    if (!record.blocked) continue;
    for (const ref of record.sources) {
      const key = sourceKey(ref);
      if (!blocked.has(key)) blocked.set(key, new Set());
      blocked.get(key).add(ref.signature);
    }
  }
  if (!blocked.size) return list;
  const result = [];
  for (const item of list) {
    if (!item) continue;
    // Recent experiences retain the complete selected message content and original id.
    const itemSource = recent ? String(item.source || '') : source;
    const raw = recent ? { id: item.id, role: 'user', content: item.content } : item;
    const ref = makeMemorySource(raw, charId, itemSource);
    if (blocked.get(sourceKey(ref))?.has(ref.signature)) continue;
    // Quote bodies are stored as truncated snapshots, so their full signature is unavailable.
    // Drop only a blocked quote snapshot, retaining the new message itself.
    const quoteRef = item.quoted?.id ? { ...ref, messageId: item.quoted.id } : null;
    result.push(quoteRef && blocked.has(sourceKey(quoteRef)) ? { ...item, quoted: null } : item);
  }
  return result;
}

export function correctFact(memory, id, replacement, { relatedIds = [], blockedSources = [], retainedFacts = [] } = {}) {
  const m = normalizeMemory(memory);
  const record = m.factRecords.find((r) => r.id === id);
  if (!record || !['active', 'stale'].includes(record.status)) throw new Error('这条记忆已改变，请刷新后重试');
  const text = String(replacement || '').trim();
  if (!text || text.length > 500) throw new Error('请输入1至500字的纠正内容');
  const now = Date.now();
  const ids = new Set([id, ...relatedIds]);
  for (const r of m.factRecords) if (ids.has(r.id)) {
    if (!['active', 'stale'].includes(r.status)) throw new Error('关联记忆已改变，请重新纠正');
    r.status = 'superseded'; r.blocked = true; r.updatedAt = now;
  }
  for (const kept of retainedFacts) {
    const original = m.factRecords.find((r) => r.id === kept.id && ids.has(r.id));
    if (!original || !String(kept.text || '').trim() || String(kept.text).length > 500) throw new Error('保留事实校验失败');
    m.factRecords.push({ ...original, id: createId('fact'), text: kept.text.trim(), status: 'active',
      blocked: false, origin: 'model', retainedFrom: original.id, createdAt: now, updatedAt: now });
  }
  // Source-only echoes need a tombstone too, even if extraction omitted them.
  for (const source of blockedSources) if (!blockedMemorySource(m, source)) {
    m.factRecords.push({ id: createId('fact'), text: '原对话中的同义旧表述（已纠正）',
      status: 'superseded', blocked: true, origin: 'model', sources: [source],
      sourceStatus: 'verified', createdAt: now, updatedAt: now, correctionOf: id });
  }
  // An untouched time/price can share a message with the corrected location.
  // Keep that independently valid fact when rebuilding, since the raw message
  // is now blocked and cannot be used to extract it again.
  for (const r of m.factRecords) if (r.status === 'active' && !ids.has(r.id) &&
    r.sources.some((s) => blockedMemorySource(m, s))) r.preservedByCorrection = id;
  m.factRecords.push({ id: createId('fact'), text, status: 'active', origin: 'manual', sources: [],
    sourceStatus: 'unverified', createdAt: now, updatedAt: now, replaces: id, replacesIds: [...ids] });
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
  const retiredSources = new Set();
  let invalidCitation = false;
  const blockedTexts = new Set(m.factRecords.filter((r) => r.blocked).map((r) => r.text));
  if (rebuild) for (const r of m.factRecords) {
    if (r.status === 'active' && !['manual', 'game'].includes(r.origin) && !r.retainedFrom && !r.preservedByCorrection) r.status = 'superseded';
  }
  for (const value of Array.isArray(parsed.facts) ? parsed.facts : []) {
    const text = String(typeof value === 'string' ? value : value?.text || '').trim().slice(0, 500);
    if (!text || blockedTexts.has(text)) continue;
    const ids = typeof value === 'object' && Array.isArray(value.sourceIds) ? value.sourceIds : [];
    // 新结构若声称有来源却给出未知ID，整条拒绝；旧模型的字符串兼容为“来源未记录”。
    if (ids.some((id) => !sourceMap.has(String(id)))) { invalidCitation = true; continue; }
    const sources = [...new Set(ids.map(String))].map((id) => sourceMap.get(id));
    if (sources.some((s) => blockedMemorySource(m, s))) continue;
    // Only an explicit update, backed by a strictly later source in the SAME
    // conversation, may retire previous model facts. Manual/game facts are protected.
    if (value?.change === 'confirmed_update' && sources.length) {
      const laterThan = (old) => old.length && old.every((s) => sources.some((n) =>
        n.kind === s.kind && n.conversationId === s.conversationId && n.at > s.at));
      const supersedes = Array.isArray(value.supersedes) ? value.supersedes.map(String) : [];
      for (const r of m.factRecords) if (supersedes.includes(r.id) && r.status === 'active' && r.origin === 'model' && laterThan(r.sources)) {
        r.status = 'superseded'; r.blocked = true; r.updatedAt = now;
      }
      const oldIds = Array.isArray(value.obsoleteSourceIds) ? value.obsoleteSourceIds.map(String) : [];
      if (oldIds.every((id) => sourceMap.has(id))) for (const id of new Set(oldIds)) {
        const old = sourceMap.get(id);
        if (!laterThan([old]) || blockedMemorySource(m, old)) continue;
        retiredSources.add(sourceKey(old) + ':' + old.signature);
        m.factRecords.push({ id: createId('fact'), text: '原安排（已由后续明确通知更新）',
          status: 'superseded', blocked: true, origin: 'model', sources: [old],
          sourceStatus: 'verified', createdAt: now, updatedAt: now });
      }
    }
    const existing = m.factRecords.find((r) => r.status === 'active' && r.text === text);
    if (existing) continue;
    m.factRecords.push({ id: createId('fact'), text, status: 'active', origin: 'model', sources,
      sourceStatus: sources.length ? 'verified' : 'unverified', createdAt: now, updatedAt: now });
  }
  for (const r of m.factRecords) if (r.status === 'active' && r.origin === 'model' && r.sources.length &&
    r.sources.every((s) => retiredSources.has(sourceKey(s) + ':' + s.signature))) {
    r.status = 'superseded'; r.blocked = true; r.updatedAt = now;
  }
  // 不截断持久层的旧记录；只有提示词选择有界，历史纠错记录始终可查。
  m.summary = String(parsed.summary ?? m.summary).slice(0, 1500);
  m.summarySources = [...sourceMap.values()];
  // 无来源旧错误无法可靠做语义去重；有人工纠正/撤回时摘要也可能复述旧错误，保守停用。
  m.summaryStatus = invalidCitation || m.factRecords.some((r) => r.blocked) ? 'stale' : (m.summarySources.length ? 'active' : 'unverified');
  return normalizeMemory(m);
}
