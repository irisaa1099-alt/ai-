/**
 * voice/splitter.js —— 流式断句器
 *
 * 作用：把 LLM 流式吐出的碎 token 攒成"可以立刻送去合成的完整句子"，
 * 让角色尽早开口（首句阈值更小），同时避免把超长文本整段丢给 TTS。
 *
 * 契约：ARCHITECTURE.md 3.11
 *   createSplitter(opts?: { minFirst?, min?, max? }) →
 *     { push(chunk: string): string[], flush(): string[], reset(): void }
 *
 * 切分规则（与《语音方案》第 3 节参考实现一致）：
 *   1. 硬标点（。！？!?…；;\n）在长度达到阈值（首句 minFirst，其后 min）时切分；
 *   2. 缓冲超过 max 且没有可用的硬标点 → 回退到最后一个软标点（，、：；~—）处切分；
 *   3. 连软标点都没有 → 按 max 硬切，保证单段不会无限增长；
 *   4. push / flush 的结果一律 trim，空串丢弃。
 */
import { toGraphemes } from '../core/util.js';

/** 硬断点：出现即代表"这句话说完了"，'\n' 也视作硬断点 */
const HARD = '。！？!?…；;\n';
/** 软断点：只作为超长句的兜底回退点 */
const SOFT = '，,、：:~—';

/** 默认阈值：首句 8 字（快速开口）、后续 14 字、单段上限 90 字 */
const DEFAULT_OPTS = { minFirst: 8, min: 14, max: 90 };

/**
 * 把下标对齐到"图形簇边界"（只用于超长句的兜底硬切）。
 *
 * 为什么需要：兜底是按 `max` 直接切的，切点可能正好落在一个 emoji 中间
 * （`buf.slice` 以 UTF-16 码元为单位）——那会切出孤立的高/低代理项，
 * 送进 TTS 就是乱码或报错，下一段还会以半个字符开头。
 * 项目规范（ARCHITECTURE.md 3.17）要求 emoji 一律走 `toGraphemes()`：这里就用它算安全切点。
 *
 * @param {string} text 待切文本
 * @param {number} cut 期望切点（码元下标）
 * @returns {number} 不超过 cut、且落在图形簇边界上的安全切点（至少 1，避免切出空串）
 */
function safeCut(text, cut) {
  const t = String(text == null ? '' : text);
  const want = Math.max(1, Math.min(Number(cut) || 1, t.length));
  try {
    const parts = toGraphemes(t);
    let acc = 0;
    for (const g of parts) {
      if (acc + g.length > want) break;
      acc += g.length;
    }
    // acc 落在边界上；若第一整个图形簇就超过 want，则退而取它的完整长度（宁可多一个字也不劈开）
    if (acc === 0) acc = parts.length ? parts[0].length : want;
    return Math.min(acc, t.length);
  } catch {
    return want;
  }
}

/**
 * 把用户传入的阈值规整成正整数（容错：非法值回落到默认值）。
 * @param {any} v 原始值
 * @param {number} fallback 默认值
 * @returns {number} 规整后的正整数
 */
function normThreshold(v, fallback) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 创建断句器。
 * @param {{ minFirst?: number, min?: number, max?: number }} [opts]
 *   minFirst 首句最小长度（更小 → 角色更快开口）；min 后续句最小长度；max 单段最大长度
 * @returns {{ push(chunk: string): string[], flush(): string[], reset(): void }}
 */
export function createSplitter(opts = {}) {
  const o = opts || {};
  const minFirst = normThreshold(o.minFirst, DEFAULT_OPTS.minFirst);
  let min = normThreshold(o.min, DEFAULT_OPTS.min);
  let max = normThreshold(o.max, DEFAULT_OPTS.max);
  // max 至少要比 min 大，否则会切出过碎的句子
  if (max < min) max = min;

  /** 当前未成句的缓冲 */
  let buf = '';
  /** 已经吐出的句子数（用于判断"是否首句"） */
  let emitted = 0;

  return {
    /**
     * 流式喂入一段文本，返回本次可以成句的句子数组（可能为空）。
     * @param {string} chunk 新到的文本片段
     * @returns {string[]} 本轮断出的句子（已 trim，不含空串）
     */
    push(chunk) {
      const out = [];
      if (typeof chunk === 'string' && chunk) buf += chunk;
      if (!buf) return out;

      // guard 兜底：任何意外都不允许死循环
      let guard = 0;
      while (guard++ < 200) {
        const threshold = emitted === 0 ? minFirst : min;
        let cut = -1;

        // 1) 找第一个满足长度阈值的硬标点
        for (let i = 0; i < buf.length; i++) {
          if (HARD.indexOf(buf[i]) >= 0 && i + 1 >= threshold) {
            cut = i + 1;
            break;
          }
        }

        // 2) 没有硬标点但缓冲过长 → 软标点回退，其次按 max 硬切
        if (cut < 0 && buf.length >= max) {
          let soft = -1;
          for (let i = 0; i < buf.length; i++) {
            if (SOFT.indexOf(buf[i]) >= 0) soft = i + 1;
          }
          // 兜底那一下必须落在图形簇边界上，否则会把 emoji / 代理对劈成两半
          cut = soft > threshold ? soft : safeCut(buf, max);
        }

        if (cut < 0 || cut > buf.length) break;

        const s = buf.slice(0, cut).trim();
        buf = buf.slice(cut);
        if (s) {
          out.push(s);
          emitted++;
        } else if (!buf) {
          break;
        }
      }
      return out;
    },

    /**
     * 收尾：把缓冲里剩下的残句吐出并清空缓冲。
     * @returns {string[]} 最后一句（已 trim，无内容则返回 []）
     */
    flush() {
      const s = buf.trim();
      buf = '';
      return s ? [s] : [];
    },

    /**
     * 清空缓冲与句数计数，回到全新状态（打断 / 切换角色时调用）。
     * @returns {void}
     */
    reset() {
      buf = '';
      emitted = 0;
    },
  };
}

export default createSplitter;
