/**
 * 极简事件总线 —— 所有跨模块通信都走这里，避免模块间直接互相依赖。
 * 事件名白名单见 docs/ARCHITECTURE.md 第 3.1 节。
 */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

export const bus = {
  /**
   * 订阅事件
   * @param {string} evt
   * @param {Function} fn
   * @returns {() => void} 取消订阅函数
   */
  on(evt, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = listeners.get(evt);
    if (!set) {
      set = new Set();
      listeners.set(evt, set);
    }
    set.add(fn);
    return () => bus.off(evt, fn);
  },

  /**
   * 取消订阅
   * @param {string} evt
   * @param {Function} fn
   */
  off(evt, fn) {
    const set = listeners.get(evt);
    if (set) set.delete(fn);
  },

  /**
   * 只触发一次
   * @param {string} evt
   * @param {Function} fn
   */
  once(evt, fn) {
    const off = bus.on(evt, (payload) => {
      off();
      fn(payload);
    });
    return off;
  },

  /**
   * 广播事件；单个监听器抛错不影响其他监听器
   * @param {string} evt
   * @param {any} [payload]
   */
  emit(evt, payload) {
    const set = listeners.get(evt);
    if (!set || !set.size) return;
    // 复制一份，避免监听器内部增删导致遍历异常
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] 监听器执行出错: ${evt}`, err);
      }
    }
  },

  /** 清空所有监听（测试用） */
  clear() {
    listeners.clear();
  },
};

export default bus;
