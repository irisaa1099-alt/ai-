/* eslint-env serviceworker */
/**
 * sw.js —— Service Worker（离线缓存）
 * ---------------------------------------------------------------------------
 * 策略：
 *   1. install：预缓存下面 PRECACHE 里逐个列出的静态资源（清单与仓库文件一一对应）。
 *      采用"逐个 add + 单独 catch"，某个文件缺失（例如尚未落盘的模块）不会让整次安装失败。
 *   2. fetch：
 *      · 非 GET、跨域、/api/ 开头的请求 → 完全不拦截，直接走网络（透传，绝不缓存）。
 *        这样 /api/llm 的 SSE 流式响应不会被破坏。
 *      · 同源静态资源 → network-first：优先读取当前版本，网络不可用时回退缓存。
 *      · 网络不可用且没有缓存时，导航请求回退到缓存的 index.html，保证离线仍能打开页面。
 *   3. activate：删除旧版本缓存，并立即接管页面。
 * ---------------------------------------------------------------------------
 */

/** v69：语音输入会话隔离、群聊朗读与长消息分段修复。 */
const CACHE = 'aichat-v69';

/** 预缓存的静态资源清单（路径与 app/ 目录下的真实文件一致） */
const PRECACHE = [
  // 入口与页面
  './',
  './index.html',
  // 样式
  './styles/base.css',
  './styles/app.css',
  // PWA
  './manifest.webmanifest',
  './icon.svg',
  // core
  './core/bus.js',
  './core/util.js',
  './core/store.js',
  './core/local-model.js',
  './core/sync.js',
  './core/entity-sync.js',
  './core/outbox.js',
  './core/runtime.js',
  './core/prompt.js',
  './core/recent.js',
  './core/memory.js',
  './core/memory-correction.js',
  './core/llm.js',
  './core/proactive.js',
  './core/filestore.js',
  './core/group.js',
  './core/werewolf.js',
  // data
  './data/models.js',
  './data/templates.js',
  // voice
  './voice/splitter.js',
  './voice/tts.js',
  './voice/stt.js',
  // ui
  './ui/shared.js',
  './ui/dom.js',
  './ui/message-list.js',
  './ui/sync-conflicts.js',
  './ui/icons.js',
  './ui/toast.js',
  './ui/sidebar.js',
  './ui/chat.js',
  './ui/groupchat.js',
  './ui/werewolf.js',
  './ui/groupeditor.js',
  './ui/favorites.js',
  './ui/editor.js',
  './ui/settings.js',
  './ui/app.js',
];

/** 离线时导航请求的兜底页面（按优先级） */
const FALLBACK_PAGES = ['./index.html', './'];

/* ===========================================================================
 * 安装：预缓存
 * ======================================================================== */

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 逐个缓存：单个 404 / 网络错误不会让整次 install 失败
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            // 某个资源暂时不可用（例如还没写好）时静默跳过，运行时再按需缓存
            return undefined;
          })
        )
      );
      // 新版本立即待命，用户刷新即生效
      await self.skipWaiting();
    })()
  );
});

/* ===========================================================================
 * 激活：清理旧缓存
 * ======================================================================== */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key === CACHE) return undefined;
          // 只清理本应用自己的缓存，别动同源下别的应用
          if (!key.startsWith('aichat-')) return undefined;
          return caches.delete(key);
        })
      );
      await self.clients.claim();
    })()
  );
});

/* ===========================================================================
 * fetch：network-first
 * ======================================================================== */

/**
 * 判断是否应当交给本 SW 处理（可缓存）
 * @param {Request} request
 * @returns {boolean}
 */
function isCacheable(request) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // 跨域（模型供应商接口等）一律不拦截
  if (url.origin !== self.location.origin) return false;
  // 后端接口一律不缓存，直接透传
  if (url.pathname.startsWith('/api/')) return false;
  return true;
}

/**
 * network-first：优先取当前版本，离线时使用缓存
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });

  /** 后台更新（不阻塞返回） */
  const revalidate = fetch(request)
    .then((response) => {
      // 只缓存成功的同源基础响应（opaque / 206 等不能 put）
      if (response && response.ok && response.type === 'basic' && response.status === 200) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  const fresh = await revalidate;
  if (fresh) return fresh;
  if (cached) return cached;

  // 既没有缓存也联不上网
  if (request.mode === 'navigate') {
    const page = await matchFallback(cache);
    if (page) return page;
  }
  return new Response('当前离线，且这个资源没有缓存。', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * 找离线兜底页面
 * @param {Cache} cache
 * @returns {Promise<Response|undefined>}
 */
async function matchFallback(cache) {
  for (const url of FALLBACK_PAGES) {
    const hit = await cache.match(url);
    if (hit) return hit;
  }
  // 再宽松一点：任何以 index.html 结尾的缓存都能兜底
  const keys = await cache.keys();
  for (const req of keys) {
    if (new URL(req.url).pathname.endsWith('/index.html') || new URL(req.url).pathname === '/') {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
  }
  return undefined;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // /api/ 与跨域请求：不调用 respondWith，直接由浏览器透传（流式响应不受影响）
  if (!isCacheable(request)) return;

  event.respondWith(networkFirst(request));
});

/* ===========================================================================
 * 消息：允许页面主动要求立即更新 SW
 * ======================================================================== */

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'skip-waiting' || (data && data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
});
