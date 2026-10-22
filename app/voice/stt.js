/**
 * voice/stt.js —— 语音输入（Speech To Text）
 *
 * 契约：ARCHITECTURE.md 3.13
 *   export function sttAvailable(): boolean
 *   export function createRecognizer(opts?: { lang?, interim?, onResult?, onEnd?, onError?,
 *                                            silenceMs?, onSilence? }):
 *     { start(): void, stop(): void, get listening(): boolean }
 *
 * 实现要点：
 *   1. 封装 webkitSpeechRecognition || SpeechRecognition（Chrome / Edge 可用）；
 *   2. continuous = true、interimResults 可配、lang 可配（默认 zh-CN）；
 *   3. onresult 里拼接"本次最终文本"，回调 onResult(text, isFinal)；
 *   4. 自动重启：用户没有主动 stop 时，遇到 onend 或 no-speech 错误后延迟 400ms 重启，最多连续 5 次；
 *   5. start() 幂等；stop() 之后不再重启；不支持时 start() 触发 onError。
 *   6. 静默自动停止：连续 silenceMs（默认 8s）没有任何识别结果就主动收工并回调 onSilence，
 *      避免"麦克风一直开着、又没在说话"时界面长期停在"正在听…"；
 *      静默计时跨自动重启累计（不会因为重启一次就重新数 8 秒）。
 *   7. 任何异常都不向外抛（受限环境安全降级）。
 */

/** 浏览器不支持语音识别时的统一提示文案 */
export const STT_UNSUPPORTED_MSG = '当前浏览器不支持语音识别，请使用 Chrome 或 Edge';

/** 自动重启延迟（毫秒） */
const RESTART_DELAY = 400;
/** 最大连续自动重启次数 */
const MAX_RESTARTS = 5;
/** 默认静默自动停止：连续多久没有识别结果就收工（毫秒） */
const DEFAULT_SILENCE_MS = 8000;
/** 静默看门狗的检查间隔 */
const SILENCE_POLL = 500;

/**
 * 取得当前环境的 SpeechRecognition 构造函数。
 * @returns {Function|null} 构造函数；不支持时返回 null
 */
function getSR() {
  try {
    if (typeof globalThis === 'undefined') return null;
    return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
  } catch (e) {
    return null;
  }
}

/**
 * 是否支持语音识别。
 * @returns {boolean} true 表示可用
 */
export function sttAvailable() {
  return typeof getSR() === 'function';
}

/**
 * 创建语音识别器。
 * @param {{ lang?: string, interim?: boolean,
 *           onResult?: (text: string, isFinal: boolean) => void,
 *           onEnd?: () => void, onError?: (err: any) => void }} [opts] 配置与回调
 * @returns {{ start(): void, stop(): void, readonly listening: boolean }} 识别器控制句柄
 */
export function createRecognizer(opts = {}) {
  const o = opts || {};
  const lang = typeof o.lang === 'string' && o.lang ? o.lang : 'zh-CN';
  const interim = o.interim === true;
  const onResult = typeof o.onResult === 'function' ? o.onResult : null;
  const onEnd = typeof o.onEnd === 'function' ? o.onEnd : null;
  const onError = typeof o.onError === 'function' ? o.onError : null;
  const onSilence = typeof o.onSilence === 'function' ? o.onSilence : null;
  const silenceMs = Number.isFinite(Number(o.silenceMs)) && Number(o.silenceMs) > 0
    ? Number(o.silenceMs)
    : DEFAULT_SILENCE_MS;

  const SR = getSR();
  /** @type {any} 原生识别实例 */
  let rec = null;
  let listening = false;
  /** 用户是否主动停止（true 时不再自动重启） */
  let stopped = true;
  /** 连续自动重启计数 */
  let restarts = 0;
  /** 重启定时器 */
  let restartTimer = null;
  /** 本次会话已经确定的最终文本（用于拼接多段最终结果） */
  let finalText = '';
  /** 本轮监听是否已经通知过 onEnd（避免 stop() 与原生 onend 重复回调） */
  let endedNotified = false;
  /** 最近一次"有识别结果"的时间（静默看门狗用；跨自动重启累计） */
  let lastResultAt = 0;
  /** 静默看门狗定时器 */
  let silenceTimer = null;

  /**
   * 安全调用回调（回调内部异常不影响识别流程）。
   * @param {Function|null} fn 回调
   * @param {...any} args 参数
   * @returns {void}
   */
  const emit = (fn, ...args) => {
    if (!fn) return;
    try { fn(...args); } catch (e) { /* 忽略回调异常 */ }
  };

  /** 创建原生实例并绑定事件 */
  function build() {
    if (!SR) return null;
    let r;
    try {
      r = new SR();
    } catch (e) {
      return null;
    }
    r.lang = lang;
    r.continuous = true;
    r.interimResults = interim;
    r.maxAlternatives = 1;

    r.onresult = (e) => {
      let interimText = '';
      let gotFinal = false;
      try {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const txt = res[0] && res[0].transcript ? res[0].transcript : '';
          if (res.isFinal) {
            finalText += txt;
            gotFinal = true;
          } else {
            interimText += txt;
          }
        }
      } catch (err) { /* 结果结构异常：忽略本次 */ }
      // 识别有进展 → 重置连续重启计数与静默计时
      restarts = 0;
      lastResultAt = Date.now();
      if (gotFinal && finalText.trim()) {
        const text = finalText.trim();
        finalText = '';
        emit(onResult, text, true);
      }
      if (!gotFinal && interimText.trim()) {
        emit(onResult, interimText.trim(), false);
      }
    };

    r.onerror = (e) => {
      const code = e && e.error ? String(e.error) : 'unknown';
      // 用户主动停止 / 被 abort 打断：不算错误
      if (code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        stopped = true;
        emit(onError, new Error('麦克风权限被拒绝，请在浏览器地址栏允许使用麦克风'));
        return;
      }
      if (code === 'audio-capture') {
        stopped = true;
        emit(onError, new Error('没有检测到可用的麦克风设备'));
        return;
      }
      if (code === 'network') {
        emit(onError, new Error('语音识别网络异常，请检查网络后重试'));
        return;
      }
      // no-speech 等：交给 onend 里的自动重启逻辑处理，避免重复提示
      if (code !== 'no-speech') {
        emit(onError, new Error('语音识别失败：' + code));
      }
    };

    r.onend = () => {
      listening = false;
      // 用户没主动停止 → 自动重启（最多连续 MAX_RESTARTS 次）
      if (!stopped && restarts < MAX_RESTARTS) {
        restarts++;
        scheduleRestart();
        return;
      }
      if (!stopped && restarts >= MAX_RESTARTS) {
        stopped = true;
        emit(onError, new Error('语音识别连续中断，已自动停止；请点击麦克风重试'));
      }
      notifyEnd();
    };

    return r;
  }

  /** 只通知一次 onEnd */
  function notifyEnd() {
    if (endedNotified) return;
    endedNotified = true;
    emit(onEnd);
  }

  /** 停掉静默看门狗 */
  function stopSilenceWatch() {
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
  }

  /**
   * 静默看门狗：连续 silenceMs 没有识别结果就主动收工（不再自动重启）并回调 onSilence。
   * 计时基于 lastResultAt，所以自动重启不会把 8 秒重新数一遍。
   */
  function startSilenceWatch() {
    if (silenceTimer || !silenceMs) return;
    lastResultAt = Date.now();
    silenceTimer = setInterval(() => {
      if (stopped) { stopSilenceWatch(); return; }
      if (Date.now() - lastResultAt < silenceMs) return;
      stopSilenceWatch();
      stopped = true;                       // 收工：不再自动重启
      restarts = 0;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      const wasListening = listening;
      listening = false;
      if (rec) { try { rec.stop(); } catch (e) { /* 忽略 */ } }
      emit(onSilence);
      if (wasListening) notifyEnd();
    }, SILENCE_POLL);
  }

  /** 延迟重启 */
  function scheduleRestart() {
    if (restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped) return;
      start();
    }, RESTART_DELAY);
  }

  /** 启动识别（幂等；不支持时通过 onError 提示） */
  function start() {
    if (!SR) {
      emit(onError, new Error(STT_UNSUPPORTED_MSG));
      return;
    }
    if (listening) return;
    stopped = false;
    endedNotified = false;
    if (!rec) {
      rec = build();
      if (!rec) {
        stopped = true;
        emit(onError, new Error(STT_UNSUPPORTED_MSG));
        return;
      }
    }
    finalText = '';
    try {
      rec.start();
      listening = true;
      startSilenceWatch();
    } catch (e) {
      // 连续 start() 会抛 InvalidStateError —— 视为"已经在听"
      const msg = String((e && e.message) || e || '');
      if (msg.indexOf('already started') >= 0) {
        listening = true;
        return;
      }
      emit(onError, e || new Error('语音识别启动失败'));
    }
  }

  /** 停止识别（之后不再自动重启） */
  function stop() {
    stopped = true;
    restarts = 0;
    stopSilenceWatch();
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const wasListening = listening;
    listening = false;
    if (rec) {
      try { rec.stop(); } catch (e) { /* 未启动时 stop 会抛错，忽略 */ }
    }
    if (wasListening) notifyEnd();
  }

  return {
    start,
    stop,
    /** @returns {boolean} 是否正在识别 */
    get listening() {
      return listening;
    },
  };
}

export default createRecognizer;
