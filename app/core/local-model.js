import { estimateTokens } from './util.js';
/** 本地开源模型的固定复现配置；角色提示词仍由现有聊天/记忆模块构建。 */
export const LOCAL_MODEL = 'quliao-qwen3:4b';
export const LOCAL_BASE_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
export const LOCAL_BASE_URL = 'http://127.0.0.1:11435/v1';

export const LOCAL_CONTEXT_TOKENS = 16384;
// 16K 窗口：最多约 7K 输入 + 8K 输出，余量留给模板与估算误差。
export const LOCAL_REQUEST_TIMEOUT_MS = 120000;
export const LOCAL_REQUEST_TOTAL_MS = 300000;
export const LOCAL_INPUT_BUDGET = 7000;
export const LOCAL_MAX_OUTPUT_TOKENS = 8192;
export function localOutputTokens(value = 1024) {
  const n = value == null || value === '' ? NaN : Number(value);
  return Math.min(LOCAL_MAX_OUTPUT_TOKENS, Math.max(1, Math.round(Number.isFinite(n) ? n : 1024)));
}
export function localInputBudget(value = LOCAL_INPUT_BUDGET) {
  const n = value == null || value === '' ? NaN : Number(value);
  return Math.min(LOCAL_INPUT_BUDGET, Math.max(0, Math.floor(Number.isFinite(n) ? n : LOCAL_INPUT_BUDGET)));
}

/** 不悄悄截断游戏规则或记忆来源；超长请求在推理前给出明确错误。 */
export function localContextError(messages, maxTokens) {
  if (!Array.isArray(messages)) return '消息格式不正确';
  const input = messages.reduce((sum, message) => {
    const content = message?.content;
    const text = Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.text || '').join('') : String(content || '');
    return sum + estimateTokens(text) + 8;
  }, 0);
  const limit = LOCAL_CONTEXT_TOKENS - localOutputTokens(maxTokens) - 1024;
  return input > limit ? `输入估算约 ${input} tokens，超过当前回复长度下的本地输入上限 ${limit}；请缩短人设、历史或回复长度后重试` : '';
}

export function localModelSettings() {
  return {
    provider: 'ollama', model: LOCAL_MODEL, useProxy: true,
    baseUrls: { ollama: LOCAL_BASE_URL },
  };
}

/** 无论旧设置/备份写入什么接入配置，运行时都使用项目本地模型。 */
export function enforceLocalSettings(settings = {}) {
  return { ...settings, ...localModelSettings(),
    params: { ...settings.params, maxTokens: localOutputTokens(settings.params?.maxTokens) },
    context: { ...settings.context, budgetTokens: localInputBudget(settings.context?.budgetTokens) },
    voice: { ...settings.voice, provider: 'webspeech' } };
}
