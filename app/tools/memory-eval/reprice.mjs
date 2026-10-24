#!/usr/bin/env node
/** Offline fee estimate from preserved supplier usage. Does not make any model request. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { usageFor } from './report.mjs';
const dir = path.resolve(process.argv[2] || '.');
const pricingFile = path.resolve(process.argv[3] || '');
const protocol = JSON.parse(fs.readFileSync(path.join(dir, 'protocol.json'), 'utf8'));
if (protocol.mode !== 'live') throw Error('模拟结果不能用于真实费用估算');
const pricing = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
for (const k of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion']) if (!Number.isFinite(pricing[k]) || pricing[k] < 0) throw Error('价格必须为非负数');
if (!pricing.source || !pricing.checkedAt || !pricing.currency) throw Error('需要价格来源、核价日期与币种');
if (pricing.provider !== protocol.configuration.provider || pricing.model !== protocol.configuration.model) throw Error('价格参考与运行模型不匹配');
const log = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8');
const calls = log.trim().split('\n').filter(Boolean).map(JSON.parse);
if (pricing.validRunDateUTC && calls.some((c) => c.started.slice(0, 10) !== pricing.validRunDateUTC)) throw Error('调用日期不在此价格参考的适用范围内');
const total = usageFor(calls, pricing);
const groups = protocol.variants.map((variant) => {
  const own = calls.filter((c) => c.variant === variant);
  const prep = ['no_memory', 'shared_history'].includes(variant) ? [] : calls.filter((c) => c.phase === 'prepare');
  return { variant, answers: usageFor(own, pricing), preparation: usageFor(prep, pricing) };
});
const result = { label: '基于供应商实际token用量与已核价单价的估算，非最终账单', pricing,
  calculatedAt: new Date().toISOString(), sourceCallsSha256: crypto.createHash('sha256').update(log).digest('hex'), total, groups };
fs.writeFileSync(path.join(dir, 'cost-estimate.json'), JSON.stringify(result, null, 2) + '\n');
const cost = (x) => x.estimatedCost == null ? '未知' : `${x.estimatedCost.toFixed(8)} ${pricing.currency}`;
fs.writeFileSync(path.join(dir, 'cost-estimate.md'), [
  '# 费用补充估算', '', result.label, '',
  `价格来源：[DeepSeek官方定价](${pricing.source})；核价日期：${pricing.checkedAt}；适用：${pricing.period || '配置所列时段'}。`, '',
  `本轮实际调用 ${total.totalCalls} 次，完整用量 ${total.measured} 次；输入 ${total.input} token，输出 ${total.output} token；合计估算 **${cost(total)}**。`, '',
  '| 组 | 回答估算 | 记忆准备估算 |', '|---|---:|---:|',
  ...groups.map((g) => `| ${g.variant} | ${cost(g.answers)} | ${g.preparation.totalCalls ? cost(g.preparation) : '0'} |`), '',
  '准备费用按部署每组时的归属列出，各记忆组共享的提取只实际执行一次，不可跨组重复相加；本轮总额直接由原始调用逐条相加。所有缓存命中按供应商原始用量计价，思考token已包含在供应商completion_tokens中。未换算人民币，未读取余额或账单。', '',
  '这个补充估算不改变原始协议、回答、评分或运行日志。未来运行应重新核价，不能继续默认沿用这份日期限定的参考。', '',
].join('\n'));
console.log(JSON.stringify({ total, currency: pricing.currency, output: path.join(dir, 'cost-estimate.md') }));
