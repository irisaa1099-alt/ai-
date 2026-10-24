import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS, CATEGORY_LABELS } from './scenarios.mjs';

const rate = (n, d) => d ? `${n}/${d}（${(100 * n / d).toFixed(1)}%）` : '不适用';
const mean = (xs) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : null; };
const esc = (s) => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
function csv(rows) { return '\uFEFF' + rows.map((r) => r.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n'; }
export function usageFor(calls, pricing) {
  let input = 0, output = 0, cost = 0, measured = 0, priced = 0;
  for (const call of calls) {
    const u = call.response?.usage;
    if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) continue;
    measured++; input += u.prompt_tokens; output += u.completion_tokens;
    if (!pricing || !Number.isFinite(pricing.inputPerMillion) || !Number.isFinite(pricing.outputPerMillion)) continue;
    // Cache discounts are not guessed. Unknown cache amount is charged at ordinary input rate as an estimate.
    const cached = Math.min(u.prompt_tokens, Math.max(0, u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0));
    cost += ((u.prompt_tokens - cached) * pricing.inputPerMillion
      + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) + u.completion_tokens * pricing.outputPerMillion) / 1e6;
    priced++;
  }
  return { measured, totalCalls: calls.length, input: measured ? input : null, output: measured ? output : null,
    estimatedCost: priced === calls.length && priced > 0 ? cost : null, pricedCalls: priced };
}

export function writeReport({ out, protocol, rows, preparations, calls, scenarios, isolation, stopReason }) {
  const live = protocol.mode === 'live', pricing = protocol.configuration.pricing;
  const totals = usageFor(calls, pricing);
  const stats = protocol.variants.map((variant) => {
    const group = rows.filter((r) => r.variant === variant);
    const known = group.filter((r) => r.score.known), unknown = group.filter((r) => !r.score.known);
    const leaks = group.filter((r) => r.score.leak !== null), old = group.filter((r) => r.score.oldFact !== null);
    const ownCalls = calls.filter((c) => c.variant === variant);
    const prepCalls = ['no_memory', 'shared_history'].includes(variant) ? [] : calls.filter((c) => c.phase === 'prepare' && group.some((r) => r.scenarioId === c.scenarioId));
    return { variant, attempted: group.length, passed: group.filter((r) => r.score.pass).length, known: known.length,
      recalled: known.filter((r) => r.score.pass).length, unknown: unknown.length, abstained: unknown.filter((r) => r.score.pass).length,
      leakCases: leaks.length, leaks: leaks.filter((r) => r.score.leak).length,
      oldCases: old.length, oldFacts: old.filter((r) => r.score.oldFact).length,
      errors: group.filter((r) => r.error).length, medianAnswerMs: median(group.filter((r) => !r.error).map((r) => r.elapsedMs)),
      meanAnswerMs: mean(group.filter((r) => !r.error).map((r) => r.elapsedMs)),
      answerUsage: usageFor(ownCalls, pricing), preparationUsage: usageFor(prepCalls, pricing),
      meanPreparationMs: ['no_memory', 'shared_history'].includes(variant) ? 0 : mean(preparations.filter((p) => group.some((r) => r.scenarioId === p.scenarioId)).map((p) => p.elapsedMs)) };
  });
  const pairwise = protocol.variants.filter((v) => v !== 'current').map((variant) => {
    const pairs = scenarios.map((s) => ({ current: rows.find((r) => r.scenarioId === s.id && r.variant === 'current'), baseline: rows.find((r) => r.scenarioId === s.id && r.variant === variant) }))
      .filter((p) => p.current && p.baseline && !p.current.error && !p.baseline.error);
    return { variant, pairs: pairs.length, wins: pairs.filter((p) => p.current.score.pass && !p.baseline.score.pass).length,
      losses: pairs.filter((p) => !p.current.score.pass && p.baseline.score.pass).length,
      ties: pairs.filter((p) => p.current.score.pass === p.baseline.score.pass).length };
  });
  const summary = { evidence: live ? 'real-model-pilot-or-evaluation' : 'PIPELINE_ONLY_NOT_MODEL_QUALITY',
    complete: protocol.complete, stats, pairwise, actualRunUsage: totals, errors: rows.filter((r) => r.error).length,
    extractionFailures: preparations.filter((p) => p.targetExtractionExpected !== false && (!p.extractionSucceeded || !p.extractedTargetFacts)).map((p) => p.scenarioId) };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const header = ['scenario', 'category', 'variant', 'expected', 'answer', 'status', 'pass', 'leak', 'old_fact', 'needs_review', 'answer_ms', 'error'];
  const csvRows = rows.map((r) => [r.scenarioId, r.category, r.variant, r.expected, r.text, r.score.status, r.score.pass,
    r.score.leak, r.score.oldFact, r.score.needsReview, r.elapsedMs, r.error]);
  fs.writeFileSync(path.join(out, 'results.csv'), csv([header, ...csvRows]));
  fs.writeFileSync(path.join(out, 'review.csv'), csv([['scenario', 'variant', 'answer', 'machine_status', 'human_pass', 'human_reason'],
    ...rows.map((r) => [r.scenarioId, r.variant, r.text, r.score.status, '', ''])]));
  const lines = [
    '# 记忆机制效果评测', '',
    live ? '**真实模型试跑/评测。样本规模与完成状态见下方，不能用小样本推断稳定提升。**' : '**仅为评测管线验证，回答来自本地固定假模型；下方分数不代表真实模型质量。**', '',
    `- 协议：${protocol.version}；开始：${protocol.started}；结束：${protocol.finished}`,
    `- 模型：${protocol.configuration.provider} / ${protocol.configuration.model}；回答参数：${JSON.stringify(protocol.configuration.answerParams)}`,
    `- 场景 ${scenarios.length}；计划 ${protocol.expectedCells} 个回答；完成 ${rows.length}；状态：${protocol.complete ? '本轮计划完成' : `未完成（${stopReason || '缺失单元'}）`}`,
    `- 记忆提取未成功或未找到目标事实：${summary.extractionFailures.join('、') || '无'}。这些场景保留在结果中，不补造记忆。`,
    `- 原数据库：${isolation.unchanged ? '前后文件集合及内容SHA-256一致' : '前后存在变化；请排查其他同期写入'}（${isolation.before.fileCount} → ${isolation.after.fileCount} 个文件）。`,
    '', '## 评分与可解释范围', '',
    '固定40个合成实例，分为5类、每类8例，包含重复模板的受控变体，不能当作40种独立真实用户任务。每格只生成一次，不挑最好答案。按场景轮换组顺序。', '',
    '已知事实：回答必须包含预先冻结的正确专名，不得包含旧值；未知事实：只接受预先列出的明确未知短语，且不能提及隐藏或失效值。越界率仅统计未知听众场景里隐藏值的显式复现；它不是所有语义泄露的完整度量。旧值即使出现在否定句中也标记，需人工复核。', '',
    '自动分数是透明的专名匹配代理指标，不能替代语义人工评审。所有原回答都进入 review.csv；错误、额外解释、截断回答重点复核。人工结论请另存，不覆盖机器原始记录。接口错误单列，成功率以所有已尝试单元为分母；配对胜负只使用双方接口成功的共同场景。', '',
    '## 对照结果', '',
    '| 组 | 总通过 | 已知事实正确回忆 | 未知时正确保留 | 显式越界 | 旧值复现 | 接口错误 | 回答中位耗时ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...stats.map((s) => `| ${VARIANTS[s.variant]} | ${rate(s.passed, s.attempted)} | ${rate(s.recalled, s.known)} | ${rate(s.abstained, s.unknown)} | ${rate(s.leaks, s.leakCases)} | ${rate(s.oldFacts, s.oldCases)} | ${s.errors} | ${s.medianAnswerMs ?? '无'} |`),
    '', '## 同场景配对比较（当前机制相对各组）', '',
    '| 对照组 | 有效配对 | 当前胜 | 当前负 | 持平 |', '|---|---:|---:|---:|---:|',
    ...pairwise.map((p) => `| ${VARIANTS[p.variant]} | ${p.pairs} | ${p.wins} | ${p.losses} | ${p.ties} |`),
    '', '## 按类别检查', '', '| 类别 | 组 | 通过 |', '|---|---|---:|',
    ...Object.keys(CATEGORY_LABELS).flatMap((category) => protocol.variants.map((variant) => {
      const cells = rows.filter((r) => r.category === category && r.variant === variant);
      return `| ${CATEGORY_LABELS[category]} | ${VARIANTS[variant]} | ${rate(cells.filter((r) => r.score.pass).length, cells.length)} |`;
    })),
    '', '## 用量、延迟与费用', '',
    `本次实际调用共 ${calls.length} 次，供应商返回完整token用量 ${totals.measured} 次；已报告输入 ${totals.input ?? '未知'} token、输出 ${totals.output ?? '未知'} token。缺少用量时不使用字符估算补齐。`, '',
    pricing ? `费用为价格表估算，不是账单：${totals.estimatedCost == null ? '因用量缺失无法完整估算' : totals.estimatedCost.toFixed(6) + ' ' + pricing.currency}。来源：${pricing.source}；核价：${pricing.checkedAt}。未知缓存价格按普通输入价估算。` : '未提供经核实的单价，因此费用记为未知；未使用应用内历史价格表推算。原始用量支持后续按当前价格重算。', '',
    '| 组 | 回答输入/输出token | 提取输入/输出token | 回答平均ms | 提取平均ms |', '|---|---:|---:|---:|---:|',
    ...stats.map((s) => `| ${VARIANTS[s.variant]} | ${s.answerUsage.input ?? '未知'} / ${s.answerUsage.output ?? '未知'} | ${s.preparationUsage.input ?? (s.preparationUsage.totalCalls ? '未知' : 0)} / ${s.preparationUsage.output ?? (s.preparationUsage.totalCalls ? '未知' : 0)} | ${s.meanAnswerMs ?? '无'} | ${s.meanPreparationMs ?? '无'} |`),
    '', '每个场景先用真实项目的 summarizeIfNeeded 提取一次记忆，各组共享这份结果，以减少模型提取随机性。基础/混合原文组不需要提取；各记忆组表中的提取开销是部署该组时的归属估计，不能跨组相加作为本次账单。提取与后续回答分开计时；重建场景额外包含重建调用。后续多次问答可摊薄提取成本，本轮不据此假定长期使用成本。', '',
    '## 失败案例与人工复核', '',
    ...rows.filter((r) => !r.score.pass || r.score.needsReview).flatMap((r) => [
      `### ${r.scenarioId} / ${r.variant}`, '', `预期：${r.expected}；机器判断：${r.score.status}。`, '',
      `原始回答：${esc(r.text || r.error || '（空）')}`, '',
    ]),
    '## 复现与限制', '',
    'scenarios.json 为本轮固定输入与判定预期；protocol.json 为模型、参数、完成状态和场景/源码哈希；source/ 为无聊天数据和密钥的实现快照；calls.jsonl 保存实际发给模型的合成请求、响应、供应商用量和请求耗时；results.json 保存最终提示词、注入记忆、来源和每格判分。身份密钥只留在进程内的请求头中。', '',
    '消融仅用于评测，不改变产品开关：no_recent关闭近期经历；no_correction只在纠正类使用纠正前快照；no_source_check只在原文变化类使用变化前快照。其余类别中对应消融与当前机制相同，不应宣称是独立处理。混合原文组故意取消角色信息边界，属于诊断对照，不是可部署的隐私方案。', '',
    '所有模型组使用相同回答模型与参数；提取参数沿用项目原实现（temperature=0.3、maxTokens=1100），不伪称整条管线均为temperature=0。群聊装配与私聊装配分别调用实际实现，保留已知长人设裁剪问题。未实现额外检索算法、未修复产品缺陷、未证明语义绝对保密。', '',
    '这轮不是用户试用，不能证明角色自然度、复杂对话质量、生产环境延迟或统计显著性。正式结论还需完整对照、人工复核及重复运行；模型服务端变更可能影响复现。', '',
  ];
  fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n'));
  return summary;
}
