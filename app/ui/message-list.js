/** 私聊与群聊共用的分页和节点协调；不参与消息生成、记忆或语音。 */
import { el } from './dom.js';

const lists = new WeakMap();

/** 根据稳定键复用节点：只替换有变化的气泡，保留其余节点及浏览位置。 */
export function reconcileMessageList(list, entries) {
  const previous = lists.get(list) || new Map();
  const next = new Map();
  const nodes = [];
  for (const entry of entries) {
    const old = previous.get(entry.key);
    const node = entry.node || (old?.value === entry.value ? old.node : entry.create());
    next.set(entry.key, { value: entry.value, node });
    nodes.push(node);
  }
  const desired = new Set(nodes);
  for (const child of [...list.childNodes]) if (!desired.has(child)) child.remove();
  let cursor = list.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(node, cursor);
  }
  lists.set(list, next);
}

/** 新会话先取 100 条，点击后再取更早一页；旧异步请求不能覆盖新会话。 */
export function createHistoryPager(readPage) {
  let limit = 100, hasMore = false, request = 0;
  return {
    reset() { limit = 100; hasMore = false; request++; },
    async read(id, opts = {}) {
      const token = ++request;
      let page;
      try { page = await readPage(id, { limit: limit + (opts.more ? 100 : 0), includeId: opts.includeId }); }
      catch (err) { if (token !== request) return null; throw err; }
      if (token !== request) return null;
      limit = page.limit || limit;
      hasMore = page.hasMore;
      return page.messages;
    },
    olderEntry(list, reload) {
      if (!hasMore) return [];
      return [{ key: 'older', value: 'older', create: () => el('button.btn.history-more', {
        type: 'button', text: '加载更早的消息',
        on: { click: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          const height = list.scrollHeight, top = list.scrollTop;
          try {
            await reload({ more: true });
            if (list.isConnected) list.scrollTop = top + list.scrollHeight - height;
          } finally { button.disabled = false; }
        } },
      }) }];
    },
  };
}
