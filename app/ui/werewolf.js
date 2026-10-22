/**
 * ui/werewolf.js —— 群聊里的狼人杀：**在聊天页里进行**的界面与"你自己"的操作
 * ---------------------------------------------------------------------------
 * 分工（面板只负责开局/结束，游戏过程就在聊天页里）：
 *   · core/werewolf.js：规则、阶段、AI 决策（本文件不碰规则）。
 *   · 聊天页（ui/groupchat.js 提供两个插槽，本文件往里填内容）：
 *       - 圆桌条位置的 **HUD**：第几天 / 什么阶段 / 存活几人 / 你的身份 + 暂停·结束；
 *       - 输入框上方的 **操作条**：轮到你时点按钮（刀人/查验/投票/开枪/用药），
 *         发言则直接用下面的聊天输入框发送，不再弹窗打断。
 *   · 面板（modal）：只做开局确认与结束游戏，另外显示模型告警等诊断信息。
 *
 * 信息边界：你的身份只画在 HUD/面板（本地 DOM，不进消息、模型看不到）；
 * 别人只在自己的提示词里知道自己的身份。法官公告走群消息 role:'system'。
 *
 * 与既有群聊逻辑的耦合：bus 事件（werewolf:hud / werewolf:action）+ 两个插槽，
 * 再加一个"把输入框内容交给引擎"的钩子（submitUserText）。
 */
import { el, mount } from './dom.js';
import { icon } from './icons.js';
import { modal, toast, confirmDialog } from './toast.js';
import { bus } from '../core/bus.js';
import { ctxSettings, userNameOf } from './shared.js';
import {
  WerewolfGame,
  preflight,
  ROLES,
  USER_ID,
  boardFor,
  boardLabel,
  countAlive,
  tallyText,
  publicVoteTally,
  hudExtraFor,
  privateFacts,
  loadGame,
  saveGame,
  clearGame,
  isActive,
  liveSpeechPreview,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_MEMBERS,
  MAX_MEMBERS,
} from '../core/werewolf.js';

/** 开局/结束面板（同一时刻只开一个） */
let panel = null;
/** 正在跑的一局（内存里；刷新后用存档重建） */
let session = null;
/**
 * 是否正在"开局中"（模型自检那一小段时间）。
 * 必须在 `await preflight()` **之前**置位：早先的重入守卫只看 session，而 session 是自检
 * 返回之后才赋值的，于是连点两下「开始游戏」会真的开出两局、并发跑同一个群同一个存档。
 */
let starting = false;
/** "等你操作"的提醒定时器（3 分钟还没动手就再提醒一次） */
let pendTimer = null;


/**
 * 面板是不是真的还挂在页面上。
 * modal() 的关闭（✕ / Esc / 点遮罩 / 底部按钮）只是把 DOM 摘掉，
 * 不会通知我们 —— 所以只靠 panel 变量会拿到一个"已经脱离文档"的 body，
 * 再往里渲染就等于什么都没发生（这就是"关闭一次后再也打不开"的原因）。
 */
function panelAlive(kind) {
  if (!panel || panel.kind !== kind) return false;
  const body = panel.ref && panel.ref.body;
  return Boolean(body && body.isConnected);
}

/**
 * 包一层 modal 的 close：任何关闭方式都要把模块状态清掉，避免留下失效引用。
 * @param {object} ref modal() 的返回值
 */
function trackModalClose(ref) {
  if (!ref || typeof ref.close !== 'function') return ref;
  const orig = ref.close;
  ref.close = (...args) => {
    if (panel && panel.ref === ref) panel = null;
    return orig(...args);
  };
  return ref;
}

/** 展示用：阵营中文 */
function teamZh(team) {
  return team === 'wolf' ? '狼人阵营' : '好人阵营';
}

/** 阶段中文 */
function phaseZh(state) {
  if (state.over) return '已结束';
  return { setup: '准备中', night: '夜晚', dawn: '天亮结算', day: '白天发言', vote: '投票放逐', ended: '结算中' }[state.phase] || state.phase;
}

/** 你这一局的身份（没在局里返回 null） */
function meOf(state) {
  return state && Array.isArray(state.players) ? state.players.find((p) => p.isUser) || null : null;
}

/**
 * HUD 里的票数文字（盲投）。
 *
 * 为什么这么写：投票是"一人一票、投完即定"的，**收票期间把"谁现在几票"亮出来，
 * 等于替还没投的人（尤其是你）做决定** —— 所以：
 *   · 收票中（`state.voteOpen`，含快速模式的白天与平票 PK 重投）→ 只写一句"投票中"，一个数字都不给；
 *   · 本轮结算完（`state.voteResult`，见 core 的 publicVoteTally）→ 才写"投票结果：…"；
 *   · 夜里/天亮不显示：那时没有投票在进行，挂一份票数会被误读成跟当前行动有关。
 * @param {object} state
 * @returns {string} 空串表示 HUD 不显示票数区
 */
function voteHudText(state) {
  if (!state || state.over) return '';
  if (state.phase !== 'day' && state.phase !== 'vote') return '';
  if (state.voteOpen) return '投票中（结果投票结束后公布）';
  const live = tallyText(state, publicVoteTally(state));
  return live ? `投票结果：${live}` : '';
}

/* ================================================================== *
 * 1. 聊天页里的 HUD（状态 + 你的身份 + 暂停/结束）
 * ================================================================== */

/** 往聊天页的圆桌条位置推一份 HUD */
function pushHud() {
  const g = session && session.game;
  if (!session || !g) {
    bus.emit('werewolf:hud', { off: true });
    return;
  }
  const s = g.state;
  const me = meOf(s);
  // 票数区：收票期间只写"投票中"，结算后才写结果（见 voteHudText —— 盲投的界面入口只有这一个）
  const voteText = voteHudText(s);
  const nodes = [
    el('span.ww-hud-title', { text: s.over ? '🐺 狼人杀 · 已结束' : `🐺 第 ${s.day} 天 · ${phaseZh(s)}` }),
    el('span.ww-hud-count', { text: `存活 ${countAlive(s).total} / ${s.players.length} 人` }),
    voteText ? el('span.ww-hud-votes', { text: voteText }) : null,
    me
      ? el('span.ww-hud-me', {
          // 身份胶囊后面挂一句"实时摘要"：狼队友是谁、预言家验出了什么、女巫还剩哪瓶药…
          // 每次状态变化都会重画（队友一出局马上标出来），不用靠脑子记。
          text: `你是 ${me.seat} 号 · ${ROLES[me.role].name}${me.alive ? '' : '（已出局）'}${hudExtraFor(s, me)}`,
          title: `你的身份只有你自己知道。${privateFacts(s, me) || ''}`,
        })
      : null,
    s.over ? el('span.ww-hud-win', { text: `${teamZh(s.winner)}胜利` }) : null,
    s.over
      ? el('button.link-btn', { type: 'button', text: '退出狼人杀', on: { click: () => { clearGame(s.groupId); session = null; pushHud(); pushAction({ off: true }); } } })
      : el('button.link-btn', { type: 'button', text: g.paused ? '继续' : '暂停', on: { click: () => (g.paused ? g.resume() : g.pause()) } }),
    s.over
      ? null
      : el('button.link-btn', {
          type: 'button',
          text: '结束',
          on: {
            click: async () => {
              const ok = await confirmDialog({ title: '结束这一局狼人杀？', message: '游戏会立刻停止，已经发出的法官公告与发言会留在群聊记录里。', okText: '结束', danger: true });
              if (ok) stopWerewolf(session ? session.group : null);
            },
          },
        }),
  ].filter(Boolean);
  bus.emit('werewolf:hud', { nodes });
}

/**
 * 往聊天页输入框上方推"轮到你操作"的内容
 * @param {{off?:boolean, nodes?:any[], speech?:boolean, placeholder?:string}} payload
 */
function pushAction(payload) {
  bus.emit('werewolf:action', payload || { off: true });
}

/* ================================================================== *
 * 2. 等待"你自己"的操作（结果从聊天页的按钮 / 输入框回来）
 * ================================================================== */

/**
 * 引擎会 await 这个 Promise，直到你在聊天页点了选项、或直接在输入框发言。
 * @param {'wolf'|'witch'|'seer'|'vote'|'speech'|'lastWords'|'shoot'} kind
 * @param {object} req
 * @returns {Promise<object|null>} null = 跳过 / 放弃
 */
function waitForHuman(kind, req) {
  return new Promise((resolve) => {
    if (!session) return resolve(null);
    session.pending = { kind, req, resolve };
    renderAction();
    pushHud();
    const tip = {
      wolf: '轮到你（狼人）选今晚要刀的人',
      witch: '轮到你（女巫）决定用不用药',
      seer: '轮到你（预言家）选查验对象',
      vote: '轮到你投票放逐一人',
      speech: '轮到你发言：在下面输入框里说，回车发送',
      lastWords: '你出局了，可以说一句遗言（或跳过）',
      shoot: '轮到你（猎人）开枪',
    }[kind];
    if (tip) toast(tip, 'info', 3600);
    // 等你 3 分钟还没动手就再提醒一次（只提醒一次，不替你操作）。
    // 引擎这里会一直 await，人不在时整局就停在这儿；给个明确提示比静默挂着好。
    if (pendTimer) clearTimeout(pendTimer);
    pendTimer = setTimeout(() => {
      if (!session || !session.pending || session.pending.kind !== kind) return;
      toast('还在等你操作：狼人杀这一轮没有你动不了（也可以点「放弃 / 跳过」）', 'info', 5200);
    }, 180000);
  });
}

/** 把你在聊天页的操作交回引擎 */
function answer(value) {
  if (!session || !session.pending) return;
  if (pendTimer) {
    clearTimeout(pendTimer);
    pendTimer = null;
  }
  const { resolve } = session.pending;
  session.pending = null;
  pushAction({ off: true });
  pushHud();
  resolve(value || null);
}

/** 放弃当前等待（停止游戏时调用，避免引擎卡住） */
function cancelPending() {
  if (pendTimer) {
    clearTimeout(pendTimer);
    pendTimer = null;
  }
  if (!session || !session.pending) return;
  const { resolve } = session.pending;
  session.pending = null;
  pushAction({ off: true });
  resolve(null);
}

/**
 * 聊天输入框的内容是否应该交给狼人杀（轮到你发言/遗言时）
 * @param {string} text
 * @returns {boolean} true = 已消费（不要当普通群消息发出去）
 */
export function submitUserText(text) {
  if (!session || !session.pending) return false;
  const kind = session.pending.kind;
  if (kind !== 'speech' && kind !== 'lastWords') return false;
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  answer({ text: t });
  return true;
}

/** 现在是不是在等你说点什么（群聊界面用它改输入框占位符） */
export function awaitingSpeech() {
  if (!session || !session.pending) return false;
  const k = session.pending.kind;
  return k === 'speech' || k === 'lastWords';
}

/** 现在是不是"轮到你操作" */
export function awaitingAction() {
  return Boolean(session && session.pending);
}

/* ================================================================== *
 * 3. 聊天页操作条的内容
 * ================================================================== */

/** 生成"轮到你"的操作内容（按钮 / 发言提示） */
function renderAction() {
  if (!session || !session.pending) {
    pushAction({ off: true });
    return;
  }
  const { kind, req } = session.pending;
  const title = {
    wolf: '轮到你：狼人刀人',
    witch: '轮到你：女巫用药',
    seer: '轮到你：预言家查验',
    vote: '轮到你：投票放逐',
    speech: '轮到你：发言',
    lastWords: '轮到你：遗言',
    shoot: '轮到你：猎人开枪',
  }[kind];
  const head = [el('span.ww-ab-title', { text: title || '轮到你操作' })];

  /* 发言 / 遗言：直接用输入框 */
  if (kind === 'speech' || kind === 'lastWords') {
    const nodes = [
      ...head,
      el('span.ww-ab-hint', {
        text:
          kind === 'lastWords'
            ? '在下面输入框里说一句遗言，或点跳过。'
            : req && req.withVote !== false
              ? '在下面输入框发言（可跳过）；**发言之后会出现投票按钮**，点谁就是投谁。也可以在发言里直接写「投票：3号」一步到位。'
              : '在下面输入框发言。',
      }),
      el('button.link-btn', { type: 'button', text: '跳过', on: { click: () => answer({ text: '' }) } }),
    ];
    pushAction({
      nodes,
      speech: true,
      placeholder: kind === 'lastWords' ? '留下遗言…（回车发送）' : '说说你的看法…投票可写「投票：3号」或「投票：林晚」',
    });
    return;
  }

  /* 选择类：刀人 / 查验 / 投票 / 开枪 / 女巫 */
  const options = (req && Array.isArray(req.options) ? req.options : []).filter((p) => p && p.alive !== false);
  const nodes = [...head];
  if (kind === 'vote') {
    // 盲投：投票条上一个票数都不给（按钮上也不再挂"TA 现在几票"）——
    // 别人的票要等本轮投票结束、法官公告那一刻才公布，见 core/publicVoteTally。
    nodes.push(el('span.ww-ab-hint', { text: '投票中：按你自己的判断投，结果会在所有人投完后一起公布。' }));
  } else if (req && req.hint) {
    nodes.push(el('span.ww-ab-hint', { text: req.hint }));
  }

  if (kind === 'witch') {
    if (req && req.canSave && req.target) {
      nodes.push(
        el('button.btn.btn-sm.btn-primary', { type: 'button', on: { click: () => answer({ save: true }) } }, el('span', { text: `用解药救 ${req.target.seat} 号 ${req.target.name}` }))
      );
    }
    if (req && req.canPoison) nodes.push(el('span.ww-ab-hint', { text: '或选一个目标下毒：' }));
    nodes.push(el('button.btn.btn-sm', { type: 'button', on: { click: () => answer({ none: true }) } }, el('span', { text: '不用药' })));
  }

  const verb = { wolf: '刀', seer: '查验', vote: '投', shoot: '开枪带走' }[kind] || '选';
  const list = kind === 'witch' && !(req && req.canPoison) ? [] : options;
  for (const p of list) {
    nodes.push(
      el(
        'button.btn.btn-sm',
        { type: 'button', title: `${verb} ${p.seat} 号 ${p.name}`, on: { click: () => answer(kind === 'witch' ? { poison: p.seat } : { seat: p.seat }) } },
        el('span', { text: `${p.seat} 号 ${p.name}` })
      )
    );
  }
  if (kind === 'vote') {
    nodes.push(el('button.link-btn', { type: 'button', text: '弃票', on: { click: () => answer({ abstain: true }) } }));
  } else if (kind === 'wolf') {
    // 狼人必须每晚刀一人（规则文件）：点"放弃"会让今晚变成平安夜，
    // 所以这里先确认一次 —— 误点不会白白送掉一刀（引擎侧对 AI 狼本来就是随机兜底）。
    nodes.push(
      el('button.link-btn', {
        type: 'button',
        text: '今晚不刀人',
        title: '今晚不刀人＝平安夜（规则上狼人每晚必须刀一人，请确认）',
        on: {
          click: async () => {
            const ok = await confirmDialog({
              title: '今晚真的不刀人？',
              message: '规则上狼人每晚必须刀一人；选「不刀人」今晚会是平安夜。',
              okText: '确定不刀',
              cancelText: '我再想想',
            });
            if (ok) answer(null);
          },
        },
      })
    );
  } else if (kind !== 'witch') {
    nodes.push(el('button.link-btn', { type: 'button', text: '放弃', on: { click: () => answer(null) } }));
  }
  pushAction({ nodes });
}

/* ================================================================== *
 * 4. 开局 / 停止 / 恢复
 * ================================================================== */

/**
 * 从群聊上下文里取这个群的成员（按 group.members 的顺序解析角色卡，已删除的自动跳过）
 * @param {object} ctx
 * @param {object} group
 */
function membersOf(ctx, group) {
  const ids = (group && Array.isArray(group.members) ? group.members : []).map(String);
  const chars = (ctx && Array.isArray(ctx.characters) && ctx.characters) || [];
  const byId = new Map(chars.map((c) => [String(c.id), c]));
  const list = ids.map((id) => byId.get(id)).filter(Boolean);
  if (list.length) return list;
  const fallback = (ctx && Array.isArray(ctx.groupMembers) && ctx.groupMembers) || [];
  return fallback.filter((m) => m && m.id);
}

function ctxUserName(ctx) {
  try {
    return userNameOf(ctxSettings(ctx)) || '我';
  } catch {
    return '我';
  }
}

/**
 * 打开狼人杀面板（群资料里的入口按钮调用）：面板只做开局 / 结束 + 诊断信息。
 * @param {object} group
 * @param {object} ctx
 */
export function openWerewolfPanel(group, ctx) {
  if (!group || !group.id) {
    toast('先打开一个群聊，再玩狼人杀', 'warn');
    return;
  }
  if (session && session.groupId === group.id && !session.game.state.over) {
    openRunningPanel();
    return;
  }
  const saved = loadGame(group.id);
  if (saved && !saved.over) {
    void confirmDialog({
      title: '接着上一局狼人杀？',
      message: `「${saved.groupName}」有一局进行到第 ${saved.day} 天（${phaseZh(saved)}）。继续会从当前阶段接着推进。`,
      okText: '继续这局',
      cancelText: '放弃并重新开始',
    }).then((ok) => {
      if (ok) attach(group, ctx, saved);
      else {
        clearGame(group.id);
        openStartPanel(group, ctx);
      }
    });
    return;
  }
  openStartPanel(group, ctx);
}

/** 用存档恢复一局（刷新页面后也能接着打） */
function attach(group, ctx, state) {
  // 与 openStartPanel 里的"同时只允许一局"守卫对齐（见那边的长注释）。
  // 少了这一道，"另一个群还有一局在跑"时点「接着上一局」会把 session 整个换掉：
  // 旧局仍在跑，但它 await 的 resolve 随着旧 session 对象被丢弃 ——
  // 旧局永久卡死，而且「结束」按钮只作用于当前 session，救不回来。
  if (session && !session.game.state.over && session.groupId !== group.id) {
    const other = (session.group && session.group.name) || '另一个群';
    toast(`「${other}」里还有一局没结束，先把它结束（或玩完）再接着这一局`, 'warn', 5200);
    return;
  }
  // 同群重开：先把上一次的"等你操作"取消掉，不要让旧 promise 悬着
  cancelPending();
  const game = new WerewolfGame({
    group,
    members: membersOf(ctx, group),
    settings: ctxSettings(ctx),
    userName: ctxUserName(ctx),
    state,
    human: humanBridge(),
    handlers: baseHandlers(),
  });
  session = { groupId: group.id, group, ctx, game, pending: null };
  pushHud();
  renderAction();
  void game.run().then(onGameSettled).catch(onGameCrashed);
}

/** 开局面板 */
function openStartPanel(group, ctx) {
  const members = membersOf(ctx, group);
  const total = members.length + 1;
  const board = boardFor(total);
  const ok = board && members.length >= MIN_MEMBERS && members.length <= MAX_MEMBERS;

  const fastBox = el('input', { type: 'checkbox', checked: false });
  const body = el(
    'div.ww-body',
    el('p.desc', {
      text: '狼人杀以「屠边」为准：狼人杀光全部神职或全部平民即获胜；好人放逐/毒杀/枪杀所有狼人即获胜。',
    }),
    el('div.ww-kv', el('span.k', { text: '参与人数' }), el('span.v', { text: `${members.length} 位群成员 + 你 = ${total} 人` })),
    el('div.ww-kv', el('span.k', { text: '本局板子' }), el('span.v', { text: board ? boardLabel(board) : '—' })),
    board
      ? el('div.ww-hint', {
          text:
            '角色：' +
            [...board.cards.reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map())]
              .map(([id, n]) => `${ROLES[id].name}×${n}`)
              .join('、') +
            '。系统当法官，身份私下发给每个人（只有本人知道）。',
        })
      : el('div.ww-warn', {
          text: `人数不满足：需要 ${MIN_PLAYERS}~${MAX_PLAYERS} 名玩家（群成员 + 你），也就是 ${MIN_MEMBERS}~${MAX_MEMBERS} 位群成员；当前 ${members.length} 位群成员 + 你 = ${total} 人。`,
        }),
    el('label.ww-toggle', fastBox, el('span', { text: '快速模式：发言与投票合并成一次（省一半模型调用；关掉则先依次发言、再单独投票）' })),
    el('div.ww-hint', {
      text: '开始后游戏直接在聊天页里进行：法官公告和角色发言都是群里的消息；轮到你时输入框上方会出现操作条，发言直接在下方的输入框里发。这个面板只用来开局和结束。',
    })
  );

  const ref = trackModalClose(modal({
    title: '狼人杀',
    body,
    width: 560,
    actions: [
      { text: '关闭' },
      {
        text: '开始游戏',
        kind: 'primary',
        onClick: (close) => {
          if (!ok) {
            toast(`狼人杀需要 ${MIN_PLAYERS}~${MAX_PLAYERS} 名玩家（${MIN_MEMBERS}~${MAX_MEMBERS} 位群成员 + 你）`, 'warn');
            return false;
          }
          close();
          void beginGame(group, ctx, { fastMode: fastBox.checked });
          return false;
        },
      },
    ],
  }));
  panel = { ref, kind: 'start', body };
}

/** 进行中的面板：状态摘要 + 暂停/继续/结束（具体操作都在聊天页） */
function openRunningPanel() {
  if (panelAlive('run')) {
    renderRunningPanel();
    return;
  }
  const body = el('div.ww-panel');
  const ref = trackModalClose(modal({ title: '狼人杀', body, width: 560, actions: [{ text: '关闭（游戏继续）' }] }));
  panel = { ref, kind: 'run', body };
  renderRunningPanel();
}

function renderRunningPanel() {
  if (!panelAlive('run')) return;
  const g = session && session.game;
  if (!g) {
    mount(panel.body, el('div.ww-hint', { text: '这一局已经结束了。' }));
    return;
  }
  const s = g.state;
  const me = meOf(s);
  const kids = [
    el('div.ww-hint', { text: '游戏过程在聊天页里进行：法官公告和角色发言都是群消息；轮到你时输入框上方会出现操作条。' }),
    el(
      'div.ww-kv',
      el('span.k', { text: '当前进度' }),
      el('span.v', { text: `${s.over ? '已结束' : `第 ${s.day} 天 · ${phaseZh(s)}`}　存活 ${countAlive(s).total} / ${s.players.length} 人` })
    ),
  ];
  if (me) {
    const role = ROLES[me.role] || ROLES.villager;
    kids.push(
      el(
        'div.ww-role' + (me.alive ? '' : '.dead'),
        el('div.ww-role-head', el('b', { text: `${me.seat} 号 · 你` }), el('span.ww-role-name', { text: role.name }), el('span.ww-role-team', { text: teamZh(me.team) })),
        el('div.ww-role-desc', { text: role.desc }),
        el('div.ww-role-facts', { text: privateFacts(s, me) || '—' })
      )
    );
  }
  if (Array.isArray(s.warnings) && s.warnings.length) {
    kids.push(el('div.ww-warn', { text: `⚠️ ${s.warnings.slice(-2).join('；')}` }));
  }
  kids.push(
    el(
      'div.ww-controls',
      s.over
        ? el('button.btn.btn-primary', { type: 'button', on: { click: () => exitWerewolfMode(s.groupId) } }, icon('check', 14), el('span', { text: '结束并退出狼人杀模式' }))
        : el('button.btn', { type: 'button', on: { click: () => (g.paused ? g.resume() : g.pause()) } }, icon(g.paused ? 'play' : 'pause', 14), el('span', { text: g.paused ? '继续' : '暂停' })),
      s.over
        ? null
        : el(
            'button.btn.btn-danger',
            {
              type: 'button',
              on: {
                click: async () => {
                  const ok = await confirmDialog({ title: '结束这一局狼人杀？', message: '游戏会立刻停止，已经发出的法官公告与发言会留在群聊记录里。', okText: '结束', danger: true });
                  if (ok) stopWerewolf(session ? session.group : null);
                },
              },
            },
            icon('close', 14),
            el('span', { text: '结束游戏' })
          )
    )
  );
  mount(panel.body, ...kids);
}

/** 真正开一局（先做一次模型自检，避免"开局了但角色全程不说话"） */
async function beginGame(group, ctx, opts = {}) {
  // 重入守卫：自检最长可能挂 100 多秒，这期间界面没有任何"正在开局"的反馈，
  // 用户很容易再点一次 —— 必须在 await 之前就拦住（守卫放在 session 上是拦不住的，
  // 因为 session 要等自检返回才赋值）。
  if (starting) {
    toast('正在开局（模型自检中），稍等一下…', 'info', 3000);
    return;
  }
  if (session && session.groupId === group.id && !session.game.state.over) {
    session.game.stop('restart');
    cancelPending();
    clearGame(group.id);
    session = null;
  }
  // 同一个页面同时只允许一局：别的群还有一局没结束就直接拒绝。
  // 否则新局会把 session 顶掉，旧局变成"孤儿引擎"——它还在跑、还在往旧群写公告，
  // 而且它 await 的"你的操作"会被注册到新局的 session 上（点按钮驱动的却是旧局）。
  if (session && !session.game.state.over && session.groupId !== group.id) {
    const other = (session.group && session.group.name) || '另一个群';
    toast(`「${other}」里还有一局没结束，先把它结束（或玩完）再开新的一局`, 'warn', 5200);
    return;
  }
  const members = membersOf(ctx, group);
  const board = boardFor(members.length + 1);
  if (!board || members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) {
    toast(`狼人杀需要 ${MIN_PLAYERS}~${MAX_PLAYERS} 名玩家（${MIN_MEMBERS}~${MAX_MEMBERS} 位群成员 + 你）`, 'warn');
    return;
  }
  let game;
  try {
    game = new WerewolfGame({
      group,
      members,
      settings: ctxSettings(ctx),
      userName: ctxUserName(ctx),
      fastMode: opts.fastMode !== false,
      human: humanBridge(),
      handlers: baseHandlers(),
    });
  } catch (err) {
    toast(`开局失败：${(err && err.message) || err}`, 'error');
    return;
  }
  starting = true;
  try {
    // 自检：拿不到非空回复就别开局，否则你会看到"法官在报幕、角色一声不吭"
    const probe = await preflight(ctxSettings(ctx));
    if (!probe.ok) {
      toast(`模型自检没通过，先修好再开局：${probe.error}`, 'error', 7000);
      return;
    }

    session = { groupId: group.id, group, ctx, game, pending: null };
    saveGame(game.state);
    toast(`狼人杀开始：${boardLabel(board)}，${members.length + 1} 人局（在聊天页里进行）`, 'ok', 4600);
    pushHud();
    renderAction();
  } finally {
    starting = false;
  }
  try {
    await game.run();
    onGameSettled();
  } catch (err) {
    onGameCrashed(err);
  }
}

/** 主动结束（HUD 的"结束"与面板按钮都走这里） */
export function stopWerewolf(group, reason = 'user') {
  if (!session || session.groupId !== (group && group.id)) {
    if (group) clearGame(group.id);
    pushHud();
    pushAction({ off: true });
    return;
  }
  const g = session.game;
  g.stop(reason);
  cancelPending();
  clearGame(group.id);
  clearSpeechLive();
  session = null;
  pushHud();
  pushAction({ off: true });
  closePanel();
  toast(`狼人杀已结束（第 ${g.state.day} 天）`, 'info', 3600);
}

/**
 * 已经打完的局：退出"狼人杀模式"。
 * 必须把 session/pending/存档一起清掉 —— 早先只 clearGame()，session 还指着那一局，
 * HUD 会一直挂在聊天页上（要等 30 秒的定时器才收），而且操作条也不关。
 * @param {string} groupId
 */
function exitWerewolfMode(groupId) {
  try {
    if (session) session.game.stop('exit');
  } catch {
    /* 忽略 */
  }
  cancelPending();
  clearGame(groupId);
  clearSpeechLive();
  session = null;
  pushHud();               // session 为 null → 推 off
  pushAction({ off: true });
  closePanel();
  toast('已退出狼人杀模式（这一局的过程留在群聊里）', 'info', 3200);
}

/**
 * 收掉聊天页里"正在发言"的临时流式气泡。
 *
 * 正常收尾时不用管：发言一落库，群聊的 gmsg:appended 分支就会把气泡换成真消息。
 * 但**中断**（你点结束 / 切群 / 出错 / 这局打完）时不会有消息落库，
 * 气泡会一直挂在聊天页上显示一句没说完的话，所以这些出口都要主动收一次。
 */
function clearSpeechLive() {
  bus.emit('werewolf:speech', { groupId: session ? session.groupId : '', off: true });
}

/**
 * 公开发言的流式增量 → 聊天页事件（`onSpeechLive` 的全部转换逻辑都在这一个纯函数里，
 * 便于单测：见 `tools/selftest.mjs` 的 `speechLiveEvent` 用例）。
 *
 * 两个要点：
 *   · 只推**正文** —— 模型的原文里还有"投票：<编号>号"这类格式行（真正落库时会被
 *     splitSpeechAndVote 拆掉），直接画上去会先出现再消失，看着像跳字。
 *     用 core 的 liveSpeechPreview 裁一遍，保证气泡里的字和最终那条消息一致。
 *   · full 为 null 表示"这一轮没有发言"（模型空回 / 被停掉）：让聊天页收掉气泡。
 * @param {string} groupId 对局所在的群（聊天页据此判断"这气泡该不该画在我这儿"）
 * @param {object} player
 * @param {string|null} full 累计出来的原文；null = 收掉气泡
 * @returns {object|null} 要推给聊天页的事件；null = 什么都不用推
 */
export function speechLiveEvent(groupId, player, full) {
  if (full === null) return { groupId, off: true };
  // 真人自己的发言是自己敲进去的，不需要流式预览
  if (!player || player.isUser) return null;
  return { groupId, playerId: player.id, name: player.name, text: liveSpeechPreview(full) };
}

/** 引擎回调：状态变化 / 法官公告 / 结束 */
function baseHandlers() {  return {
    onState: () => {
      pushHud();
      renderRunningPanel();
      // 步骤内容变了就跟着重画操作条（例如投票结算后 hint 变化），但如果正在等你打键盘发言，就别重画（会打断输入）
      if (session && session.pending && session.pending.kind !== 'speech' && session.pending.kind !== 'lastWords') renderAction();
    },
    onJudge: () => pushHud(),
    onSpeech: () => pushHud(),
    /**
     * 公开发言的流式增量（core/werewolf.js 的 emitSpeechLive）：转给聊天页，
     * 让它像普通群聊那样在临时气泡里一句句长出来（转换逻辑见 speechLiveEvent）。
     */
    onSpeechLive: (player, full) => {
      if (!session) return; // 没有正在跑的一局（例如已结束）：不往聊天页推
      const ev = speechLiveEvent(session.groupId, player, full);
      if (ev) bus.emit('werewolf:speech', ev);
    },
    onEnd: (summary) => {
      pushHud();
      renderRunningPanel();
      const win = summary && summary.winner;
      toast(`${win === 'wolf' ? '狼人阵营' : '好人阵营'}胜利！`, 'ok', 5200);
    },
    // 只给本人看的即时反馈：转发到聊天页显示（预言家查验结果、女巫用药、自己的死因）
    onPrivate: (player, text) => {
      if (!player || !player.isUser) return; // 别人的私密信息绝不在你这边显示
      bus.emit('werewolf:private', { text });
    },
    onError: (err) => toast(`狼人杀出错：${(err && err.message) || err}`, 'error', 6000),
    onWarn: (text) => {
      // 引擎那边的"等你操作超时"（core/werewolf.js 的 HUMAN_TIMEOUT_MS）：它已经按
      // 「放弃这次操作」继续走了，这里要把界面上的操作条也撤掉 —— 否则会留一个
      // 永远不会被受理的按钮条（引擎已经不再等它了）。
      if (/等你操作超过/.test(String(text || ''))) {
        if (session && session.pending) {
          session.pending = null;
          pushAction({ off: true });
        }
        if (pendTimer) {
          clearTimeout(pendTimer);
          pendTimer = null;
        }
        renderAction();
        pushHud();
      }
      toast(`⚠️ ${text}`, 'warn', 8000);
    },
  };
}

function onGameSettled() {
  const g = session && session.game;
  if (!g) return;
  if (g.state.over) {
    clearGame(g.state.groupId);
    clearSpeechLive(); // 局终：最后那句发言可能没落库，别把半截气泡留在聊天页上
    pushHud();
    renderRunningPanel();
  } else if (g.stopped) {
    onGameCrashed(new Error(g.reason === 'no-key' ? '还没有配置 API Key（设置 → 模型）' : '游戏已中断'));
  }
}

function onGameCrashed(err) {
  cancelPending();
  const g = session && session.game;
  if (g) clearGame(g.state.groupId);
  clearSpeechLive();
  session = null;
  pushHud();
  pushAction({ off: true });
  closePanel();
  toast(`狼人杀中断：${(err && err.message) || err}`, 'error', 6000);
}

/** 把引擎需要的"你的操作"接到聊天页 */
function humanBridge() {
  return {
    wolf: (req) => waitForHuman('wolf', req),
    witch: (req) => waitForHuman('witch', req),
    seer: (req) => waitForHuman('seer', req),
    vote: (req) => waitForHuman('vote', req),
    speech: (req) => waitForHuman('speech', req),
    lastWords: (req) => waitForHuman('lastWords', req),
    shoot: (req) => waitForHuman('shoot', req),
  };
}

function closePanel() {
  if (panel && panel.ref && typeof panel.ref.close === 'function') {
    try {
      panel.ref.close();
    } catch {
      /* 忽略 */
    }
  }
  panel = null;
}

/** 供群聊界面查询：这个群是否正在进行狼人杀 */
export function werewolfActive(groupId) {
  if (session && session.groupId === groupId && !session.game.state.over) return true;
  return isActive(groupId);
}

/** 面板是否开着 */
export function isPanelOpen() {
  return Boolean(panel);
}

/**
 * 群聊中栏被**整体重绘**之后，把 HUD 与操作条重新推一遍。
 *
 * 为什么必须有这个出口：`ui/groupchat.js` 的 renderGroupChat 会 `clear(root)` 并重建
 * 空的 `.ww-hud` / `.ww-actionbar` 容器，而 HUD/操作条的内容只由 ui/werewolf.js 通过 bus 推过来。
 * 重绘后没人重推 → HUD 与按钮全空，可此时引擎正 await 你的操作（存档里 pending 还在），
 * 界面却没有任何入口，整局卡死。切群、拉人、置顶、改群资料、删角色都会触发这种重绘。
 *
 * @param {string} [groupId] 当前正在渲染的群 id；与对局所在群不一致时只把界面关掉，
 *   避免把 A 局的 HUD / 私密提示画到 B 群上（引擎会继续等，切回 A 群就恢复）。
 */
export function refreshWerewolfUi(groupId) {
  const inThisGroup = session && (!groupId || String(session.groupId) === String(groupId));
  if (!inThisGroup) {
    // 注意这里**不能**调 pushHud()：session 非空时它会照推当前对局的 HUD，
    // 结果 A 群的对局信息会被画到 B 群的聊天页上（HUD 会显示"你是 N 号 · 预言家"）。
    // 引擎本身继续在 A 群跑、继续等你，切回 A 群时再推一次就恢复了。
    bus.emit('werewolf:hud', { off: true });
    pushAction({ off: true });
    clearSpeechLive(); // 临时发言气泡长在聊天页里，切到别的群同样要收掉
    return;
  }
  pushHud();
  renderAction();
}

export default { openWerewolfPanel, stopWerewolf, werewolfActive, isPanelOpen, refreshWerewolfUi, submitUserText, awaitingSpeech, awaitingAction, speechLiveEvent, USER_ID };
