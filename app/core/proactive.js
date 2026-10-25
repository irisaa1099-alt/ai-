/**
 * 角色主动性（契约 3.15）：久未联系时，角色会主动发来一条消息。
 * 对应《功能脑暴与规划》第九节的"杀手锏 1：时间感知 + 角色主动性"。
 */
import { bus } from './bus.js';
import { getCharacter, listCharacters, listMessages, appendMessage, getMemory, getRecentExperiences } from './store.js';
import {
  getRuntime,
  addUnread,
  inQuietHours,
  canProactiveToday,
  noteProactive,
  gapDescription,
} from './runtime.js';
import { buildMessages, summarizeIfNeeded } from './prompt.js';
import { chatStream, addUsage } from './llm.js';
import { pick, timeContext, num } from './util.js';

let timer = null;
let bootTimer = null;
let ctxRef = null;
let running = false;
let generation = 0;
const controllers = new Set();

/**
 * 启动定时检查（每 60 秒）
 * @param {object} ctx 由 ui/app.js 传入
 */
export function initProactive(ctx) {
  ctxRef = ctx;
  stopProactive();
  const settings = ctx.settings || {};
  // 主动性的唯一开关是 settings.proactive.enabled（避免两处配置互相矛盾）
  if (settings.proactive?.enabled !== true) {
    return;
  }
  timer = setInterval(() => {
    void checkAll();
  }, 60 * 1000);
  // 启动 20 秒后先跑一次（不阻塞首屏）；句柄要保存，否则反复开关主动性会叠加多个待执行检查
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void checkAll();
  }, 20000);
}

/** 停止定时器 */
export function stopProactive() {
  generation++;
  for (const controller of controllers) controller.abort();
  controllers.clear();
  if (timer) clearInterval(timer);
  timer = null;
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = null;
}

/** 遍历所有角色，判断是否需要主动消息 */
async function checkAll() {
  if (running || !ctxRef) return;
  const settings = ctxRef.settings;
  if (!settings || settings.proactive?.enabled !== true) return;
  running = true;
  const epoch = generation;
  try {
    const chars = await listCharacters();
    for (const char of chars) {
      if (epoch !== generation || ctxRef.settings?.proactive?.enabled !== true) break;
      if (char.muted) continue;
      const rt = getRuntime(char.id);
      // 当前正在聊天的角色不打扰
      if (ctxRef.currentCharId === char.id) continue;
      const next = nextEligibleAt(char, rt, settings);
      if (next && Date.now() >= next) {
        // 一次只发一条，避免刷屏
        await maybeTrigger(char, ctxRef);
        break;
      }
    }
  } catch (err) {
    console.warn('[proactive] 检查失败', err);
  } finally {
    running = false;
  }
}

/**
 * 计算下一次允许主动消息的时间戳（不满足条件返回 0）
 * @param {object} char
 * @param {object} rt
 * @param {object} settings
 * @returns {number}
 */
export function nextEligibleAt(char, rt, settings) {
  const cfg = settings.proactive || {};
  if (cfg.enabled === false) return 0;
  if (inQuietHours(cfg.quietStart, cfg.quietEnd)) return 0;
  if (!canProactiveToday(char.id, cfg.maxPerDay)) return 0;
  const gapMs = num(cfg.minGapHours, 6) * 3600 * 1000;
  const base = rt.lastChatAt || rt.lastProactiveAt || char.createdAt || Date.now();
  const since = Date.now() - base;
  if (since < gapMs) return 0;
  if (rt.lastProactiveAt && Date.now() - rt.lastProactiveAt < gapMs) return 0;
  return base + gapMs;
}

/**
 * 生成一条主动消息并入库
 * @param {object} char
 * @param {object} ctx
 * @returns {Promise<boolean>}
 */
export async function maybeTrigger(char, ctx, { manual = false } = {}) {
  const epoch = generation;
  const valid = () => epoch === generation && (manual || ctx?.settings?.proactive?.enabled === true);
  if (!valid()) return false;
  if (!char?.id) return false;
  const settings = (ctx && ctx.settings) || {};
  const rt = getRuntime(char.id);
  const cfg = settings.proactive || {};
  if (inQuietHours(cfg.quietStart, cfg.quietEnd)) return false;
  if (!canProactiveToday(char.id, cfg.maxPerDay)) return false;

  const history = await listMessages(char.id);
  const memory = await getMemory(char.id);
  const recentExperiences = await getRecentExperiences(char.id);
  if (!valid()) return false;
  const timeCtx = timeContext();

  const reason = rt.lastChatAt
    ? `${gapDescription(rt.lastChatAt)}现在是${timeCtx.partOfDay}。`
    : '你们还没有正式聊过。';

  const nudge = `[系统提示，对方看不到这条] 请你主动给对方发一条消息。${reason}像真人一样自然地对ta说句话：可以问候、分享一件小事、提起之前聊过的内容、或者单纯表示想起了ta。要求：1~3 句，符合你的性格与说话习惯，不要解释你为什么发消息，不要提到"系统""提示"。直接输出要发的内容。`;

  const { messages } = buildMessages(char, history.slice(-12), {
    settings,
    memory,
    recentExperiences,
    runtime: rt,
    budgetTokens: Math.min(num(settings.context?.budgetTokens, 8000), 4000),
    timeCtx,
  });
  const withNudge = [...messages, { role: 'user', content: nudge }];

  const controller = new AbortController();
  controllers.add(controller);
  try {
    if (!valid()) return false;
    const res = await chatStream(
      {
        provider: char.model?.provider || settings.provider,
        model: char.model?.model || settings.model,
        apiKey: settings.useProxy ? '' : settings.apiKeys?.[char.model?.provider || settings.provider] || '',
        baseUrl: settings.baseUrls?.[char.model?.provider || settings.provider] || '',
        useProxy: settings.useProxy,
        messages: withNudge,
        params: { ...(settings.params || {}), temperature: Math.max(0.7, num(settings.params?.temperature, 0.85)) },
        stream: true,
        signal: controller.signal,
        purpose: 'proactive',
        charId: char.id,
        // 主动搭话是后台行为，用户在等的是"界面别被占住"：
        // 不传就落回默认的 120 秒 / 10 分钟，一次搭话能把这一路的等待拖满。
        timeoutMs: 60000,
        totalTimeoutMs: 120000,
      },
      {}
    );
    const text = String(res.text || '').trim();
    if (!text || !valid() || controller.signal.aborted || res.aborted) return false;

    await appendMessage({
      charId: char.id,
      role: 'assistant',
      content: text,
      model: res.model || char.model?.model || settings.model,
      usage: res.usage || null,
      emotion: 'neutral',
      status: 'done',
    }, { signal: controller.signal });
    if (!valid()) return false;
    void listMessages(char.id).then((rows) => summarizeIfNeeded(char, rows, { settings })).catch((err) => console.warn('[memory]', err));
    addUnread(char.id, 1);
    noteProactive(char.id);
    if (res.usage) {
      // 真正记账（llm.js 自身不记账，只有界面层在聊完一轮时记）。
      // 不记的话主动消息的 token/费用会从用量统计与预算里漏掉。
      void addUsage({
        charId: char.id,
        provider: char.model?.provider || settings.provider,
        model: res.model || settings.model,
        prompt: res.usage.prompt,
        completion: res.usage.completion,
        total: res.usage.total,
        cost: res.usage.cost,
      });
      bus.emit('llm:usage', {
        charId: char.id,
        provider: char.model?.provider || settings.provider,
        model: res.model || settings.model,
        ...res.usage,
      });
    }
    bus.emit('proactive:sent', { charId: char.id, text });
    if (settings.sound !== false) {
      try {
        bus.emit('proactive:notify', { charId: char.id, name: char.name, text });
      } catch {}
    }
    return true;
  } catch (err) {
    if (!controller.signal.aborted) console.warn('[proactive] 生成失败', err?.message || err);
    return false;
  } finally {
    controllers.delete(controller);
  }
}

/** 手动触发一次（设置面板里的"立即测试"按钮） */
export async function triggerNow(charId, ctx) {
  const char = await getCharacter(charId);
  if (!char) return false;
  return maybeTrigger(char, ctx || ctxRef || { settings: {} }, { manual: true });
}

export { pick };
