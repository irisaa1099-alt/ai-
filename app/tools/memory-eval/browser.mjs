// Executed only in a new headless profile at the evaluator's isolated HTTP origin.
import * as store from '../../core/store.js';
import * as prompt from '../../core/prompt.js';
import * as groupPrompt from '../../core/group.js';
import * as recent from '../../core/recent.js';
import { chat } from '../../core/llm.js';

let configuration, fixture;
const copy = (x) => structuredClone(x);
export function configure(config) {
  configuration = config;
  store.setSettings({ onboarded: true, provider: config.provider, model: config.model,
    apiKeys: { [config.provider]: 'EVALUATION_LOCAL_BRIDGE' }, baseUrls: { [config.provider]: `${location.origin}/model/v1` }, useProxy: false,
    params: config.params, user: { name: '合成用户' }, proactive: { enabled: false }, voice: { enabled: false },
    context: { summary: true, summaryKeep: 2, maxMessages: 8, budgetTokens: 8000, timeAware: false, affinity: false } });
}

export async function prepare(scenario, runKey) {
  const prefix = `eval_${runKey}_${scenario.id}`;
  const a = await store.saveCharacter({ id: `${prefix}_a`, name: '林舟', greeting: [], persona: {} });
  const b = await store.saveCharacter({ id: `${prefix}_b`, name: '周宁', greeting: [], persona: {} });
  const target = scenario.target === 'b' ? b : a;
  const sourceGroup = await store.saveGroup({ id: `${prefix}_source`, name: '原始活动群',
    members: sNewMember(scenario) ? [a.id] : [a.id, b.id] });
  let destination = scenario.sourceKind === 'group' ? sourceGroup
    : await store.saveGroup({ id: `${prefix}_dest`, name: '新的活动群', members: [a.id, b.id] });
  const at = Date.now() - scenario.ageDays * 86400000;
  const source = { id: `${prefix}_source_message`, charId: a.id, role: 'user', content: scenario.sourceText, at };
  if (scenario.sourceKind === 'group') Object.assign(source, { groupId: sourceGroup.id, charId: sourceGroup.id, speakerId: 'user',
    audienceIds: scenario.boundaryMode === 'empty_audience' ? [] : [a.id] });
  const fillers = Array.from({ length: scenario.fillerCount }, (_, i) => ({ id: `${prefix}_f_${i}`, charId: a.id,
    role: i % 2 ? 'assistant' : 'user', content: `普通闲聊第${i + 1}条：今天讨论天气与整理笔记，没有新增的活动安排。`, at: at + i + 1 }));
  // Summarize the fact and 6 harmless rows, keeping the source out of the live window.
  const extractionRows = [source, ...fillers.slice(0, 6).map((m) => scenario.sourceKind === 'group'
    ? { ...m, groupId: sourceGroup.id, charId: sourceGroup.id, speakerId: m.role === 'user' ? 'user' : a.id, audienceIds: [a.id] } : m)];
  if (scenario.sourceKind === 'group') await store.putGroupMessagesLocal(extractionRows);
  else await store.putMessagesLocal([source, ...fillers]);
  if (sNewMember(scenario)) destination = await store.setGroupMembers(sourceGroup.id, [b.id], []);
  const settings = store.getSettings();
  const extraction = await prompt.summarizeIfNeeded(a, extractionRows, { settings, force: true,
    source: scenario.sourceKind === 'group' ? `group:${sourceGroup.id}` : 'private' });
  const before = await store.getMemory(a.id);
  const candidates = before.factRecords.filter((r) => r.status === 'active' && r.text.includes(scenario.value));
  const actions = [];
  if (scenario.action.startsWith('correct') || scenario.action === 'retract') {
    for (const record of candidates) {
      if (scenario.action === 'retract') await store.retractMemoryFact(a.id, record.id);
      else await store.correctMemoryFact(a.id, record.id, `${scenario.topic}的集合地点是${scenario.replacement}。`);
      actions.push({ type: scenario.action, recordId: record.id });
    }
    // No oracle fact is inserted if real extraction missed the original fact.
    if (scenario.action === 'correct_rebuild') await prompt.rebuildMemory(a, extractionRows, settings);
  }
  if (scenario.action === 'delete') {
    if (scenario.sourceKind === 'group') await store.deleteGroupMessage(source.id); else await store.deleteMessage(source.id);
    actions.push({ type: 'delete', messageId: source.id });
  }
  if (scenario.action === 'edit') {
    const patch = { content: `${scenario.topic}原来的安排已作废，目前没有确定新的地点。` };
    if (scenario.sourceKind === 'group') await store.updateGroupMessage(source.id, patch); else await store.updateMessage(source.id, patch);
    actions.push({ type: 'edit', messageId: source.id });
  }
  const question = { id: `${prefix}_q`, groupId: destination.id, charId: destination.id, speakerId: 'user', role: 'user',
    audienceIds: [a.id, b.id], content: scenario.question, at: Date.now() - 1 };
  const publicMessage = { ...question, id: `${prefix}_public`, content: `我现在向群里的所有人公开确认：${scenario.sourceText}`, at: Date.now() - 2 };
  await store.putGroupMessagesLocal(scenario.publicAfter ? [publicMessage, question] : [question]);
  const groupRows = await store.listGroupMessages(destination.id);
  fixture = { scenario, a, b, target, source, fillers, extractionRows, before, destination, groupRows, settings };
  return { extractionSucceeded: extraction.summarized, extractedTargetFacts: candidates.length,
    targetExtractionExpected: scenario.boundaryMode !== 'empty_audience',
    beforeMemory: before, afterMemory: await store.getMemory(a.id), actions,
    source: copy(source), extractionRows: copy(extractionRows), targetId: target.id };
}

function sNewMember(scenario) { return scenario.boundaryMode === 'new_member'; }

export async function assemble(variant) {
  const { scenario: s, a, b, target: originalTarget, source, before, destination, groupRows, settings } = fixture;
  const target = copy(originalTarget);
  if (s.personaRepeats) target.persona = { ...target.persona, personality: '喜欢整理旅行笔记，语气平和，谈话简洁。'.repeat(s.personaRepeats) };
  const isPrivate = s.category === 'long_context';
  let memory = await store.getMemory(target.id);
  let experiences = await store.getRecentExperiences(target.id, { source: isPrivate ? `private:${target.id}` : `group:${destination.id}` });
  if (variant === 'no_memory') { memory = {}; experiences = []; }
  if (variant === 'no_recent') experiences = [];
  if (variant === 'no_correction' && s.category === 'correction') memory = copy(before);
  if (variant === 'no_source_check' && s.category === 'source_change') memory = copy(before);
  if (variant === 'shared_history') {
    // Deliberately unsafe baseline, with raw source and user management action; not oracle answers.
    let raw = [source.content];
    if (s.action.startsWith('correct')) raw.push(`用户在记忆管理界面纠正：${s.topic}的集合地点改为${s.replacement}。`);
    if (s.action === 'retract') raw.push('用户在记忆管理界面撤回了以上地点事实。');
    if (s.action === 'delete') raw = [];
    if (s.action === 'edit') raw = [`${s.topic}原来的安排已作废，目前没有确定新的地点。`];
    memory = { summary: raw.join('\n'), facts: [] }; experiences = [];
  }
  let assembled;
  if (isPrivate) {
    assembled = prompt.buildMessages(target, [...fixture.fillers, { role: 'user', content: s.question }],
      { settings, runtime: {}, memory, recentExperiences: experiences, userText: s.question, budgetTokens: s.budgetTokens });
  } else {
    assembled = groupPrompt.buildGroupMessages({ group: destination, speaker: target, members: [a, b], history: groupRows,
      settings, runtime: {}, memory, recentExperiences: experiences, budgetTokens: s.budgetTokens, maxMessages: 8, userName: '合成用户' });
  }
  return { messages: assembled.messages, meta: assembled.meta, memory, recentExperiences: experiences };
}

export async function answer(messages) {
  const settings = store.getSettings();
  const result = await chat({ provider: configuration.provider, model: configuration.model, apiKey: 'EVALUATION_LOCAL_BRIDGE',
    baseUrl: settings.baseUrls[configuration.provider], useProxy: false, messages,
    params: configuration.params, stream: false, totalTimeoutMs: 110000 });
  // Do not use the app's historical pricing table or estimated token fallback as evaluation evidence.
  return { text: result.text, finishReason: result.finishReason, truncated: result.truncated, model: result.model };
}

window.memoryEvaluation = { configure, prepare, assemble, answer };
