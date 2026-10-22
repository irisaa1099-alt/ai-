/**
 * 轻提示、确认框、输入框、通用弹层（契约 3.5）。
 * 全站禁止使用 alert/confirm，一律走这里。
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';

let toastLayer = null;
let modalLayer = null;

function ensureLayers() {
  if (!toastLayer || !document.body.contains(toastLayer)) {
    toastLayer = el('div.toast-layer');
    document.body.appendChild(toastLayer);
  }
  if (!modalLayer || !document.body.contains(modalLayer)) {
    modalLayer = el('div.modal-layer');
    document.body.appendChild(modalLayer);
  }
  return { toastLayer, modalLayer };
}

/**
 * 轻提示
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'error'} [type]
 * @param {number} [ms]
 */
export function toast(msg, type = 'info', ms = 2600) {
  const { toastLayer: layer } = ensureLayers();
  const iconName =
    type === 'ok' ? 'check' : type === 'warn' ? 'clock' : type === 'error' ? 'bell' : 'sparkles';
  const node = el(
    `div.toast.toast-${type}`,
    el('span.toast-ic', icon(iconName, 16)),
    el('span.toast-msg', { text: String(msg == null ? '' : msg) })
  );
  layer.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  const life = type === 'error' ? Math.max(ms, 4200) : ms;
  const timer = setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 260);
  }, life);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });
  return node;
}

/** 关闭最上层弹层 */
export function closeTopModal() {
  const open = Array.from(document.querySelectorAll('.modal-mask'));
  const last = open[open.length - 1];
  if (last && typeof last.__close === 'function') {
    last.__close();
    return true;
  }
  return false;
}

/** 是否有打开的弹层 */
export function hasOpenModal() {
  return document.querySelectorAll('.modal-mask').length > 0;
}

/**
 * 通用弹层
 * @param {{title:string, body:Node|string, width?:number,
 *   actions?:Array<{text:string, kind?:'primary'|'ghost'|'danger', onClick?:(close:()=>void)=>void, keepOpen?:boolean}>}} opts
 * @returns {{close:()=>void, root:HTMLElement, body:HTMLElement}}
 */
export function modal(opts) {
  const { modalLayer: layer } = ensureLayers();
  const { title = '', body = '', width = 520, actions = [] } = opts || {};

  const bodyEl = el('div.modal-body');
  if (body instanceof Node) bodyEl.appendChild(body);
  else
    bodyEl.appendChild(
      el('div', { text: String(body) })
    );

  const footEl = el('div.modal-foot');
  const root = el(
    'div.modal',
    { style: { width: `min(${width}px, 94vw)` } },
    el(
      'div.modal-head',
      el('div.modal-title', { text: title }),
      el('button.icon-btn', { title: '关闭', on: { click: () => close() } }, icon('close', 18))
    ),
    bodyEl,
    actions.length ? footEl : null
  );

  const mask = el('div.modal-mask', root);

  const close = () => {
    mask.classList.remove('in');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => mask.remove(), 180);
  };
  mask.__close = close;

  for (const a of actions) {
    const btn = el(
      `button.btn${a.kind === 'primary' ? '.btn-primary' : a.kind === 'danger' ? '.btn-danger' : ''}`,
      {
        text: a.text,
        on: {
          click: () => {
            const res = a.onClick ? a.onClick(close) : undefined;
            if (res !== false && !a.keepOpen) close();
          },
        },
      }
    );
    footEl.appendChild(btn);
  }

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', onKey, true);

  layer.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('in'));

  // 自动聚焦第一个输入框
  const firstInput = bodyEl.querySelector('input, textarea, select');
  if (firstInput) setTimeout(() => firstInput.focus(), 60);

  return { close, root, body: bodyEl };
}

/**
 * 确认对话框
 * @param {{title:string,message?:string,okText?:string,cancelText?:string,danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  const { title, message = '', okText = '确定', cancelText = '取消', danger = false } = opts || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const body = el(
      'div',
      message ? el('p.confirm-text', { text: message }) : null
    );
    const m = modal({
      title,
      body,
      width: 420,
      actions: [
        { text: cancelText, onClick: () => finish(false) },
        { text: okText, kind: danger ? 'danger' : 'primary', onClick: () => finish(true) },
      ],
    });
    // 若用户按 Esc / 点遮罩关闭，视为取消
    const observer = new MutationObserver(() => {
      if (!document.body.contains(m.root)) {
        observer.disconnect();
        finish(false);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * 输入对话框
 * @param {{title:string,label?:string,value?:string,placeholder?:string,multiline?:boolean}} opts
 * @returns {Promise<string|null>}
 */
export function promptDialog(opts) {
  const { title, label = '', value = '', placeholder = '', multiline = false } = opts || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const input = multiline
      ? el('textarea.input', { value, placeholder, rows: 4 })
      : el('input.input', { value, placeholder, type: 'text' });
    const body = el('div', label ? el('label.field-label', { text: label }) : null, input);
    const m = modal({
      title,
      body,
      width: 440,
      actions: [
        { text: '取消', onClick: () => finish(null) },
        {
          text: '确定',
          kind: 'primary',
          onClick: () => finish(String(input.value || '').trim() || null),
        },
      ],
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(String(input.value || '').trim() || null);
        m.close();
      }
    });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(m.root)) {
        observer.disconnect();
        finish(null);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * 底部/中部动作面板（移动端菜单）
 * @param {{title?:string, items:Array<{text:string, icon?:string, danger?:boolean, onClick:()=>void}>}} opts
 */
export function actionSheet(opts) {
  const { title = '', items = [] } = opts || {};
  const list = el('div.sheet-list');
  const m = modal({
    title,
    body: list,
    width: 420,
    actions: [],
  });
  for (const it of items) {
    list.appendChild(
      el(
        `button.sheet-item${it.danger ? '.danger' : ''}`,
        {
          on: {
            click: () => {
              m.close();
              setTimeout(() => it.onClick && it.onClick(), 120);
            },
          },
        },
        it.icon ? icon(it.icon, 18) : null,
        el('span', { text: it.text })
      )
    );
  }
  return m;
}

/** 清空所有弹层（切换会话时用） */
export function closeAllModals() {
  document.querySelectorAll('.modal-mask').forEach((n) => {
    if (typeof n.__close === 'function') n.__close();
    else n.remove();
  });
}

// 导出给 placeholders 用
export { clear };
