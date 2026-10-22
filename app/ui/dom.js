/**
 * DOM 构建工具（契约 3.3）。
 * 所有 UI 模块都用 el() 构建 DOM，避免 innerHTML 注入用户内容。
 */

/**
 * 创建元素
 * @param {string} tag 支持 'div' 或 'div.cls#id'
 * @param {object} [props] 属性集合
 * @param {...any} children 子节点（字符串会被转成文本节点）
 * @returns {HTMLElement}
 */
export function el(tag, props, ...children) {
  let tagName = 'div';
  let id = '';
  const classes = [];

  const raw = String(tag || 'div').trim();
  const m = raw.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (m) {
    tagName = m[1] || 'div';
    const rest = m[2] || '';
    const parts = rest.split(/(?=[.#])/).filter(Boolean);
    for (const p of parts) {
      if (p[0] === '#') id = p.slice(1);
      else if (p[0] === '.') classes.push(p.slice(1));
    }
  } else {
    tagName = raw;
  }

  const node = document.createElement(tagName);
  if (id) node.id = id;
  if (classes.length) node.classList.add(...classes);

  if (props && typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') {
        String(value)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => node.classList.add(c));
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key === 'html') {
        // 只允许传入内部可信常量字符串
        node.innerHTML = String(value);
      } else if (key === 'style') {
        if (typeof value === 'string') node.style.cssText = value;
        else {
          for (const [k, v] of Object.entries(value)) {
            if (v == null) continue;
            // setProperty 只接受连字符属性名（'white-space'），传驼峰（'whiteSpace'）会被
            // 静默忽略 —— 曾经因此有一批内联样式（whiteSpace/marginTop/maxHeight…）全部失效。
            // 这里统一转成连字符，两种写法都能用。
            const prop = k.startsWith('--') || k.includes('-') ? k : camelToKebab(k);
            node.style.setProperty(prop, String(v));
          }
        }
      } else if (key === 'dataset') {
        for (const [k, v] of Object.entries(value)) if (v != null) node.dataset[k] = String(v);
      } else if (key === 'on') {
        for (const [evt, fn] of Object.entries(value)) {
          if (typeof fn === 'function') node.addEventListener(evt, fn);
        }
      } else if (key === 'attr') {
        for (const [k, v] of Object.entries(value)) if (v != null) node.setAttribute(k, String(v));
      } else if (key in node && key !== 'list' && key !== 'type' && typeof node[key] === 'boolean') {
        node[key] = Boolean(value);
      } else if (key === 'value') {
        node.value = String(value);
      } else if (key === 'type' || key === 'placeholder' || key === 'disabled' || key === 'checked') {
        if (typeof node[key] === 'boolean') node[key] = Boolean(value);
        else node.setAttribute(key, String(value));
      } else {
        node.setAttribute(key, String(value));
      }
    }
  } else if (props != null) {
    children.unshift(props);
  }

  appendChildren(node, children);
  return node;
}

/** camelCase → kebab-case（whiteSpace → white-space；已带连字符或自定义属性原样返回） */
function camelToKebab(k) {
  return String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function appendChildren(node, children) {
  for (const child of children.flat(4)) {
    if (child == null || child === false || child === true) continue;
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** 文档片段 */
export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/** querySelector */
export function qs(sel, root = document) {
  return root.querySelector(sel);
}

/** querySelectorAll → 数组 */
export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** 清空子节点 */
export function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 清空并挂载 */
export function mount(parent, ...children) {
  if (!parent) return parent;
  clear(parent);
  appendChildren(parent, children);
  return parent;
}

/**
 * 事件绑定（带选择器委托）
 * @param {EventTarget} target
 * @param {string} evt
 * @param {string|Function} selOrFn 选择器或处理函数
 * @param {Function} [fn]
 * @returns {() => void} 解绑函数
 */
export function on(target, evt, selOrFn, fn) {
  let handler;
  if (typeof selOrFn === 'function') {
    handler = selOrFn;
  } else {
    const selector = String(selOrFn);
    handler = (e) => {
      const t = e.target instanceof Element ? e.target.closest(selector) : null;
      if (t && target.contains(t)) fn.call(t, e, t);
    };
  }
  target.addEventListener(evt, handler);
  return () => target.removeEventListener(evt, handler);
}

/** 让 textarea 随内容自动增高 */
export function autoGrow(textarea, max = 160) {
  if (!textarea) return;
  const resize = () => {
    textarea.style.height = 'auto';
    const h = Math.min(max, textarea.scrollHeight);
    textarea.style.height = `${Math.max(38, h)}px`;
    textarea.style.overflowY = textarea.scrollHeight > max ? 'auto' : 'hidden';
  };
  textarea.addEventListener('input', resize);
  // 初始
  requestAnimationFrame(resize);
  return resize;
}

/**
 * 滚到底部
 * @param {HTMLElement} node
 * @param {boolean} [smooth] true = 平滑滚动；false = **立即**到底（初始载入用这个）
 */
export function scrollToBottom(node, smooth = true) {
  if (!node) return;
  // smooth=false 必须传 'instant'，不能传 'auto'：'auto' 的含义是"用元素 CSS 上的
  // scroll-behavior"，而 .chat-body 上是 smooth —— 那样"立即到底"其实是一段约 1.2 秒的动画，
  // 刷新后就会看到"先停在顶部、再一路滑到底"（实测 56 个中间帧）。
  node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

/** 是否已接近底部（决定流式时要不要自动跟随） */
export function isNearBottom(node, threshold = 80) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < threshold;
}
