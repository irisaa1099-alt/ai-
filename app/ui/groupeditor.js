/**
 * ui/groupeditor.js —— 群聊的「建群 / 改群资料 / 拉人进群」界面
 * ---------------------------------------------------------------------------
 * 一个群聊只有三件事要配置，所以这里也只做三块：
 *   1. 群名片：群名、emoji、主题色、群主题（会作为场景设定注入提示词）
 *   2. 成员：从好友列表里勾人（至少 2 位，最多 24 位），支持搜索
 *   3. 接话方式：谁来说、一轮最多几个人说、角色之间隔多久
 *
 * 导出：
 *   openGroupEditor(groupOrNull, opts?)  —— null = 新建；带 group = 编辑
 *   openMemberPicker(group, onSaved)     —— 只加人（群聊界面里的「＋拉人」）
 *
 * 约定：全部 DOM 用 el() 构建；用户输入只走文本节点，不拼 innerHTML。
 */

import { el, clear, mount } from './dom.js';
import { avatarNode } from './shared.js';
import { icon } from './icons.js';
import { modal, toast } from './toast.js';
import { TURN_MODES } from '../core/group.js';
import {
  listCharacters,
  saveGroup,
  setGroupMembers,
  getSettings,
  GROUP_TURN_MODES,
  GROUP_MEMBER_LIMIT,
} from '../core/store.js';
import { firstChar, num } from '../core/util.js';

/** 可选的主题色（与角色卡的取色习惯一致） */
const COLORS = ['#6c8cff', '#4ec9a8', '#e0b341', '#ff6b6b', '#c084fc', '#38bdf8', '#fb923c', '#f472b6'];

/** 可选 emoji */
const EMOJIS = ['💬', '🎭', '🍻', '🌙', '🔥', '🎮', '☕️', '🏫', '🚀', '🌊', '🎬', '🧩'];

/** 头像是否图片 */
/** 小头像节点（图片 > emoji > 首字） */
/**
 * 成员多选列表（可复用的核心部件）
 * @param {object[]} all 全部角色
 * @param {Set<string>} selected 已选中的角色 id
 * @param {(id:string, on:boolean)=>void} onChange
 * @returns {{root: HTMLElement, selected: Set<string>}}
 */
function memberPicker(all, selected, onChange) {
  const root = el('div.ge-members');
  const search = el('input.input', { type: 'search', placeholder: '搜索好友（名字 / 标签）', 'aria-label': '搜索好友' });
  const list = el('div.ge-member-list');
  const chosen = el('div.ge-chosen');

  const byId = new Map(all.map((c) => [String(c.id), c]));

  const renderChosen = () => {
    clear(chosen);
    if (!selected.size) {
      chosen.appendChild(el('span.field-hint', { text: '还没有选人。至少选 2 位角色，群聊才聊得起来。' }));
      return;
    }
    for (const id of selected) {
      const c = byId.get(id) || { name: '已删除的角色' };
      chosen.appendChild(
        el(
          'span.chip.on.ge-chip',
          { title: '点击移除' },
          el('span', { text: c.emoji || firstChar(c.name || '?') }),
          el('span', { text: c.name || '未知' }),
          el(
            'span.x',
            {
              on: {
                click: () => {
                  selected.delete(id);
                  onChange(id, false);
                  renderChosen();
                  // 只是取消选中，列表内容没变 —— 必须保住滚动位置，否则会跳回最上方
                  renderList({ keepScroll: true });
                },
              },
            },
            icon('close', 12)
          )
        )
      );
    }
  };

  /**
   * 重画好友列表
   * @param {{keepScroll?:boolean}} [opts] keepScroll=true 时保留原滚动位置。
   *
   * 为什么需要这个开关：`.ge-member-list` 是带 max-height 的滚动容器，
   * 而"每次勾选都重建整张列表"会把滚动位置丢掉 —— 实测列表滚到底时点一下，
   * scrollTop 从 658 直接变 0（滚在中段时侥幸保住，因为清空与重建之间没有布局），
   * 表现就是"勾一个角色，列表自己跳回最上方"。
   * 所以选人/取消选中的路径一律保住滚动位置（能就地更新更好，见下面的行点击），
   * 只有搜索词变化时才回到顶部（那是用户主动换了结果集）。
   */
  const renderList = (opts = {}) => {
    const keepTop = opts.keepScroll ? list.scrollTop : null;
    const kw = String(search.value || '').trim().toLowerCase();
    const rows = all.filter((c) => {
      if (!kw) return true;
      return [c.name, (c.tags || []).join(' '), c.tagline, c.group]
        .map((s) => String(s == null ? '' : s))
        .join(' ')
        .toLowerCase()
        .includes(kw);
    });
    clear(list);
    if (!rows.length) {
      list.appendChild(el('div.field-hint', { text: '没有匹配的好友' }));
      list.scrollTop = 0;
      return;
    }
    for (const c of rows) {
      const id = String(c.id);
      const on = selected.has(id);
      // 勾选标记单独拿一个引用：点击时就地替换它，不必重建整行
      const checkBox = el('span.ge-check', on ? icon('check', 15) : null);
      const row = el(
        'button.ge-member',
        {
          type: 'button',
          class: on ? 'on' : '',
          on: {
            click: () => {
              if (selected.has(id)) {
                selected.delete(id);
              } else {
                if (selected.size >= GROUP_MEMBER_LIMIT) {
                  toast(`一个群最多 ${GROUP_MEMBER_LIMIT} 位成员`, 'warn');
                  return;
                }
                selected.add(id);
              }
              const nowOn = selected.has(id);
              // 就地更新这一行（而不是重建列表）：重建会把滚动位置和键盘焦点一起丢掉，
              // 用户勾一个人就得重新滚回原来的位置
              row.classList.toggle('on', nowOn);
              mount(checkBox, nowOn ? icon('check', 15) : null);
              onChange(id, nowOn);
              renderChosen();
            },
          },
        },
        avatarNode(c, 'sm'),
        el(
          'span.ge-member-main',
          el('span.ge-member-name', { text: c.name || '未命名' }),
          el('span.ge-member-sub', {
            text: [c.tagline, (c.tags || []).slice(0, 2).join('/')].filter(Boolean).join(' · ') || '（没有简介）',
          })
        ),
        checkBox
      );
      list.appendChild(row);
    }
    // 重建完统一落位，别指望"清空会把 scrollTop 归零"：
    // Chrome 里"清空 + 同步重建"之间没有布局，滚动位置会侥幸留下来，
    // 换成 Firefox / Safari 就又丢一次 —— 显式赋值才能让各浏览器表现一致。
    list.scrollTop = keepTop == null ? 0 : keepTop;
  };

  // 搜索词变了才允许回到顶部（结果集是新的）：这里显式不传 keepScroll，
  // 不要直接把事件对象当 opts 传进去
  search.addEventListener('input', () => renderList());
  root.append(chosen, search, list);
  renderChosen();
  renderList();
  return { root, selected };
}

/** 一排颜色选择 */
function colorRow(value, onPick) {
  const row = el('div.ge-colors');
  for (const c of COLORS) {
    const dot = el('button.ge-dot', {
      type: 'button',
      title: c,
      style: { background: c },
      class: String(value).toLowerCase() === c.toLowerCase() ? 'on' : '',
      on: {
        click: () => {
          onPick(c);
          for (const n of row.children) n.classList.toggle('on', n.title.toLowerCase() === c.toLowerCase());
        },
      },
    });
    row.appendChild(dot);
  }
  return row;
}

/** 一排 emoji 选择 */
function emojiRow(value, onPick) {
  const row = el('div.ge-emojis');
  for (const e of EMOJIS) {
    row.appendChild(
      el('button.ge-emoji', {
        type: 'button',
        text: e,
        class: e === value ? 'on' : '',
        on: {
          click: () => {
            onPick(e);
            for (const n of row.children) n.classList.toggle('on', n.textContent === e);
          },
        },
      })
    );
  }
  return row;
}

/** 接话策略选择（chips + 说明） */
function turnModeField(value, onChange) {
  const wrap = el('div');
  const desc = el('div.field-hint');
  const chips = el('div.row.wrap');
  const sync = (id) => {
    for (const n of chips.children) n.classList.toggle('on', n.dataset.mode === id);
    const m = TURN_MODES.find((x) => x.id === id);
    desc.textContent = m ? m.desc : '';
  };
  for (const m of TURN_MODES) {
    chips.appendChild(
      el('button.chip', {
        type: 'button',
        text: m.label,
        dataset: { mode: m.id },
        on: {
          click: () => {
            onChange(m.id);
            sync(m.id);
          },
        },
      })
    );
  }
  sync(value);
  wrap.append(chips, desc);
  return wrap;
}

/** 「一轮最多几个人说话」选择 */
/** 「一轮最多几位角色发言」的合法上限（与 core/store.js 的 clamp(..., 1, 8) 对齐） */
const MAX_AUTO_TURNS_LIMIT = 8;

function turnsField(value, onChange) {
  const sel = el('select.input', {
    value: String(value),
    on: { change: () => onChange(num(sel.value, 3)) },
  });
  const n = num(value, 3);
  for (let i = 1; i <= MAX_AUTO_TURNS_LIMIT; i++) {
    sel.appendChild(el('option', { value: String(i), text: `${i} 位角色发言` }));
  }
  // 兜底：值不在列表里（旧数据/导入的备份可能是 7、8）就补一个真实值的选项，
  // 否则浏览器会默认选中第一项，界面显示"1 位角色发言"而实际还是 7 —— 界面在骗人
  sel.value = String(n);
  if (sel.value !== String(n)) {
    sel.appendChild(el('option', { value: String(n), text: `${n} 位角色发言` }));
    sel.value = String(n);
  }
  return sel;
}

/** 「角色之间隔多久」选择 */
function delayField(value, onChange) {
  const opts = [
    [0, '不等待（连着说）'],
    [400, '0.4 秒（抢话感）'],
    [900, '0.9 秒（推荐）'],
    [1800, '1.8 秒（有思考感）'],
    [3000, '3 秒（慢节奏）'],
  ];
  const sel = el('select.input', {
    value: String(value),
    on: { change: () => onChange(num(sel.value, 900)) },
  });
  for (const [v, label] of opts) sel.appendChild(el('option', { value: String(v), text: label }));
  // 允许自定义值不在列表里时的兜底
  if (!opts.some(([v]) => String(v) === String(value))) {
    sel.appendChild(el('option', { value: String(value), text: `${num(value, 900) / 1000} 秒` }));
  }
  sel.value = String(value);
  return sel;
}

/** 开关（checkbox 行） */
function toggleField(label, desc, checked, onChange) {
  const input = el('input', { type: 'checkbox', checked: !!checked });
  input.addEventListener('change', () => onChange(!!input.checked));
  return el(
    'label.ge-toggle',
    input,
    el('span', el('b', { text: label }), el('span.ge-toggle-desc', { text: desc }))
  );
}

/**
 * 打开「新建群聊 / 编辑群聊」弹层
 * @param {object|null} groupOrNull null 表示新建
 * @param {{onSaved?:(group:object)=>void, focusMember?:boolean}} [opts]
 * @returns {{close:Function, root:HTMLElement, body:HTMLElement}}
 */
export function openGroupEditor(groupOrNull, opts = {}) {
  const isNew = !groupOrNull;
  const settings = getSettings();
  const gDefaults = settings.group || {};
  const base = groupOrNull
    ? { ...groupOrNull }
    : {
        name: '',
        emoji: '💬',
        color: (settings.accent || '#6c8cff'),
        topic: '',
        members: [],
        autoTalk: gDefaults.autoTalk !== false,
        turnMode: GROUP_TURN_MODES.includes(gDefaults.turnMode) ? gDefaults.turnMode : 'smart',
        maxAutoTurns: num(gDefaults.maxAutoTurns, 3),
        autoDelayMs: num(gDefaults.autoDelayMs, 900),
        autoVoice: gDefaults.autoVoice === true,
        everyoneSpeaks: gDefaults.everyoneSpeaks !== false,
        muteAll: false,
        mutedMembers: [],
      };

  const draft = { ...base, members: [...(base.members || [])].map(String) };

  const body = el('div.ge-body');
  const nameInput = el('input.input', {
    type: 'text',
    value: draft.name,
    placeholder: '给这个群起个名字，例如「周五夜聊会」',
    maxlength: '24',
  });
  const topicInput = el('textarea.input', {
    rows: 2,
    value: draft.topic,
    placeholder: '群主题 / 场景设定，会作为世界观注入提示词。例如「凌晨三点还亮着灯的居酒屋」',
  });
  const membersCount = el('span.field-hint');
  const allCharsBox = el('div');
  let picker = null;

  const colorPreview = el('span.ge-preview', { text: draft.emoji || '💬' });
  const applyPreview = () => {
    colorPreview.textContent = draft.emoji || '💬';
    colorPreview.style.background = draft.color;
  };
  applyPreview();

  /* ---------- 1. 群名片 ---------- */
  const cardSection = el(
    'div.ge-section',
    el('h4', { text: isNew ? '① 群名片' : '① 群资料' }),
    el(
      'div.ge-card-row',
      colorPreview,
      el(
        'div',
        { style: { flex: '1 1 auto', 'min-width': '0' } },
        el('div.field-label', { text: '群名' }),
        nameInput,
        el('div.field-label', { text: '群主题 / 场景（可选）', style: { 'margin-top': '8px' } }),
        topicInput
      )
    ),
    el('div.field-label', { text: '主题色' }),
    colorRow(draft.color, (c) => {
      draft.color = c;
      applyPreview();
    }),
    el('div.field-label', { text: '群头像 emoji' }),
    emojiRow(draft.emoji, (e) => {
      draft.emoji = e;
      applyPreview();
    })
  );

  /* ---------- 2. 成员 ---------- */
  const memberSection = el(
    'div.ge-section',
    el('h4', { text: '② 拉谁进群' }),
    el('div.field-hint', {
      text: '至少 2 位角色。群里的角色会看到彼此的发言，并可以互相接话、吐槽、拆台。',
    }),
    allCharsBox,
    membersCount
  );

  /* ---------- 3. 接话方式 ---------- */
  const turnSection = el(
    'div.ge-section',
    el('h4', { text: '③ 他们怎么聊' }),
    toggleField(
      '角色之间自动接话',
      '打开后：你每说一句，被点名的角色先回，其余角色会按策略接着聊；关掉则只有被 @ 的人回你。',
      draft.autoTalk,
      (v) => {
        draft.autoTalk = v;
      }
    ),
    toggleField(
      '自己聊时每人至少说一次',
      '点「让他们自己聊」时，保证群里的每个人都轮到一次（人数超过「一轮最多」时以人数为准）；关掉则严格按「一轮最多」截断。',
      draft.everyoneSpeaks !== false,
      (v) => {
        draft.everyoneSpeaks = v;
      }
    ),
    el('div.field-label', { text: '接话策略' }),
    turnModeField(draft.turnMode, (id) => {
      draft.turnMode = id;
    }),
    el(
      'div.grid-2',
      { style: { 'margin-top': '10px' } },
      el('div', el('div.field-label', { text: '一轮最多' }), turnsField(draft.maxAutoTurns, (v) => {
        draft.maxAutoTurns = v;
      })),
      el('div', el('div.field-label', { text: '角色之间间隔' }), delayField(draft.autoDelayMs, (v) => {
        draft.autoDelayMs = v;
      }))
    ),
    toggleField(
      '用各自的声线朗读（群里会一个个念）',
      '需要先在「设置 → 语音」里开启语音；每个角色用自己的音色，所以群里会像多人语音聊天。',
      draft.autoVoice,
      (v) => {
        draft.autoVoice = v;
      }
    )
  );

  /* ---------- 4. 禁言 ---------- */
  /** id → 角色（用于显示名字，角色列表是异步载入的，所以这里会被反复重画） */
  const nameById = new Map();
  const muteBox = el('div');

  const mutedSet = () => new Set((draft.mutedMembers || []).map(String));
  const toggleMemberMute = (id) => {
    const cur = mutedSet();
    if (cur.has(String(id))) cur.delete(String(id));
    else cur.add(String(id));
    draft.mutedMembers = [...cur];
    paintMute();
  };

  /** 重画"单独禁言"的成员开关（成员/角色名变化时都要重画） */
  function paintMute() {
    const ids = [...(draft.members || [])].map(String);
    if (!ids.length) {
      mount(muteBox, el('div.field-hint', { text: '先在「② 拉谁进群」里选好成员，这里就能逐个禁言。' }));
      return;
    }
    const muted = mutedSet();
    const chips = ids.map((id) => {
      const c = nameById.get(id);
      const name = (c && c.name) || id;
      const on = muted.has(id);
      return el(
        'button.btn.btn-sm',
        {
          type: 'button',
          class: on ? 'btn-danger' : '',
          title: on ? `解除 ${name} 的禁言` : `禁言 ${name}（TA 将不再在群里说话）`,
          on: { click: () => toggleMemberMute(id) },
        },
        icon(on ? 'speaker-off' : 'speaker', 13),
        el('span', { text: name })
      );
    });
    mount(
      muteBox,
      el('div.row.wrap', { style: { gap: '6px' } }, ...chips),
      el('div.field-hint', {
        text: draft.muteAll
          ? `当前是全员禁言：上面这些单独设置暂时不生效，关掉全员禁言后会恢复（已禁言 ${muted.size} 位）。`
          : muted.size
            ? `已禁言 ${muted.size} 位：他们不会在群里发言，也不会被 @ 出来。`
            : '点成员的按钮即可单独禁言；再点一次解除。',
      })
    );
  }

  const muteSection = el(
    'div.ge-section',
    el('h4', { text: '④ 禁言' }),
    toggleField(
      '全员禁言（群里谁都不说话）',
      '打开后所有角色都安静，只有你能往群里发消息；想恢复聊天就把这个开关关掉。适合"先记点东西、不想被打扰"的时候。',
      draft.muteAll === true,
      (v) => {
        draft.muteAll = v;
        paintMute();
      }
    ),
    el('div.field-label', { text: '单独禁言某几位', style: { 'margin-top': '10px' } }),
    muteBox
  );

  body.append(cardSection, memberSection, turnSection, muteSection);

  const selectedSet = new Set(draft.members);
  const syncCount = () => {
    membersCount.textContent = `已选 ${selectedSet.size} 位角色${selectedSet.size < 2 ? '（至少 2 位）' : ''}`;
    membersCount.style.color = selectedSet.size < 2 ? 'var(--warn, #e0b341)' : '';
  };

  const ref = modal({
    title: isNew ? '新建群聊' : `编辑群聊 · ${base.name || ''}`,
    body,
    width: 620,
    actions: [
      { text: '取消' },
      {
        text: isNew ? '创建群聊' : '保存',
        kind: 'primary',
        // 返回 false：交给 submit() 决定何时关闭（校验不通过时不能关）
        onClick: (close) => {
          void submit(close);
          return false;
        },
      },
    ],
  });

  /** 提交 */
  async function submit(close) {
    const name = String(nameInput.value || '').trim();
    if (!name) {
      toast('先给群起个名字吧', 'warn');
      nameInput.focus();
      return;
    }
    if (selectedSet.size < 2) {
      toast('群聊至少需要 2 位角色', 'warn');
      return;
    }
    draft.name = name;
    draft.topic = String(topicInput.value || '').trim();
    draft.members = [...selectedSet];
    try {
      const saved = groupOrNull
        ? await saveGroup({ ...groupOrNull, ...draft, id: groupOrNull.id })
        : await saveGroup(draft, gDefaults);
      // "群内朗读"开关与群聊顶栏那个 🔊 按钮共用同一个存储键（ui/groupchat.js 读它）
      try {
        localStorage.setItem(`aichat.voiceOn.group.${saved.id}`, draft.autoVoice ? '1' : '0');
      } catch {
        /* 隐私模式下写不了就算了 */
      }
      toast(isNew ? `群聊「${saved.name}」已创建` : '群资料已更新', 'ok');
      if (typeof close === 'function') close();
      if (opts.onSaved) opts.onSaved(saved);
    } catch (err) {
      toast(`保存失败：${(err && err.message) || err}`, 'error');
    }
  }

  // 异步载入角色列表后填充成员选择器
  void (async () => {
    let chars = [];
    try {
      chars = await listCharacters();
    } catch (err) {
      console.warn('[groupeditor] 读取角色失败', err);
    }
    if (!chars.length) {
      mount(
        allCharsBox,
        el(
          'div.empty',
          el('div.big', { text: '📇' }),
          el('h3', { text: '还没有好友' }),
          el('p.small', { text: '群聊需要角色，先去左侧创建一个好友再回来建群。' })
        )
      );
      syncCount();
      paintMute();
      return;
    }
    for (const c of chars) nameById.set(String(c.id), c);
    picker = memberPicker(chars, selectedSet, () => {
      syncCount();
      // 成员变了 → "单独禁言"那排按钮也要跟着变（被移出的人要消失）
      draft.members = [...selectedSet];
      paintMute();
    });
    mount(allCharsBox, picker.root);
    syncCount();
    paintMute();
    if (opts.focusMember) searchFocus();
  })();

  function searchFocus() {
    const input = allCharsBox.querySelector('input[type="search"]');
    if (input) input.focus();
  }

  setTimeout(() => nameInput.focus(), 80);
  return ref;
}

/**
 * 只加人：群聊界面里的「＋ 拉人」
 * @param {object} group
 * @param {(group:object)=>void} [onSaved]
 */
export function openMemberPicker(group, onSaved) {
  if (!group) return null;
  const selected = new Set((group.members || []).map(String));
  const body = el('div.ge-body');
  const countEl = el('span.field-hint');
  const box = el('div');
  body.append(
    el('div.field-hint', { text: `把更多好友拉进「${group.name}」。群里的人越多，越容易聊出意想不到的化学反应。` }),
    box,
    countEl
  );

  const syncCount = () => {
    countEl.textContent = `已在群里 ${selected.size} 位角色`;
  };

  const ref = modal({
    title: '拉人进群',
    body,
    width: 560,
    actions: [
      { text: '取消' },
      {
        text: '保存成员',
        kind: 'primary',
        onClick: (close) => {
          void (async () => {
            if (selected.size < 2) {
              toast('群聊至少需要 2 位角色', 'warn');
              return;
            }
            try {
              const removed = (group.members || []).filter((m) => !selected.has(String(m)));
              const added = [...selected].filter((m) => !(group.members || []).includes(m));
              const g = await setGroupMembers(group.id, added, removed);
              toast(`成员已更新：${selected.size} 位`, 'ok');
              if (typeof close === 'function') close();
              if (onSaved) onSaved(g || group);
            } catch (err) {
              toast(`保存失败：${(err && err.message) || err}`, 'error');
            }
          })();
          return false;
        },
      },
    ],
  });

  void (async () => {
    let chars = [];
    try {
      chars = await listCharacters();
    } catch {
      chars = [];
    }
    const picker = memberPicker(chars, selected, () => syncCount());
    mount(box, picker.root);
    syncCount();
  })();

  return ref;
}

/** 便捷函数：新建群聊（给侧栏 / 空状态用） */
export function openNewGroupDialog() {
  return openGroupEditor(null);
}

export default { openGroupEditor, openMemberPicker, openNewGroupDialog };
