/**
 * core/werewolf.js —— 群聊里的狼人杀（屠边局）
 * ---------------------------------------------------------------------------
 * 设计原则（用户要求「自成模块、不要和其他代码打架」）：
 *   1. 本文件不碰群聊引擎的任何既有逻辑：只依赖 core/{store,llm,prompt,util}，
 *      发言走自己的提示词，法官公告走 store.appendGroupMessage(role:'system')。
 *   2. 引擎与"跑一局"分开：纯规则部分（板子/发牌/结算/胜负）是可单测的纯函数；
 *      WerewolfGame 负责用 LLM 驱动角色做夜间行动与白天发言，并逐步推进阶段。
 *   3. 唯一对外的写入口：saveGame/loadGame/clearGame（localStorage，键含群 id），
 *      以及 isActive(groupId)（给群聊界面做"别同时开一轮普通群聊"的保护）。
 *
 * 规则依据：仓库根目录《狼人杀基本规则.md》
 *   · 阵营与胜利：屠边 —— 狼人杀光所有神职 或 杀光所有平民；好人放逐/毒杀/枪杀所有狼人。
 *   · 板子配置取「4.1 通用配置表」（6~12 人）；13 人（12 人群 + 你）按 12 人板 +1 民扩展。
 *   · 女巫：6 人局只有解药；不能自救；同一晚不能同时用药。
 *   · 猎人：被狼刀 / 被票出可开枪；被毒死不能开枪。
 *   · 白痴：被票出翻牌免死一次，之后失去投票权但仍可发言。
 *   · 平票：平票者 PK 后由其他人重投；再平票则本轮无人出局。
 *   · 首夜出局有遗言，后续夜晚出局无遗言（场规简化）。
 *   · 本实现不含：警长竞选、守卫、狼王/白狼王/狼美人/隐狼/骑士（规则文件里的可选板子）。
 */
import { num, clamp, sleep, createId } from './util.js';
import { appendGroupMessage, getMemory, appendGameMemoryFact, getCharacter } from './store.js';
import { chat, chatStream } from './llm.js';
import { buildSystemPrompt } from './prompt.js';
import { getRuntime } from './runtime.js';
import { PROVIDERS } from './llm.js';

/* ================================================================== *
 * 1. 常量：角色 / 板子
 * ================================================================== */

export const TEAM_WOLF = 'wolf';
export const TEAM_GOOD = 'good';

/** 角色定义（名称与技能说明对齐规则文件第三章） */
export const ROLES = {
  wolf: { id: 'wolf', name: '狼人', team: TEAM_WOLF, god: false, desc: '每晚与同伴共同刀杀一人，白天伪装成好人' },
  villager: { id: 'villager', name: '平民', team: TEAM_GOOD, god: false, desc: '没有技能，靠发言与投票找出狼人' },
  seer: { id: 'seer', name: '预言家', team: TEAM_GOOD, god: true, desc: '每晚查验一名玩家是好人还是狼人' },
  witch: { id: 'witch', name: '女巫', team: TEAM_GOOD, god: true, desc: '一瓶解药一瓶毒药（6 人局只有解药）；不能自救，同一晚不能双药' },
  hunter: { id: 'hunter', name: '猎人', team: TEAM_GOOD, god: true, desc: '被狼刀或被票出时可以开枪带走一人；被毒死不能开枪' },
  idiot: { id: 'idiot', name: '白痴', team: TEAM_GOOD, god: true, desc: '被投票放逐时翻牌免死一次，之后失去投票权但仍可发言' },
};

/**
 * 板子配置表（人数 = 群成员数 + 你）
 * 取自规则文件「4.1 通用配置表」，13 人为 12 人板 + 1 民的等价扩展。
 */
export const BOARDS = {
  6: { wolf: 2, villager: 2, gods: ['seer', 'witch'], witchAntidoteOnly: true },
  7: { wolf: 2, villager: 2, gods: ['seer', 'witch', 'hunter'] },
  8: { wolf: 3, villager: 2, gods: ['seer', 'witch', 'hunter'] },
  9: { wolf: 3, villager: 3, gods: ['seer', 'witch', 'hunter'] },
  10: { wolf: 3, villager: 4, gods: ['seer', 'witch', 'hunter'] },
  11: { wolf: 3, villager: 4, gods: ['seer', 'witch', 'hunter', 'idiot'] },
  12: { wolf: 4, villager: 4, gods: ['seer', 'witch', 'hunter', 'idiot'] },
  13: { wolf: 4, villager: 5, gods: ['seer', 'witch', 'hunter', 'idiot'] },
};

/**
 * 一局需要多少名玩家（**群成员 + 你**）：规则文件「4.1 通用配置表」覆盖 6~12 人，
 * 13 人（12 位群成员 + 你）按 12 人板 +1 民扩展。
 * 注意：门槛算的是"玩家总数"，不是群成员数 —— 5 位群成员 + 你 = 6 人局，是合法的标准 6 人板。
 */
export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 13;
/** 对应的群成员数量（你也入局，所以是玩家数 − 1） */
export const MIN_MEMBERS = MIN_PLAYERS - 1; // 5
export const MAX_MEMBERS = MAX_PLAYERS - 1; // 12

/** 板子是否合法 */
export function boardFor(playerCount) {
  const n = clamp(Math.round(num(playerCount, 0)), 0, 99);
  const b = BOARDS[n];
  if (!b) return null;
  const cards = [];
  for (let i = 0; i < b.wolf; i++) cards.push('wolf');
  for (let i = 0; i < b.villager; i++) cards.push('villager');
  for (const g of b.gods) cards.push(g);
  return {
    players: n,
    wolf: b.wolf,
    villager: b.villager,
    gods: b.gods.slice(),
    cards,
    witchAntidoteOnly: Boolean(b.witchAntidoteOnly),
  };
}

/** 板子的中文描述，例如「2 狼 · 2 民 · 预言家、女巫」 */
export function boardLabel(board) {
  if (!board) return '';
  const gods = board.gods.map((g) => ROLES[g].name).join('、');
  return `${board.wolf} 狼 · ${board.villager} 民 · ${gods}`;
}

/** 阵营中文名 */
export function teamName(team) {
  return team === TEAM_WOLF ? '狼人阵营' : '好人阵营';
}

/* ================================================================== *
 * 2. 纯规则：发牌 / 存活统计 / 胜负
 * ================================================================== */

/** 洗牌（Fisher–Yates；与 core/util.js 同实现，这里内联以免再引一个依赖） */
function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/**
 * 发牌：把板子里的身份随机分给所有玩家
 * 座位号 = 入参顺序（下标 + 1），所以**想让座位随机就得先把名单洗一遍再传进来**
 * （`createState()` 就是这么做的）；身份牌在这里独立洗一次。
 * @param {Array<{id:string,name:string,isUser?:boolean}>} players 座位顺序即名单顺序
 * @param {object} board boardFor() 的结果
 * @returns {Array<object>} 带 role/team 的玩家数组（新数组，不改入参）
 */
export function assignRoles(players, board) {
  const cards = shuffled(board.cards);
  return players.map((p, i) => {
    const roleId = cards[i] || 'villager';
    const role = ROLES[roleId] || ROLES.villager;
    return {
      id: String(p.id),
      name: String(p.name || `玩家${i + 1}`),
      model: p.model,
      seat: i + 1,
      isUser: Boolean(p.isUser),
      role: role.id,
      team: role.team,
      god: role.god,
      alive: true,
      /** 白痴翻牌后失去投票权 */
      canVote: true,
      /** 白痴是否已经翻过牌 */
      revealedIdiot: false,
      deadReason: '',
    };
  });
}

/** 存活玩家 */
export function aliveOf(state) {
  return (state.players || []).filter((p) => p.alive);
}

/** 按阵营统计存活（神 / 民 / 狼） */
export function countAlive(state) {
  const alive = aliveOf(state);
  return {
    wolf: alive.filter((p) => p.team === TEAM_WOLF).length,
    god: alive.filter((p) => p.team === TEAM_GOOD && p.god).length,
    villager: alive.filter((p) => p.team === TEAM_GOOD && !p.god).length,
    total: alive.length,
  };
}

/**
 * 屠边胜负判定
 * @param {object} state
 * @returns {''|'wolf'|'good'} 空串表示继续
 */
export function checkWinner(state) {
  const c = countAlive(state);
  if (c.wolf === 0) return TEAM_GOOD; // 狼全出局 → 好人胜
  if (c.god === 0) return TEAM_WOLF; // 神职被清空 → 狼胜（屠神）
  if (c.villager === 0) return TEAM_WOLF; // 平民被清空 → 狼胜（屠民）
  return '';
}

/**
 * 把「投票明细」汇总成票数
 * @param {Array<{seat:number|null}>} ballots
 * @returns {Record<number, number>}
 */
export function tallyVotes(ballots) {
  const out = {};
  for (const b of Array.isArray(ballots) ? ballots : []) {
    const seat = Number(b && b.seat);
    if (!seat) continue;
    out[seat] = (out[seat] || 0) + 1;
  }
  return out;
}

/**
 * 票数的中文描述，例如「3 号 林晚 2 票 · 5 号 小满 1 票」
 *
 * **tally 必须由调用方明确给出**：这里不回退到 `state.voteLive`。
 * `voteLive` 是"收票期间"的实时票数（不对外公开，见 publicVoteTally），
 * 早先这个回退会让 `tallyText(state)` 这类顺手调用把没投完的票数画到界面上。
 * @param {object} state
 * @param {Record<number, number>} tally
 * @returns {string} 没有票时返回空串
 */
export function tallyText(state, tally) {
  const t = tally || {};
  const entries = Object.entries(t)
    .map(([seat, n]) => [Number(seat), Number(n)])
    .filter(([seat, n]) => seat && n > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (!entries.length) return '';
  return entries.map(([seat, n]) => `${seat} 号 ${((state && bySeat(state, seat)) || {}).name || ''} ${n} 票`).join(' · ');
}

/**
 * 现在允许对外公开的票数（界面只认这一个来源）。
 *
 * **盲投**：投票是"一人一票、投完即定"的，收票期间把"谁现在几票"亮出来，
 * 等于替还没投的人（尤其是你）做决定 —— 所以：
 *   · `state.voteOpen === true`（正在收票，含平票 PK 重投）→ 一律返回空；
 *   · 只有本轮**结算完**（法官公告那一刻写入的 `state.voteResult`）才返回票数。
 * `state.voteLive` 因此只是引擎内部的实时计数，**任何界面/提示词都不准直接读它**。
 * @param {object} state
 * @returns {Record<number, number>} 未公开时返回空对象
 */
export function publicVoteTally(state) {
  if (!state || state.voteOpen) return {};
  const t = state.voteResult && state.voteResult.tally;
  return t && typeof t === 'object' ? t : {};
}

/**
 * 本轮投票结算：结束"收票中"并写入**可公开**的票数（界面随即显示"投票结果：…"）。
 *
 * 只允许在"票已经收完、结果马上就要公告"这一刻调用 —— 早一步调用就是提前泄票，
 * 晚一步调用则会让界面停在"投票中"（`werewolfcheck` 的盲投用例守着这个时机）。
 * @param {object} state
 * @param {Record<number, number>} tally 本轮最终票数（PK 之后传重投的票数）
 */
function publishVoteResult(state, tally) {
  state.voteOpen = false;
  state.voteResult = { day: Number(state.day) || 0, round: Number(state.voteRound) || 0, tally: tally || {} };
}

/** 按座位号取玩家 */
export function bySeat(state, seat) {
  return (state.players || []).find((p) => p.seat === Number(seat)) || null;
}

/** 按 id 取玩家 */
export function byId(state, id) {
  return (state.players || []).find((p) => String(p.id) === String(id)) || null;
}

/** 存活玩家的座位文本，例如「1 号 林晚、3 号 阿哲」 */
export function seatList(players) {
  return players.map((p) => `${p.seat} 号 ${p.name}`).join('、');
}

/* ================================================================== *
 * 3. 提示词：私密身份 / 夜间行动 / 白天发言
 * ================================================================== */

/** 公开信息的文本（法官公告 + 已公开的发言，供角色判断局势） */
export function publicLogText(state, limit = 40) {
  const list = (state.log || []).slice(-limit);
  return list.length ? list.join('\n') : '（还没有任何公开信息）';
}

/**
 * 本轮发言顺序的**引擎视角**：谁先谁后、我在第几位、谁已经说过、谁还没轮到。
 *
 * 为什么要有这个：白天是**按座位顺序依次发言**（见 phaseDay 的循环），但提示词里只有
 * 「存活玩家」和「已经公开发生的事」两段 —— 模型看得到"谁说过话"，看不出"轮到谁了"，
 * 于是后置位的沉默会被当前发言人当成**有意不吭声**："9 号被人捞了一整轮还不出声，
 * 这反倒比 1 号更值得记一笔"（线上实测：8 号发言时去质问还没轮到的 9 号）。
 * 顺序发言里这是不存在的疑点，属于模型"看错了时间线"，必须由引擎把顺序讲清楚。
 *
 * 顺序与引擎的循环**一致**（别在这里另算一套）：普通发言＝存活玩家按座位升序（phaseDay），
 * PK 发言＝平票者按座位升序（phaseVote）。
 *
 * @param {object} state
 * @param {object} me 正在发言的人
 * @param {{pkSeats?: number[], spoken?: number[]|Set<number>}} [opts]
 *   `pkSeats`：平票 PK 发言的候选座位（顺序即 PK 顺序）
 *   `spoken`：这一轮**已经发过言**的座位；缺省读 `state.spokenSeats`（引擎在发言循环里维护）
 * @returns {{order:object[], index:number, spokenBefore:object[], pending:object[]}}
 *   `order` 全部发言人（按发言顺序）、`index` 我的下标（-1 = 我不在顺序里）、
 *   `spokenBefore` 我前面已发过言的、`pending` 我后面**还没轮到**的
 */
export function speakOrderFor(state, me, opts = {}) {
  const empty = { order: [], index: -1, spokenBefore: [], pending: [] };
  if (!state || !me) return empty;
  const pkSeats = Array.isArray(opts.pkSeats) && opts.pkSeats.length ? opts.pkSeats.map(Number) : null;
  const alive = aliveOf(state);
  const order = pkSeats ? alive.filter((p) => pkSeats.includes(Number(p.seat))) : alive;
  const index = order.findIndex((p) => String(p.id) === String(me.id));
  if (index < 0) return { ...empty, order };
  const raw = opts.spoken === undefined || opts.spoken === null ? state.spokenSeats : opts.spoken;
  const known = raw instanceof Set || Array.isArray(raw); // 有没有"谁已经说过"的权威记录
  const seats = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : [];
  const spoken = new Set(seats.map(Number));
  /**
   * 没有权威记录时（直接拼提示词的调用方、老存档）按**顺序发言的常态**推断：
   * 排在我前面的人已经说过了，后面的还没轮到 —— 否则这段会写出"你是第一个发言的人"这种假话，
   * 反而把模型的判断带偏。
   */
  const saidBefore = (p) => (known ? spoken.has(Number(p.seat)) : true);
  return {
    order,
    index,
    spokenBefore: order.slice(0, index).filter(saidBefore),
    // 我后面这些人**还没轮到**（已经有记录的、说过话的（异常情况）不算"还没轮到"）
    pending: order.slice(index + 1).filter((p) => !known || !spoken.has(Number(p.seat))),
  };
}

/**
 * 「本轮发言顺序」那一段提示词（只给**正在发言的这个人**看，内容全是公开信息）。
 *
 * 作用有两个：① 告诉它自己是第几位、谁已经说过；② 明确禁止"催/点评还没轮到的人不说话"。
 * 不写这段时，模型会把"公开记录里没有 9 号"读成"9 号一直躲着不说话"（见 speakOrderFor 的注释）。
 * @param {object} state
 * @param {object} me
 * @param {{pkSeats?: number[], spoken?: number[]|Set<number>}} [opts] 同 speakOrderFor
 * @returns {string} 拼进 dayPromptFor 的一段（不在顺序里时返回空串）
 */
export function speakOrderNote(state, me, opts = {}) {
  const { order, index, spokenBefore, pending } = speakOrderFor(state, me, opts);
  if (index < 0 || !order.length) return '';
  const pk = Array.isArray(opts.pkSeats) && opts.pkSeats.length;
  const lines = ['【发言顺序（重要）】'];
  lines.push(
    pk
      ? `· 这一轮是**平票 PK 发言**：只有平票的 ${seatList(order)} 按座位顺序各说一次，你是第 ${index + 1} 位。`
      : `· 这一轮是**按座位顺序依次发言**（法官公告里的原话）：${seatList(order)}；你是第 ${index + 1} 位（全场共 ${order.length} 位）。`
  );
  if (spokenBefore.length) {
    lines.push(
      pk
        ? `· 在你之前已经 PK 发言过的是：${seatList(spokenBefore)}。`
        : `· 在你之前已经发过言的是：${seatList(spokenBefore)}——他们说了什么，上面的公开记录里都有。`
    );
  } else {
    lines.push(pk ? '· 你是第一个做 PK 发言的人。' : '· 你是这一轮第一个发言的人，在你之前还没有人说过话。');
  }
  if (pending.length) {
    lines.push(`· **还没轮到的**：${seatList(pending)}——他们此时**还没有机会开口**（不是你问过他们、他们不理你）。`);
    lines.push(
      '· 所以不要催他们发言，也不要拿"到现在不吭声 / 一直不出声 / 被人捞了还不表态 / 怎么不接话 / 太安静了"当理由去怀疑或点评他们' +
        '——顺序发言里这很正常，不是心虚，也不能记成疑点。'
    );
    lines.push(
      '· 你这一轮只能就法官公告和**已经发过言的人**下判断；想听后面那些人的态度，就等他们说完，' +
        '或者只说"等 X 号表态"（表示想听，不要当成疑点）。'
    );
  } else {
    lines.push('· 你身后没有还没发言的人了，全场该说的都说过了。');
  }
  return lines.join('\n');
}

/** "沉默/催发言"的用词（与座位号同时出现时才算"催还没轮到的人"，见 looksLikeSilenceUrge） */
const SILENCE_HINT =
  /(不说话|没说话|不吭声|没吭声|不出声|没出声|不表态|没表态|不接话|没接话|不开口|没开口|沉默|装死|不发言|没发言|还没说|还没表态|怎么还不说|为什么不说话)/;
/** 句子里带这些时间标记时，说的是**之前几轮**的事，不按"催本轮还没轮到的人"处理 */
const PAST_ROUND_HINT = /(昨天|昨晚|昨夜|昨日|前天|上一轮|上轮|前一轮|首夜|第一晚|第\s*\d+\s*[天晚])/;
/** 整段都在催还没轮到的人时换上的场面话（不违规、也不催人；见 guardSilenceUrge） */
const SILENCE_URGE_FALLBACK = '（摊了摊手）我这轮没什么要多说的，先说这些。';

/**
 * 这句发言里有没有"催/点评**还没轮到的人**不说话"。
 *
 * 这是顺序发言里典型的**时间线错乱**（见 speakOrderFor）：主要防线是提示词里的
 * speakOrderNote，这里只是兜底 —— 只在真的点名了"还没轮到的座位 + 沉默"时才判。
 * 为了避免误伤"5 号昨天一整轮都没怎么说话"这种**对过去几轮的正常复盘**，
 * 句子里带时间标记（昨天/上轮/第 N 天…）时一律放过。
 * @param {string} text
 * @param {object} state
 * @param {object} me
 * @param {{pkSeats?: number[], spoken?: number[]|Set<number>}} [opts] 同 speakOrderFor
 * @returns {boolean}
 */
export function looksLikeSilenceUrge(text, state, me, opts = {}) {
  const t = String(text || '');
  if (!t || !state || !me) return false;
  const { pending } = speakOrderFor(state, me, opts);
  if (!pending.length) return false;
  for (const sen of t.split(/(?<=[。！？!?…\n])/)) {
    const line = sen.trim();
    if (!line || /^投票\s*[:：]/.test(line)) continue; // 投票行另走解析，不算发言
    if (PAST_ROUND_HINT.test(line)) continue; // 说的是之前几轮的事，不是"本轮还没轮到"
    if (!SILENCE_HINT.test(line)) continue;
    const hit = pending.some((p) => {
      const bySeat = new RegExp(`(^|[^0-9])${p.seat}\\s*号`).test(line);
      const byName = p.name && p.name.length >= 2 && line.includes(p.name);
      return bySeat || byName;
    });
    if (hit) return true;
  }
  return false;
}

/**
 * 把"催还没轮到的座位说话"的整句删掉（保留其它正常发言）。
 * @param {string} text
 * @param {object} state
 * @param {object} me
 * @param {{pkSeats?: number[], spoken?: number[]|Set<number>}} [opts] 同 speakOrderFor
 * @returns {string} 删干净后剩下的发言（全被删光时返回空串）
 */
export function stripSilenceUrge(text, state, me, opts = {}) {
  const raw = String(text || '');
  if (!raw) return '';
  const kept = raw.split(/(?<=[。！？!?…\n])/).filter((sen) => {
    const line = sen.trim();
    if (!line) return false;
    if (/^投票\s*[:：]/.test(line)) return true;
    return !looksLikeSilenceUrge(sen, state, me, opts);
  });
  return kept.join('').trim();
}

/**
 * 某位玩家"自己知道的信息"（其他角色绝对看不到）
 * @param {object} state
 * @param {object} me
 * @returns {string}
 */
export function privateFacts(state, me) {
  const facts = [];
  const role = ROLES[me.role] || ROLES.villager;
  if (me.team === TEAM_WOLF) {
    const mates = (state.players || []).filter((p) => p.team === TEAM_WOLF && p.id !== me.id);
    const aliveMates = mates.filter((p) => p.alive);
    const mateText = mates
      .map((p) => p.seat + ' 号 ' + p.name + (p.alive ? '' : '（已出局）'))
      .join('、');
    facts.push(mates.length ? `你的狼同伴：${mateText}` : '本局没有其他狼人');
    if (aliveMates.length) facts.push(`还活着的同伴：${seatList(aliveMates)}`);
    facts.push('规则：狼队每晚只能刀一个人，你们要统一刀口；可以刀任何人（含同伴与你自己的自刀）');
  }
  if (role.id === 'seer') {
    const checks = (state.seerChecks || []).map((c) => `${c.seat} 号 ${c.name} 是「${c.result === TEAM_WOLF ? '狼人' : '好人'}」`);
    facts.push(checks.length ? `你查验过的结果：${checks.join('；')}` : '你还没有查验过任何人');
  }
  if (role.id === 'witch') {
    const noPoison = Boolean(state.board && state.board.witchAntidoteOnly);
    facts.push(
      `解药：${state.witch && state.witch.antidote ? '还在' : '已用完'}` +
        (noPoison ? '（本局你没有毒药，只有这一瓶解药）' : `；毒药：${state.witch && state.witch.poison ? '还在' : '已用完'}`)
    );
    // 这两条是引擎强制的规则，必须告诉女巫，否则她会一直"想自救"却发现自己没救成
    facts.push('规则：你不能自救（自己被刀时解药救不了自己）');
    if (!noPoison) facts.push('规则：同一晚不能同时使用解药和毒药');
  }
  if (role.id === 'hunter') facts.push('规则：你被狼刀或被票出时可以开枪带走一人；被女巫毒死不能开枪');
  if (role.id === 'idiot') facts.push('规则：你被投票放逐时翻牌免死一次，之后失去投票权但仍可发言');
  if (role.id === 'villager') facts.push('你没有特殊技能，靠发言与投票帮助好人');
  return facts.join('\n');
}

/**
 * 本局规则速查（按实际板子生成，保证"说的规则"和"引擎执行的规则"一致）
 * @param {object} state
 * @param {boolean} [short] true = 夜间用的精简版（省 token）
 * @returns {string}
 */
export function ruleCardFor(state, short) {
  const board = (state && state.board) || {};
  const n = num(board.players, 0);
  const gods = Array.isArray(board.gods) ? board.gods.map((g) => (ROLES[g] || {}).name || g).join('、') : '';
  const witchNote = board.witchAntidoteOnly ? '（本局女巫只有一瓶解药，没有毒药）' : '';
  if (short) {
    return [
      '【规则速查】每晚狼人**只能刀一个人**（狼队要统一刀口），可以刀任何人（含同伴与自刀）；女巫不能自救、同一晚不能同时用解药和毒药（两瓶药各一次）' + witchNote + '；',
      '预言家查验结果是「好人 / 狼人」；猎人被刀/被票出可开枪、被毒不能；白痴被票出翻牌免死一次后失去投票权；',
      '出局的人不再发言也不投票。胜负为「屠边」：狼人杀光全部神职或全部平民即获胜，好人放逐/毒杀/枪杀所有狼人即获胜。',
    ].join('');
  }
  return [
    '【本局规则速查（请严格遵守）】',
    `· 人数与板子：${n} 人局 = ${board.wolf || 0} 狼 + ${board.villager || 0} 民 + ${gods || '无神职'}${witchNote}。`,
    '· 流程：夜晚（狼人刀人 → 女巫用药 → 预言家查验）→ 天亮公布死讯（只说谁出局，不公布死因）→ 白天依次发言 → 全体投票放逐（得票最多者出局；平票则平票者 PK 后由其他人重投，再平票本轮无人出局）→ 进入下一夜。',
    '· 夜晚的限制：**狼人每晚只能刀一个人**（狼队要统一刀口），候选是**所有存活玩家**——可以刀同伴，也可以自刀（自刀常用来骗女巫的解药）；女巫**不能自救**，且**同一晚不能同时用解药和毒药**，两瓶药各只有一次；预言家每晚只能查验一人，结果是「好人 / 狼人」。',
    '· 技能的触发：猎人被狼刀或被票出时可以开枪带走一人，**被女巫毒死则不能开枪**；白痴被投票放逐时翻牌免死一次，之后失去投票权但仍可发言。',
    '· 结算顺序（场规）：一批人出局时**先结算出局、再看是否达成屠边**；若猎人出局正好让神职全灭，狼人立刻获胜，这枪不再开。同一批里狼人也全灭时，按「狼人全灭优先」算好人胜。',
    '· 出局的人不再发言、不参与投票，也不能再给场上暗示。',
    '· 胜负（屠边）：狼人杀光全部神职、或杀光全部平民即获胜；好人放逐/毒杀/枪杀所有狼人即获胜。',
    '· 所有人都不知道别人的身份，只能靠发言与投票推理；你可以悍跳、撒谎、带节奏，但不能说出"这是系统给我的身份"之类的话。',
  ].join('\n');
}

/**
 * HUD 上"你的身份"后面的实时摘要：需要一直盯着的信息放在这儿，省得靠脑子记。
 * 纯函数，便于单测；界面直接把它拼在身份后面。
 *   · 狼人：狼队友是谁（谁出局了会立刻标出来）
 *   · 预言家：已验出几个狼 / 几个好人
 *   · 女巫：两瓶药还剩哪个（6 人局只有解药）
 *   · 白痴：是否已经翻过牌
 * @param {object} state
 * @param {object} me
 * @returns {string} 形如「（狼队友：2 号 阿哲、5 号 小满（已出局））」；没内容时返回空串
 */
export function hudExtraFor(state, me) {
  if (!state || !me) return '';
  const role = ROLES[me.role] || ROLES.villager;
  const parts = [];
  if (role.id === 'wolf') {
    const mates = (state.players || []).filter((p) => p && p.team === TEAM_WOLF && String(p.id) !== String(me.id));
    if (!mates.length) {
      parts.push('你是独狼（本局只有你一只狼）');
    } else {
      const list = mates.map((p) => `${p.seat} 号 ${p.name}${p.alive ? '' : '（已出局）'}`).join('、');
      // 队友都出局了就明确告诉你现在是独狼，别让你自己去数
      parts.push(`狼队友：${list}${mates.some((p) => p.alive) ? '' : ' · 你现在是独狼'}`);
    }
  }
  if (role.id === 'seer' && (state.seerChecks || []).length) {
    const wolfN = state.seerChecks.filter((c) => c.result === TEAM_WOLF).length;
    parts.push(`已验 ${wolfN} 狼 / ${state.seerChecks.length - wolfN} 好`);
  }
  if (role.id === 'witch') {
    const antidote = Boolean(state.witch && state.witch.antidote);
    const poison = Boolean(state.witch && state.witch.poison);
    if (!poison && state.board && state.board.witchAntidoteOnly) {
      parts.push(`解药${antidote ? '还在' : '已用完'}（本局只有解药）`);
    } else {
      parts.push(`解药${antidote ? '还在' : '已用完'} · 毒药${poison ? '还在' : '已用完'}`);
    }
  }
  if (role.id === 'idiot' && me.revealedIdiot) parts.push('已翻牌（失去投票权）');
  return parts.length ? `（${parts.join('｜')}）` : '';
}

/**
 * 阵营专属的"必须遵守"（狼人绝不能认狼；好人可以亮身份）。
 * 单独抽出来是因为这是本游戏最重要的一条行为红线：
 * 狼人一旦自曝，整局博弈就没了，属于直接违规。
 * @param {object} me
 * @returns {string}
 */
export function teamRuleFor(me) {
  if (!me) return '';
  if (me.team === TEAM_WOLF) {
    return [
      '【你必须遵守（狼人阵营）】',
      '· **任何情况下都不要承认自己是狼人**：被预言家查杀、被投票放逐、被逼问、甚至留下遗言时都不行。认狼＝直接送掉这局，属于严重违规。',
      '· **绝不能出卖狼同伴**：不要指认同伴是狼，也不要说同伴"可疑/有问题"，更不要在悍跳预言家时报"我验了同伴是狼"。出卖队友＝替好人清狼坑，等于帮对面赢。',
      '· 悍跳预言家时可以编造查验，但**假查验（尤其是"查杀"）必须泼给好人**（平民或神职都行，指认已经出局的好人风险最低）；要"卖"也只能卖已经不可能是狼的死人。',
      '· 你要像真人一样硬撑到底：可以倒钩帮好人分析以骗取信任、可以把怀疑引向好人、可以给好人留假信息。',
      '· 被票出时也一样：装作被冤枉的好人，或者反咬一口把水搅浑——咬好人，别咬同伴，别让好人靠你的遗言锁定剩下的狼。',
    ].join('\n');
  }
  return [
    '【你必须遵守（好人阵营）】',
    '· 你是好人，不需要撒谎；需要时可以亮身份（预言家报查验、猎人亮身份）来带节奏。',
    '· 出局时的遗言可以公布身份与关键信息（查验结果、怀疑对象），帮好人缩小范围。',
  ].join('\n');
}

/** 一眼看出"这句话是不是在认狼"的句式（只认第一人称承认，不误伤"3 号是狼"这类指认） */
const WOLF_CONFESS_PATTERNS = [
  /我(?:就|确实|真的|其实|本来|反正)?是(?:一只|一个|个)?狼(?!人杀)(?:人)?/,
  /狼人(?:就)?是我/,
  /我(?:认|承认|坦白|招了|自曝|爆|摊牌)[了]?(?:自己是)?狼/,
  /不装了[，,]?\s*我(?:就)?是狼/,
  // 复数 / 把同伴一起供出来（模型很自然会这么写，只认单数会漏，等于当众把狼队卖了）：
  //   「我和 4 号都是狼」「我们两个是狼」「我们是狼」「我们狼队」「4 号是我狼同伴」「狼队友别装了」
  // 每条都要求"复数标记或座位号"紧贴狼字，避免误伤「我们投 3 号，他是狼人」这类指认别人的话。
  /(?:我|咱)们(?:两个|俩)?\s*(?:都|也|一起|一块)?\s*是\s*(?:狼|狼人)(?!人杀)/,
  /(?:我|咱)(?:和|跟|与)\s*\d{1,2}\s*号[^。！？!?\n]{0,6}?是\s*(?:狼|狼人)/,
  /(?:我|咱)们\s*(?:狼|狼人)\s*(?:队|阵营|这边|那边)/,
  /(?:我|咱)(?:的)?\s*狼\s*(?:同伴|队友|队)/,
  /狼\s*(?:同伴|队友)\s*(?:别|不要|快|一起|出来|认|装|演|藏|还有)/,
];
/** 假设句不算认狼：「如果我是狼，早就刀你了」 */
const HYPOTHETICAL_HINT = /(如果|要是|假设|假如|若|就算|哪怕|万一|除非)[^。！？!?]{0,12}$/;

/**
 * 这段文本里有没有"认狼"（狼人自曝）。
 * 用于兜底：万一模型不听话，引擎会在发言/遗言里把这种句子拿掉。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeWolfConfession(text) {
  const t = String(text || '');
  if (!t) return false;
  for (const re of WOLF_CONFESS_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of t.matchAll(g)) {
      const before = t.slice(Math.max(0, m.index - 14), m.index);
      if (HYPOTHETICAL_HINT.test(before)) continue; // 假设句
      return true;
    }
  }
  return false;
}

/** 指认同伴的口径（"是狼/查杀/可疑"这类）；与"保人"口径互斥使用时更准 */
const MATE_ACCUSE = /(是狼|狼人|查杀|狼坑|标狼|狼面|悍跳|可疑|有问题|怀疑|出他|出掉|票他|投他|推他)/;
/** 明显的"保同伴"口径：说了这些就不算出卖 */
const MATE_DEFEND = /(不是狼|不像狼|没问题|好人|保他|保了|捞他|捞一下|挺他|信他|站他)/;

/**
 * 这段文本里有没有"出卖狼同伴"——指认同伴是狼 / 说同伴可疑。
 * 这是狼人最典型的战术失误：悍跳预言家时报"我验了同伴是狼"，
 * 等于替好人清狼坑。提示词里已经禁止，这里做兜底检测。
 * 说明：这是**启发式**判断（按句匹配 + 只认同伴的座位号/名字），
 * 主要防线仍是提示词；宁可少判，也不要误伤"我保 9 号"这种正常发言。
 * @param {string} text
 * @param {object} state
 * @param {object} me
 * @returns {boolean}
 */
export function looksLikeSellingTeammate(text, state, me) {
  const t = String(text || '');
  if (!t || !me || me.team !== TEAM_WOLF) return false;
  const mates = ((state && state.players) || []).filter((p) => p.team === TEAM_WOLF && String(p.id) !== String(me.id));
  if (!mates.length) return false;
  const sentences = t.split(/(?<=[。！？!?…\n])/);
  for (const sen of sentences) {
    const line = sen.trim();
    if (!line) continue;
    if (/^投票\s*[:：]/.test(line)) continue; // 投票声明单独走投票逻辑，不算"发言咬人"
    const hit = mates.some((m) => {
      const seatRe = new RegExp(`(^|[^0-9])${m.seat}\\s*号`);
      const bySeat = seatRe.test(line);
      const byName = m.name && m.name.length >= 2 && line.includes(m.name);
      return bySeat || byName;
    });
    if (!hit) continue;
    if (MATE_ACCUSE.test(line) && !MATE_DEFEND.test(line)) return true;
  }
  return false;
}

/**
 * 把"咬同伴"的整句删掉（保留其它正常发言）
 * @param {string} text
 * @param {object} state
 * @param {object} me
 * @returns {string}
 */
export function stripTeammateAccusation(text, state, me) {
  const raw = String(text || '');
  if (!raw) return '';
  const sentences = raw.split(/(?<=[。！？!?…\n])/);
  const kept = sentences.filter((sen) => {
    const line = sen.trim();
    if (!line) return false;
    if (/^投票\s*[:：]/.test(line)) return true;
    return !looksLikeSellingTeammate(sen, state, me);
  });
  return kept.join('').trim();
}

/**
 * 把"认狼"的整句删掉（保留其它正常发言）。
 * @param {string} text
 * @returns {string} 删干净后剩下的发言（全被删光时返回空串）
 */
export function stripWolfConfession(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const sentences = raw.split(/(?<=[。！？!?…\n])/);
  const kept = sentences.filter((sen) => sen.trim() && !looksLikeWolfConfession(sen));
  return kept.join('').trim();
}

/** 私密身份提示词（注入到"只有这位角色看得到"的 system 里） */
export function privateNoteFor(state, me) {
  if (!state || !me) return '';
  const role = ROLES[me.role] || ROLES.villager;
  return [
    '【狼人杀 · 你的私密身份（只有你自己知道，绝不能直接说破）】',
    `你是「${role.name}」，属于${teamName(me.team)}。你的座位是 ${me.seat} 号。技能：${role.desc}。`,
    privateFacts(state, me),
    ruleCardFor(state, false),
    `你的胜利条件：${me.team === TEAM_WOLF ? '让好人阵营的「神职」全部出局，或让「平民」全部出局（屠边）' : '把狼人全部找出来放逐/毒杀/枪杀'}`,
    teamRuleFor(me),
    '· 说话要用玩家的口吻（"我觉得 3 号有问题"），别用"系统告诉我"这类口吻，也别复述规则。',
  ].join('\n');
}

/**
 * 夜间行动的提示词（不装人设、不吃人设 token；狼人这一支额外带**公开记录**，见下方注释）
 * @param {object} state
 * @param {object} me 这次要行动的角色
 * @param {'wolf'|'seer'|'witch'} kind
 * @param {string} [extra] 女巫专用：由调用方按 canSave/canPoison 拼的选项说明
 * @returns {string}
 */
export function nightPromptFor(state, me, kind, extra = '') {
  const alive = aliveOf(state);
  const others = alive.filter((p) => p.id !== me.id);
  const head = [
    `【狼人杀 · 夜间行动】你是 ${me.seat} 号 ${me.name}，身份「${ROLES[me.role].name}」。`,
    privateFacts(state, me),
    `存活玩家：${seatList(alive)}`,
    ruleCardFor(state, true),
  ];
  if (kind === 'wolf') {
    head.push(
      `现在是夜晚，你和同伴要刀杀一人。候选（**所有存活玩家都可以选**，包括同伴和你自己——自刀可以骗女巫的解药）：${seatList(alive) || '无'}`,
      '',
      // 夜里也得让狼看得到白天发生了什么。早先这里只有"存活名单 + 规则"：谁跳了预言家、
      // 谁在带队冲你的同伴、票都投给了谁、前几晚死了谁，AI 狼一概不知道，刀口只能靠模型直觉
      // （接近随机），"屠边优先刀神职"这种最基本的思路都落不了地。
      // 白天发言 / 投票的提示词早就带着这段公开记录（见 dayPromptFor / votePromptFor），
      // 夜里这一段同样只是**公开信息**（法官公告 + 已公开的发言，见 publicLogText），
      // 里面不含任何人的身份（开局只公告"身份已发到每个人手里"，见 phaseStart），
      // 所以喂给狼不会泄露秘密——这个不变量由 werewolfcheck 的 S 用例守着。
      '【已经公开发生的事】',
      publicLogText(state, 40),
      '',
      '· 挑刀口要结合上面的公开信息：优先刀自称预言家并报了查验结果的人、带队指认你同伴的人、最受好人信任的人（屠边局里刀神职收益最高）；也可以自刀骗女巫的解药。',
      '只输出一行，格式：刀杀：<编号>号'
    );
  } else if (kind === 'seer') {
    head.push(`现在是夜晚，你要查验一人是好人还是狼人。候选：${seatList(others.filter((p) => !(state.seerChecks || []).some((c) => c.id === p.id)))}`, '只输出一行，格式：查验：<编号>号');
  } else if (kind === 'witch') {
    // 女巫夜里也要看得到白天公开发生过什么（和上面的狼一致）：狼能看到"谁跳了预言家、谁在带队冲狼"
    // 才挑得出刀口，女巫同样只有看到这些，才知道该不该下毒、毒谁——否则她手上只有"今晚谁被刀 +
    // 存活名单"，毒口等于拍脑袋（早先线上就是这种表现：白天已经把某人认成狼，夜里却没有渠道把这个
    // 判断带进用药决策）。
    // 这段同样只是**公开信息**（法官公告 + 已公开的发言/投票，见 publicLogText），不含任何人的身份，
    // 喂给女巫不会泄露秘密——这个不变量由 werewolfcheck 的 L 用例守着。
    // 顺序不能动：extra（今晚被刀的人 + 用药选项菜单）必须留在最后，它要以"只输出一行…"收尾。
    // 具体有哪些选项由调用方按 canSave/canPoison 生成（见 phaseNight），避免列出本局根本不存在的药
    //
    // 再加一段"怎么用药"的思路（对应上面 wolf 分支那句"怎么挑刀口"）：
    //   · 只进这里（AI 的提示词），**不进 phaseNight 的 witchExtra** —— witchExtra 同时是真人女巫
    //     操作条上的 hint，怎么用药是玩家自己的事，游戏不该在旁边教他打牌。
    //   · 毒药候选要写明：AI 手上有"存活玩家"名单（含她自己），而引擎只接受"存活且非本人"的座位
    //     （见 phaseNight 的 parsePoisonOrder 白名单）——不写清楚，模型报自己或报已出局的人就白报一次，
    //     整晚的毒药决策会静默作废（药不消耗，但这一夜的判断没了）。
    //   · 段里**不要出现"今晚"二字**：werewolfcheck 的 T 条按 `prompt.indexOf('今晚')` 截女巫那段
    //     extra 来核对措辞，多一处会把它截错行。
    const poisonLeft = !(state.board && state.board.witchAntidoteOnly) && Boolean(state.witch && state.witch.poison);
    head.push(
      '【已经公开发生的事】',
      publicLogText(state, 40),
      '',
      '· 用药思路：解药优先救"被刀且像好人或关键神职"的人（你自己被刀时救不了自己）；拿不准被刀的是敌是友时可以不救，药留着后面照样有用。',
      ...(poisonLeft
        ? [
            '· 毒药思路：毒药是一次性的重武器，用来带走**最像狼**的人 —— 被公开查杀、被多人点名围票、发言与投票自相矛盾的人优先；首夜这种还没有可信信息的局面，留着往往比盲毒划算（毒错一个好人等于白送狼人一轮）。',
            `· 毒药候选（**不能毒自己**，也不能毒已出局的人）：${seatList(others) || '无'}`,
          ]
        : []),
      '',
      extra
    );
  }
  return head.join('\n');
}

/**
 * 白天发言的提示词（复用角色人设，让发言有性格）
 *
 * 顺序发言这一段（speakOrderNote）是**必须的**：公开记录里只有"谁已经说过什么"，
 * 没有"轮到谁了"，模型会把后置位的沉默读成"故意不吭声"（见 speakOrderFor 的注释）。
 * @param {object} state
 * @param {object} me
 * @param {{withVote?:boolean, pkSeats?:number[], spoken?:number[]}} [opts]
 *   `pkSeats` / `spoken`：平票 PK 发言时由 phaseVote 传进来（顺序与已 PK 过的座位）
 */
export function dayPromptFor(state, me, opts = {}) {
  const alive = aliveOf(state);
  const withVote = opts.withVote !== false;
  const orderNote = speakOrderNote(state, me, opts);
  return [
    `【狼人杀 · 第 ${state.day} 天 · 白天发言】`,
    `你是 ${me.seat} 号 ${me.name}，身份「${ROLES[me.role].name}」（${teamName(me.team)}）。`,
    privateFacts(state, me),
    `存活玩家：${seatList(alive)}`,
    '',
    '【已经公开发生的事】',
    publicLogText(state, 40),
    '',
    ...(orderNote ? [orderNote, ''] : []),
    '【发言要求】',
    '· 像真人玩狼人杀那样发言：1~3 句，表明立场、分析局势、可以怀疑或替别人说话（踩/捞）。',
    '· 可以在发言里声称自己是预言家并给出查验结论（悍跳或真报都行），也可以质疑别人的身份。',
    '· 按顺序发言：还没轮到的人此刻**还没有机会说话**，别催他们、也别拿"他不吭声"当疑点（见上面的【发言顺序】）。',
    '· 不要写旁白、不要用列表、不要复述法官公告。',
    teamRuleFor(me),
    withVote
      ? '· 发言之后，另起一行写你的投票，格式：投票：<编号>号（只能投存活玩家，也可以写 投票：弃票）'
      : '· 这一轮只发言，先不要投票。',
  ].join('\n');
}

/**
 * 投票提示词（标准模式下，听完所有人发言后单独投一次）
 * @param {object} state
 * @param {object} me
 * @param {{__pk?: number[]}} [me] `me.__pk` 存在时表示"平票 PK 重投"，候选只能是这几个座位
 */
export function votePromptFor(state, me) {
  const pk = Array.isArray(me && me.__pk) && me.__pk.length ? me.__pk.map(Number) : null;
  // 平票重投：候选**只能**是平票的那几位（引擎收票时也只认这几个座位，见 phaseVote），
  // 早先这里给的是"除自己外全部存活玩家"，AI 投第三个人会被静默丢掉（等于弃票）。
  const alive = pk
    ? aliveOf(state).filter((p) => pk.includes(p.seat))
    : aliveOf(state).filter((p) => p.id !== me.id && p.canVote !== false);
  return [
    `【狼人杀 · 第 ${state.day} 天 · ${pk ? '平票 PK 重投' : '放逐投票'}】你是 ${me.seat} 号 ${me.name}，身份「${ROLES[me.role].name}」。`,
    privateFacts(state, me),
    pk ? `平票的是：${seatList(alive)}；你只能从这几个人里选一个（也可以弃票），投别人算弃票。` : `可以投的人：${seatList(alive)}`,
    '',
    '【已经公开发生的事】',
    publicLogText(state, 40),
    '',
    '只输出一行：投票：<编号>号（或 投票：弃票）。不要解释。',
  ].join('\n');
}

/**
 * 遗言提示词。
 *
 * **不带死因**（叙述与引擎判定分离）：`player.deadReason` 只留在 state 里，给"猎人能不能
 * 开枪""局末复盘"这类引擎判定用，绝不进这段提示词。原因见 docs/ARCHITECTURE.md 5.9：
 * 遗言是**公开发言**，而法官公告是"只公布谁出局、不公布死因"—— 早先这里写着
 * "你刚因为「女巫毒杀」出局了"，模型就会在遗言里顺口说"我是被毒的"，等于替女巫
 * 宣布毒药已经用掉、解药已经出手（线上实测：首夜双死时两个死者都把死因说了出去）。
 * 所以这里只告诉当事人"你出局了"，并用下面那条明令禁止它自己编一个死因。
 */
export function lastWordsPromptFor(state, me) {
  return [
    `【狼人杀 · 遗言】你是 ${me.seat} 号 ${me.name}，身份「${ROLES[me.role].name}」，你刚刚出局了。`,
    privateFacts(state, me),
    `存活玩家：${seatList(aliveOf(state))}`,
    '',
    '【已经公开发生的事】',
    publicLogText(state, 30),
    '',
    teamRuleFor(me),
    '',
    '· 死因是谜：法官只公布"谁出局"、不公布死因，**场上没有人知道你是怎么死的**（你自己也一样）。' +
      '所以别说"我是被刀 / 被毒 / 被打死的"，也别替法官编一个死因出去——聊身份、查验结果、狼坑、怀疑对象就好。',
    me.team === TEAM_WOLF
      ? '说一句遗言（1~2 句）：**绝对不能承认自己是狼**，也**绝对不能把狼同伴说成狼**。' +
        '装作被冤枉的好人，或者悍跳预言家报个假查验——但那个"查杀"要落在好人身上（指认已经出局的好人最安全），绝不能指向同伴；也可以反咬一口，让好人继续互相怀疑。'
      : '说一句遗言（1~2 句）：可以公布身份与关键信息（查验结果 / 狼坑 / 怀疑对象），帮好人缩小范围。',
    '不要写旁白。',
  ].join('\n');
}

/* ================================================================== *
 * 4. 解析：从模型回复里抠出「编号」
 * ================================================================== */

/**
 * 从一段文本里解析座位号
 * @param {string} text
 * @param {number[]} allowedSeats 允许的座位号
 * @param {Array<{seat:number,name:string}>} [players] 传了就同时支持"投票：林晚"这种按名字投
 * @returns {number|null}
 */
export function parseSeat(text, allowedSeats, players) {
  const t = String(text || '');
  const allow = (allowedSeats || []).map(Number);
  const pick = (n) => (allow.includes(Number(n)) ? Number(n) : null);
  // 1) 明确的「投票：3号」「刀杀：5号」这类带标签的
  const tagged = t.match(/(?:投票|投|刀杀|刀|查验|查|毒药|毒|开枪|带走|守|目标)\s*[:：]?\s*(\d{1,2})\s*号/);
  if (tagged) {
    const v = pick(tagged[1]);
    if (v) return v;
  }
  // 2) 任意「N号」
  for (const m of t.matchAll(/(\d{1,2})\s*号/g)) {
    const v = pick(m[1]);
    if (v) return v;
  }
  // 2.5)「投票：3」这种省掉"号"的写法（只在短文本里认，避免从长句里乱抓数字）
  if (t.trim().length <= 12) {
    const bare = t.match(/(?:投票|投给|投|票)\s*[:：]?\s*(\d{1,2})/);
    if (bare) {
      const v = pick(bare[1]);
      if (v) return v;
    }
  }
  // 3) 纯数字（模型只回一个数字的情况）
  const only = t.trim().match(/^(\d{1,2})$/);
  if (only) {
    const v = pick(only[1]);
    if (v) return v;
  }
  // 4) 按名字投（「投票：林晚」）—— 长名字优先，避免"小满"被"满"之类的短名抢先命中
  const named = (Array.isArray(players) ? players : [])
    .filter((p) => p && p.name && allow.includes(Number(p.seat)))
    .sort((a, b) => String(b.name).length - String(a.name).length);
  for (const p of named) {
    if (t.includes(String(p.name))) return Number(p.seat);
  }
  return null;
}

/** 文本里是否表示"不用药 / 弃票 / 跳过" */
export function parseDecline(text) {
  return /(不用药|不使用|不救|不毒|弃票|弃权|跳过|放弃|不投票)/.test(String(text || ''));
}

/**
 * 从女巫的回复里解析"毒谁"——**只认明确写出座位的指令**。
 * 接受「毒药：5号」「毒药:5」「毒 5 号」「毒杀 5 号」「毒5号」；否定式（「不毒 3 号」）与
 * 只提数字的闲聊（「我觉得 2 号有问题，用毒风险太大」）都不算。
 * 为什么这么严：早先用 parseSeat() 抓回复里任意「N 号」，上面那句闲聊会被判成"毒 2 号"，
 * 毒药白烧还毒错人；宁可保守（不动手）也不要误伤。
 * @param {string} text
 * @param {number[]} [allowedSeats] 合法目标座位（不传则不校验）
 * @returns {number|null}
 */
export function parsePoisonOrder(text, allowedSeats) {
  const t = String(text || '');
  if (!t) return null;
  const allowed = new Set((Array.isArray(allowedSeats) ? allowedSeats : []).map(Number));
  const re = /(不|别|无需|不用|放弃|算了)?\s*毒(?:药|杀)?\s*(?:[:：]\s*)?(\d{1,2})\s*号?/g;
  let found = null;
  for (const m of t.matchAll(re)) {
    if (m[1]) continue; // 否定式："不毒 3 号"
    const seat = Number(m[2]);
    if (!seat) continue;
    if (allowed.size && !allowed.has(seat)) continue;
    found = seat; // 出现多处时以最后一次为准（模型通常最后才下结论）
  }
  return found;
}

/**
 * 从发言里拆出「发言正文」和「投票座位」
 * @param {string} text
 * @param {number[]} allowedSeats
 * @returns {{speech:string, vote:number|null, abstain:boolean}}
 */
export function splitSpeechAndVote(text, allowedSeats, players) {
  const raw = String(text || '').trim();
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let vote = null;
  let abstain = false;
  const speechLines = [];

  /** 整行就是一张票：投票：3号 / 投3号 / 我投 3 号 / 票3号 / 3号 / 弃票 */
  const voteOnly = /^\s*(?:我)?(?:的)?\s*(?:投票|投给|投|票)\s*[:：]?\s*(?:弃票|弃权|放弃|不投票|\d{1,2}\s*号?)\s*$/;
  /** 整行只有一个"N号"（用户懒得写"投票"两字） */
  const bareSeat = /^\s*\d{1,2}\s*号\s*$/;
  /** 整行只写了弃票类字样（弃票 / 弃权 / 放弃 / 跳过 / 不投票） */
  const abstainOnly = /^\s*(?:我)?\s*(?:弃票|弃权|放弃|跳过|不投票)\s*$/;

  for (const line of lines) {
    if (abstainOnly.test(line)) {
      abstain = true;
      continue;
    }
    if (voteOnly.test(line) || bareSeat.test(line)) {
      if (parseDecline(line)) abstain = true;
      else vote = parseSeat(line, allowedSeats, players);
      continue;
    }
    // 兼容"发言里直接带上投票"（同一个句子里 / 同一行里都能认出来）
    const inline = line.match(/(?:我的)?投票\s*[:：]\s*(.+)$/);
    if (inline) {
      if (parseDecline(inline[1])) abstain = true;
      else vote = parseSeat(inline[1], allowedSeats, players);
      const remain = line.slice(0, inline.index).trim();
      if (remain) speechLines.push(remain);
      continue;
    }
    speechLines.push(line);
  }
  return { speech: speechLines.join('\n').trim() || (vote !== null || abstain ? '' : raw), vote, abstain };
}

/**
 * 发言的「即时预览」：把（可能只吐了一半的）模型原文裁成**能直接显示给人看的正文**。
 *
 * 为什么需要它：白天发言要求模型"说完之后再另起一行写 投票：<编号>号"（见 dayPromptFor），
 * 而真正落进群聊的只有 splitSpeechAndVote() 拆出来的 speech 部分。流式预览如果把原文
 * 直接画到气泡上，你会先看到"投票：3号"这行格式，随后它又消失 —— 看着像跳字。
 *
 * 规则与 splitSpeechAndVote 一致，只有一处更宽容：**最后一行**如果正写到
 * "投票：3" 这种半截状态，也先不显示（等它写完），否则它会先冒出来再消失。
 * @param {string} raw 模型已经吐出来的原文
 * @returns {string} 可以直接显示的发言正文（还没有内容时返回空串）
 */
export function liveSpeechPreview(raw) {
  const text = String(raw || '');
  if (!text) return '';
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    // 整行只有"弃票 / 弃权 / 放弃"：这是一张票，不是发言
    if (/^(?:我)?\s*(?:弃票|弃权|放弃|跳过|不投票)$/.test(line)) continue;
    // 整行就是一张票：投票：3号 / 投3号 / 票：3 / 3号 / 弃票
    if (/^\s*(?:我)?(?:的)?\s*(?:投票|投给|投|票)\s*[:：]?\s*(?:弃票|弃权|放弃|不投票|\d{1,2}\s*号?)\s*$/.test(line)) continue;
    if (/^\s*\d{1,2}\s*号\s*$/.test(line)) continue;
    // 票写在句子末尾（"…，我的投票：3号"）：只留前半句，与 splitSpeechAndVote 一致
    const inline = line.match(/(?:我的)?投票\s*[:：]\s*(.+)$/);
    if (inline) {
      const remain = line.slice(0, inline.index).trim();
      if (remain) out.push(remain);
      continue;
    }
    // 最后一行可能正写到一半（"投票：3" / "投"）：先不显示，等它写完
    if (isLast) {
      if (/^\s*(?:我)?(?:的)?\s*(?:投票|投给|投|票)\s*[:：]?\s*\d{0,2}\s*号?\s*$/.test(line)) continue;
      // 同一件事也可能接在句子尾巴上（"…我投 TA。投票：5"）：把没写完的那截切掉。
      // 必须以句读符号开头才算数，否则"我投 5 号吧"这种正常句子会被误切。
      const tail = line.match(/^(.*[。！？!?，,；;、])\s*(?:我的|我)?\s*投(?:票|给)?\s*[:：]?\s*\d{0,2}\s*号?\s*$/);
      if (tail) {
        const remain = tail[1].trim();
        if (remain) out.push(remain);
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * 这段文本需不需要标"没说完"（结尾补一个"……"）。**判据只有一处**，两个调用方共用：
 *   · 上游因 `max_tokens` 用尽而截断（`finish_reason=length`，见 askLLM）；
 *   · 看门狗把一次"不说话"的调用掐断时，已经吐出来的那半句（同样不能说成"说完了"）。
 *
 * 判据是"**以汉字收尾**"：正常说完的话收在句读上（"…我记着。"），
 * 也可能收在表情上（实测有角色以"且尽此杯。🍶"收尾），这些都不该被画蛇添足。
 * 唯一的例外是结尾本身就是一行**完整指令**（"投票：3号 / 刀杀：5号"）——
 * 指令解析只认关键词与座位号，尾巴上多一个省略号既帮不上忙也不该出现。
 * @param {string} text
 * @returns {boolean}
 */
export function needsUnfinishedMark(text) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!t) return false;
  if (!/[\u3400-\u9fff]$/.test(t)) return false;
  const last = t.split('\n').pop().trim();
  return !/^(?:我)?(?:的)?\s*(?:投票|投给|投|票|刀杀|刀|查验|查|毒药|毒|开枪|带走|守)\s*[:：]?\s*(?:弃票|弃权|放弃|不投票|\d{1,2}\s*号?)$/.test(
    last
  );
}

/**
 * 给"被 token 上限截断 / 被掐断"的半句话补一个省略号尾巴。
 *
 * 为什么要补：模型被 max_tokens 切断时正文会停在半个词上（"…4 号、5 号互相开了一枪，枪口"），
 * 落进群聊后与"说完了"长得一模一样，玩家只能自己猜是不是卡住了。补一个"……"是最低成本的提示。
 * @param {string} text
 * @returns {string}
 */
export function markTruncatedTail(text) {
  const t = String(text || '').replace(/\s+$/, '');
  return needsUnfinishedMark(t) ? `${t}……` : t;
}

/* ================================================================== *
 * 5. 存档（localStorage，按群隔离）
 * ================================================================== */

const KEY_PREFIX = 'aichat.werewolf.';

function storageKey(groupId) {
  return `${KEY_PREFIX}${String(groupId || '')}`;
}

/** 保存对局状态（失败静默：隐私模式下写不了就算了） */
export function saveGame(state) {
  if (!state || !state.groupId) return;
  try {
    // privLog 不落盘：它是"所有玩家各自的私密提示"混在一个数组里（谁验到谁、女巫救了谁…），
    // 存进 localStorage 等于把全场私密信息写一份到磁盘上。它是给界面/测试看的即时记录，
    // 刷新续玩并不需要它（🔒 提示是一次性的），所以只在内存里留。
    const { privLog, ...rest } = state;
    localStorage.setItem(storageKey(state.groupId), JSON.stringify(rest));
  } catch {
    /* 忽略 */
  }
}

/** 读取对局状态（没有返回 null） */
export function loadGame(groupId) {
  try {
    const raw = localStorage.getItem(storageKey(groupId));
    if (!raw) return null;
    const st = JSON.parse(raw);
    if (!st || !st.groupId) return null;
    // 旧格式存档归一化（这一版才有 night.no / night.finished）：
    // 存档落在"夜里"→ 认定当前这一夜还没跑完（续玩时接上，不重置天数）；
    // 存档落在天亮/白天/投票/已结束 → 认定那一夜已经跑完，否则下一夜会被误判成"重入"而永不 +1 天。
    if (st.night && st.night.started === undefined) {
      st.night.no = Number(st.day) || 0;
      // 存档落在"夜里"→ 这一夜已经开始但没跑完；落在天亮/白天/投票/已结束 → 已跑完
      st.night.started = st.phase === 'night';
      st.night.finished = st.phase !== 'night';
    }
    // 旧存档没有 voteOpen / voteResult（"盲投"是这一版才有的）：
    //   · 落在投票阶段 → 认定还在收票：voteLive 里是没投完的票，继续藏着，等本轮结算；
    //   · 其他阶段 → voteLive 是上一轮**已公告**的票数（进夜清零，见 phaseNight），接过来当"投票结果"。
    //     注意快速模式的白天也在收票（投票夹在发言里），所以那种存档同样按"收票中"算。
    if (st.voteOpen === undefined) st.voteOpen = st.phase === 'vote' || (st.fastMode === true && st.phase === 'day');
    if (st.voteResult === undefined) {
      const t = st.voteLive && typeof st.voteLive === 'object' ? st.voteLive : null;
      st.voteResult = !st.voteOpen && t && Object.keys(t).length
        ? { day: Number(st.day) || 0, round: Number(st.voteRound) || 0, tally: t }
        : null;
    }
    return st;
  } catch {
    return null;
  }
}

/** 清掉所有群的对局存档（"清空全部数据"/导入前调用；按群删走 clearGame） */
export function clearAllGames() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
    return keys.length;
  } catch {
    return 0;
  }
}

/** 清掉存档（退出模式时调用） */
export function clearGame(groupId) {
  try {
    localStorage.removeItem(storageKey(groupId));
  } catch {
    /* 忽略 */
  }
}

/** 这个群现在是不是正在玩狼人杀（群聊界面用它做冲突保护） */
export function isActive(groupId) {
  const st = loadGame(groupId);
  return Boolean(st && !st.over);
}

/* ================================================================== *
 * 6. 一整局：WerewolfGame
 * ------------------------------------------------------------------
 * 结构与 core/group.js 的 GroupRound 保持一致（handlers 吐事件、引擎不碰 DOM），
 * 但完全不共用它的选人/提示词逻辑，避免和普通群聊互相影响。
 * ================================================================== */

/** 人类玩家的固定 id（与群聊里"我方消息"的 speakerId 约定一致） */
export const USER_ID = 'user';

/** 每次模型调用之间的最小间隔，给界面留出"正在发生"的观感 */
const STEP_GAP = 420;

/**
 * 单次模型调用的"多久没吐出新内容就掐断"上限。没有它的话：中转站/供应商偶尔会挂住不返回，
 * 引擎就永久 await 在那儿 —— 表现就是"投票到一半整局卡死、再也不动"（玩家以为死循环）。
 *
 * 为什么必须引擎自己管，而不能指望 core/llm.js 的空闲看门狗：那个看门狗**收到任何字节都会重置**，
 * 而 `readSSE` 明确把 SSE 心跳（`: ping`）当"无内容"忽略 —— 于是只要有中转站/网关周期性发心跳，
 * 看门狗就被无限重置，调用永远不返回也永远不报错。实测：静默流 1.5 秒被掐断，
 * 心跳流（每 300ms 一个心跳）6 秒后仍挂起。所以这里按"**有没有新内容**"计时。
 *
 * 注意计时是**收到内容就重置**（而不是整次调用的总时长）：本地大模型首字慢、吐字也慢是正常的，
 * 总时长硬上限会把"正在正常生成"的发言误杀成"这次没回应"。
 * 超时按"这一次没回应"处理，各处的兜底会接手（狼随机刀、票算弃票、发言记为没有发言）。
 */
const ASK_TIMEOUT_MS = 60000;

/**
 * 连续没回应之后改用的短等待：供应商真的挂了时，没必要每个座位都干等 60 秒。
 * 连续 {@link ASK_STALL_AFTER} 次没有任何内容返回就切换，任意一次正常返回立刻恢复。
 */
const ASK_STALL_MS = 15000;

/** 连续几次"完全没回应"就切到 ASK_STALL_MS（一次偶发空回复不至于降级） */
const ASK_STALL_AFTER = 2;

/**
 * 等你（真人）操作的硬上限。
 *
 * 为什么必须有：`askHuman` 是全项目唯一"没有任何超时兜底"的等待 —— 界面那边只有
 * "你点了按钮"或"结束整局"两个 resolve 出口（ui/werewolf.js 的 3 分钟计时器只弹提醒）。
 * 轮到你投票/发言/开枪时切走页面或关掉面板，引擎会永久 await、整局停死。
 * 默认给足 5 分钟（真人有事走开也来得及），超时按"放弃这次操作"处理：
 * 投票=弃票、发言=跳过、开枪=放弃，整局能继续走下去。
 */
const HUMAN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 投票阶段的总预算：一张票一次调用，人多的局串行下来可能十几分钟。
 * 超过预算就把还没投的按弃票算，保证"投票一定会结束"（否则一张卡住的票就拖死整局）。
 */
const VOTE_PHASE_BUDGET_MS = 5 * 60 * 1000;

export class WerewolfGame {
  /**
   * @param {{
   *   group: object, members: object[], settings?: object, userName?: string,
   *   human?: object, handlers?: object, fastMode?: boolean, state?: object
   * }} opts
   *   human：把"你自己"的决策交给界面（夜间行动/投票/发言），返回 null 表示跳过。
   *   handlers（引擎只会调这 7 个，UI 侧见 ui/werewolf.js）：
   *     onJudge(line, state) / onSpeech(player, text) / onPrivate(player, text) /
   *     onState(state) / onEnd({ winner, state }) / onWarn(text) / onError(err)
   *   注意 onPrivate 是**私密**通道（🔒，只给本人看），别和走群消息的 onJudge 混用 —— 见 docs/ARCHITECTURE.md 5.9。
   */
  constructor(opts = {}) {
    this.group = opts.group || null;
    this.members = (Array.isArray(opts.members) ? opts.members : []).filter((m) => m && m.id);
    this.settings = opts.settings || {};
    this.userName = opts.userName || '我';
    this.human = opts.human || {};
    this.handlers = opts.handlers || {};
    this.fastMode = opts.fastMode !== false;
    /** 每位角色的记忆缓存（避免每轮都读库） */
    this.memCache = new Map();
    /** 角色卡索引：座位/id → 角色对象（人设提示词用） */
    this.charByPlayerId = new Map();
    for (const m of this.members) this.charByPlayerId.set(String(m.id), m);
    this.charByPlayerId.set(USER_ID, null);

    /** 单次模型调用超时 / 投票阶段总预算（测试可调小） */
    this.askTimeoutMs = num(opts.askTimeoutMs, ASK_TIMEOUT_MS) || ASK_TIMEOUT_MS;
    this.voteBudgetMs = num(opts.voteBudgetMs, VOTE_PHASE_BUDGET_MS) || VOTE_PHASE_BUDGET_MS;
    /** 连续没回应时的短等待（默认 15 秒，测试可调小） */
    this.askStallMs = num(opts.askStallMs, ASK_STALL_MS) || ASK_STALL_MS;
    /** 连续几次"完全没回应"（跨调用累计，任意一次正常返回清零） */
    this.missStreak = 0;
    /** 已经提示过"模型没回应、改用短等待"，避免每个座位都弹一次 */
    this.stallWarned = false;
    this.paused = false;
    this.stopped = false;
    this.reason = '';
    this.controller = null;
    this.state = opts.state || this.createState();
  }

  /* ---------------- 状态 ---------------- */

  createState() {
    // 座位表每局重洗：以前是"群成员按入群顺序 + 你固定最后一号"，于是你永远是 9 号（9 人局）、
    // 发言顺序也永远从同一个人开始。现在先洗座位再发牌，你可能坐在 1~N 任意一个位置上。
    // 座位号 = 洗牌后的下标 + 1（见 assignRoles），所以 players 数组本身就是**按座位升序**的，
    // "第 N 天按座位顺序依次发言"那套循环不用改。角色牌另外洗一次（assignRoles 里的 cards），
    // 两件事互相独立：座位随机 ≠ 身份随机，这里两个都要。
    const players = shuffled([
      ...this.members.map((m) => ({ id: String(m.id), name: String(m.name || '成员'), model: m.model })),
      { id: USER_ID, name: this.userName, isUser: true },
    ]);
    const board = boardFor(players.length);
    if (!board) throw new Error(`狼人杀需要 ${MIN_PLAYERS}~${MAX_PLAYERS} 名玩家（群成员 + 你），当前只有 ${players.length} 名`);
    const dealt = assignRoles(players, board);
    const state = {
      version: 1,
      gameId: createId('game'),
      groupId: String((this.group && this.group.id) || ''),
      groupName: String((this.group && this.group.name) || '群聊'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      over: false,
      winner: '',
      phase: 'setup',
      day: 0,
      players: dealt,
      board: { players: board.players, wolf: board.wolf, villager: board.villager, gods: board.gods, witchAntidoteOnly: board.witchAntidoteOnly },
      fastMode: this.fastMode,
      witch: { antidote: true, poison: !board.witchAntidoteOnly },
      seerChecks: [],
      // no: 0 = 还没进入任何一夜（phaseNight 会把它设成 night.no = 当前天数）。
      // 不能留空对象：续玩判据会把"已存在但没跑完的 night"当作当前这一夜，
      // 空对象会让首夜被误判成"重入"，于是天数永远从 0 开始。
      night: { no: 0 },
      lastNightDeaths: [],
      /**
       * 本轮**实时**票数：{ 座位号: 票数 }。
       * 收票期间它是"还没投完的内部计数"，**不对外公开**（界面一律走 publicVoteTally），
       * 投票结束那一刻的最终票数会被写进 voteResult 再公开。
       */
      voteLive: {},
      /** 本轮是否正在收票：为 true 时票数一律不公开（界面只写"投票中"） */
      voteOpen: false,
      /** 本轮**已公开**的投票结果：{ day, round, tally }（结算后才写，见 publishVoteResult） */
      voteResult: null,
      /** 本轮的投票明细（诊断/结算用，界面不显示"谁投了谁"） */
      lastBallots: [],
      voteRound: 0,
      log: [],
      pending: null,
      userSeat: (dealt.find((p) => p.isUser) || {}).seat || 0,
      userRole: (dealt.find((p) => p.isUser) || {}).role || '',
    };
    // 6 人局女巫只有解药：规则文件「4.1 通用配置表」备注
    if (board.witchAntidoteOnly) state.witch.poison = false;
    return state;
  }

  save() {
    this.state.updatedAt = Date.now();
    // 已经停止的对局不再写存档：否则界面 clearGame() 之后，
    // 还在收尾的异步流程（比如 askHuman 返回、法官公告落库）会把存档又写回来，
    // 表现为"结束了但模式还在"。
    if (!this.stopped) saveGame(this.state);
    this.emitState();
  }

  emitState() {
    if (typeof this.handlers.onState === 'function') {
      try {
        this.handlers.onState(this.state);
      } catch {
        /* 界面回调异常不影响游戏 */
      }
    }
  }

  /* ---------------- 对外控制 ---------------- */

  pause() {
    this.paused = true;
    this.emitState();
  }

  resume() {
    this.paused = false;
    this.emitState();
  }

  stop(reason = 'user') {
    this.stopped = true;
    if (!this.reason) this.reason = reason;
    try {
      if (this.controller) this.controller.abort();
    } catch {
      /* 忽略 */
    }
  }

  /* ---------------- 主循环 ---------------- */

  /** 一直推进到分出胜负 / 被停止 */
  async run() {
    if (this.state.over) return { winner: this.state.winner, turns: 0, reason: 'already-over' };
    /**
     * 安全网：任何"阶段原地打转"都会让整局永远跑不完（浏览器标签卡死、CDP 全线超时）。
     * 曾经因为续玩标记写错，出现过 night→dawn→day→vote 的无限循环。
     * 这里用滑动窗口检测重复的阶段，命中就强制推进一次（把当前这一夜标记为已跑完），
     * 并写进 debug —— 宁可推进得粗糙一点，也不能把页面卡死。
     */
    const recent = [];
    const repeated = (key) => {
      recent.push(key);
      if (recent.length > 8) recent.shift();
      return recent.filter((k) => k === key).length >= 3;
    };
    try {
      while (!this.stopped && !this.state.over) {
        await this.gate();
        if (this.stopped || this.state.over) break;
        const key = `${this.state.phase}#${this.state.day}`;
        if (repeated(key)) {
          this.debug(`⚠️ 检测到阶段原地打转（${key}），已强制推进一次以免卡死`);
          if (this.state.night) this.state.night.finished = true;
          recent.length = 0;
        }
        await this.step();
      }
    } catch (err) {
      this.stop('error');
      this.log(`⚠️ 游戏异常中断：${(err && err.message) || err}`);
      if (typeof this.handlers.onError === 'function') {
        try {
          this.handlers.onError(err);
        } catch {
          /* 忽略 */
        }
      }
    }
    return { winner: this.state.winner, turns: this.state.day, reason: this.stopped ? this.reason || 'user' : 'done' };
  }

  /** 暂停闸门：暂停时在这里等着（界面点"继续"就放行） */
  /**
   * 暂停闸门：暂停期间在这里等着，恢复后继续。
   * @returns {Promise<number>} 这次一共"因为暂停"等了多久（毫秒）。没有暂停就是 0。
   *   投票阶段会把它加回截止时间 —— 玩家按暂停去干别的，不该把投票预算耗光
   *   （以前不还：暂停 5 分钟以上再恢复，这一轮会把还没投的人全按弃票算）。
   */
  async gate() {
    const t0 = Date.now();
    while (this.paused && !this.stopped) await sleep(160);
    return Date.now() - t0;
  }

  /** 按当前阶段推进一格 */
  async step() {
    const phase = this.state.phase;
    if (phase === 'setup') return this.phaseSetup();
    if (phase === 'night') return this.phaseNight();
    if (phase === 'dawn') return this.phaseDawn();
    if (phase === 'day') return this.phaseDay();
    if (phase === 'vote') return this.phaseVote();
    if (phase === 'ended') return this.phaseEnd();
    // 未知阶段：直接结束，避免死循环
    this.state.phase = 'ended';
    return undefined;
  }

  /* ---------------- 各阶段 ---------------- */

  async phaseSetup() {
    const s = this.state;
    await this.say(
      `【法官】狼人杀开始！本局 ${s.players.length} 人：${boardLabel(boardFor(s.board.players))}。` +
        `规则为「屠边」——狼人杀光全部神职或全部平民即获胜，好人放逐/毒杀/枪杀所有狼人即获胜。` +
        `女巫不能自救、同一晚不能双药${s.board.witchAntidoteOnly ? '，本局女巫只有一瓶解药' : ''}。`
    );
    const user = s.players.find((p) => p.isUser);
    if (user) {
      // 公开部分只说"身份已发下"，**绝不报是谁的什么身份**：公开记录会被拼进所有角色的提示词
      // （见 askLLM 里白天发言/遗言的 dayPromptFor → publicLogText），写成群消息等于当众宣布
      // "9 号是猎人"——狼人会照着屠边目标去刀，AI 还会被"你自己"三个字绕晕（它的提示词开头
      // 写着它是 4 号狼人）。这与 ui/werewolf.js 顶部的信息边界约定一致：
      // 你的身份只画在 HUD/面板（本地 DOM，不进消息、模型看不到）。
      await this.say('【法官】身份已发到每个人手里（只有本人知道）。');
      // 本人的身份走私有通道（UI 上是 🔒 提示，只有本人看得到）；是狼的话把狼同伴一并给他，
      // 保证"狼队友之间互相能看到身份"（AI 狼看同伴走 privateFacts，玩家看这条 + HUD）
      const mates = user.team === TEAM_WOLF ? humanMatesText(s.players.filter((p) => p.team === TEAM_WOLF)) : '';
      this.priv(user, `你的身份是「${ROLES[user.role].name}」${mates ? `；你的狼同伴：${mates}` : ''}`);
    }
    await this.sleepGap();
    s.phase = 'night';
    this.save();
  }

  async phaseNight() {
    const s = this.state;
    // 已经被"结束"停掉就别再往下跑：早先夜里点结束，当夜剩余的模型调用与法官公告照旧跑完、
    // 还会继续往群里写消息（玩家看到"人都走了法官还在报幕"）。
    if (this.stopped) return;
    /**
     * 断点续玩（刷新恢复）：这一夜已经"进入过**且还没结算完**"时，不能再 +1 天、不能再清空 night
     * —— 否则夜里刷新一次：天数 +1、已经定下的刀口被抹掉、已耗的药品不返还、预言家还多查一次。
     *
     * ⚠️ 判据必须带 `finished`：一夜跑完后 `day` 还没 +1，只看"night 存在"会把"下一夜"
     * 误判成"这一夜的重入"，于是天数永远不增 —— night→dawn→day→vote 无限循环（踩过一次）。
     *   · 夜里刷新：finished 不为 true → 重入，补齐没做的子步骤
     *   · 天亮/白天/投票阶段刷新：finished === true → 下一夜照常 +1 天
     * 判据只用 phaseNight 自己写的两个标记：`started`（这一夜已经进入过）与
     * `finished`（这一夜已经跑完）。空 night（`{}` / `createState` 的 `{no:0}`）、
     * 手工构造的 night 都算"还没进入这一夜"，于是照常 +1 天并清上一轮票数；
     * 旧存档在 loadGame() 里按 phase 补这两个标记。
     */
    const reentering = Boolean(s.night && s.night.started === true && s.night.finished !== true);
    if (!reentering) {
      s.day += 1;
      s.night = { no: s.day, started: true };
      s.lastNightDeaths = [];
      s.voteRound = 0;
      // 新一轮开始：清掉上一轮的票数（实时票数 / 投票明细 / 快速模式的票 / 今日已发言座位）
      s.voteLive = {};
      s.lastBallots = [];
      // 上一轮**已公布的投票结果**也一并撤下：夜里 HUD 不挂"上一轮票数"
      // （那份结果已经进了法官公告与聊天记录，挂在 HUD 上只会被误读成跟当前行动有关）
      s.voteOpen = false;
      s.voteResult = null;
      s.fastVotes = [];
      s.voteBallots = [];
      s.voteBallotsDay = 0;
      s.spokenDay = 0;
      s.spokenSeats = [];
      await this.say(`【法官】第 ${s.day} 夜，天黑请闭眼。`);
      this.save();
    }

    const alive = aliveOf(s);
    /* --- 1) 狼人刀人 --- */
    const wolves = alive.filter((p) => p.team === TEAM_WOLF);
    if (wolves.length && !s.night.wolfDone) {
      await this.gate();          // 夜里点"暂停"也要停住，否则模型调用照旧跑完（用户以为按钮坏了）
      if (this.stopped) return;
      // 规则文件：狼人每晚刀杀一人，**可以自刀**（也就可以刀同伴）——所以候选是全部存活玩家
      const candidates = alive.slice();
      let seat = null;
      const humanWolf = wolves.find((p) => p.isUser);
      if (humanWolf) {
        // 你也是狼：由你在界面上定刀，AI 同伴不再单独发言（省一次调用，且你说了算）
        const r = await this.askHuman('wolf', {
          me: humanWolf,
          options: candidates,
          hint: `你是狼人，今晚要刀谁？（可以刀任何人，包括同伴或你自己）同伴：${humanMatesText(wolves) || '无'}`,
        });
        // 你放弃指定目标 → 今晚不刀人（平安夜）。规则上狼人每晚必须刀一人，
        // 所以界面上那个"不刀人"按钮会先弹一次确认（见 ui/werewolf.js 的 renderAction），
        // 避免误点白白送掉一刀；引擎侧保持"给什么用什么"，不再偷偷替你选目标。
        seat = r && r.seat ? Number(r.seat) : null;
      } else {
        const speaker = wolves[0];
        const text = await this.askLLM(speaker, nightPromptFor(s, speaker, 'wolf'), 'night');
        seat = parseSeat(text, candidates.map((p) => p.seat));
        if (!seat) seat = pickRandom(candidates) ? pickRandom(candidates).seat : null;
      }
      s.night.wolfTargetSeat = seat;
      s.night.wolfTargetId = seat ? (bySeat(s, seat) || {}).id || null : null;
      s.night.wolfDone = true;
    }

    /* --- 2) 女巫 --- */
    let witchExtra = '';
    const witch = alive.find((p) => p.role === 'witch');
    if (witch && !s.night.witchDone) {
      await this.gate();
      if (this.stopped) return;
      const target = s.night.wolfTargetSeat ? bySeat(s, s.night.wolfTargetSeat) : null;
      const canSave = s.witch.antidote && target && target.id !== witch.id; // 不能自救
      const canPoison = s.witch.poison;
      if (canSave || canPoison) {
        const choices = [canSave ? '解药：救' : '', canPoison ? '毒药：<编号>号' : '', '不用药'].filter(Boolean);
        // ⚠️ 这三种情况的措辞必须分开写，不能拼成一句：
        //   · 今晚没人被刀（狼人这轮没选出目标）→ 原来会串成"今晚被刀的是：（今晚没有人被刀）"，
        //     而且紧跟着的括注会说"解药已用完"——药明明还在，只是没人可救，会误导女巫。
        //   · 被刀的是女巫自己 → 是"不能自救"，不是"药没了"。
        //   · 解药真的用完了 → 才说"解药已用完"。
        const noPoisonWhy = s.board.witchAntidoteOnly ? '本局你没有毒药' : '毒药已用完';
        if (!target) {
          witchExtra =
            '今晚没有人被刀。' +
            (canPoison ? '你可以用毒药毒死一人。' : '你今晚没有可以用药的对象。') +
            `只输出一行，从下面这些里选一种：${choices.join(' ／ ')}`;
        } else {
          const saveLine = canSave
            ? '。你可以用解药救 TA'
            : s.witch.antidote
              ? '（被刀的是你自己，你不能自救）'
              : '（解药已用完）';
          witchExtra =
            `今晚被刀的是：${target.seat} 号 ${target.name}` +
            saveLine +
            (canPoison ? '；你也可以用毒药毒死一人' : canSave ? '' : `，${noPoisonWhy}`) +
            `。只输出一行，从下面这些里选一种：${choices.join(' ／ ')}`;
        }
        if (witch.isUser) {
          const r = await this.askHuman('witch', { me: witch, options: alive.filter((p) => p.id !== witch.id), hint: witchExtra, canSave, canPoison, target });
          if (r && r.save && canSave) {
            s.night.savedSeat = target.seat;
            s.witch.antidote = false;
            this.priv(witch, `你用解药救了 ${target.seat} 号 ${target.name}`);
          } else if (r && r.poison) {
            s.night.poisonSeat = Number(r.poison);
            s.witch.poison = false;
            const pt = bySeat(s, s.night.poisonSeat);
            this.priv(witch, `你在 ${s.night.poisonSeat} 号 ${pt ? pt.name : ''} 身上用了毒药`);
          }
        } else {
          const text = await this.askLLM(witch, nightPromptFor(s, witch, 'witch', witchExtra), 'night');
          if (canSave && /解药|救/.test(text) && !/毒/.test(text)) {
            s.night.savedSeat = target.seat;
            s.witch.antidote = false;
            this.priv(witch, `你用解药救了 ${target.seat} 号 ${target.name}`);
          } else if (canPoison) {
            // 毒药必须有**明确指令**才算数：只认「毒药：5号 / 毒 5 号 / 毒杀 5 号」这种带座位的写法。
            // 早先用 parseSeat(text) 抓回复里的任意「N 号」，于是"我觉得 2 号有问题，用毒风险太大"
            // 这类带数字的废话会被当成下毒，毒药白烧（而且毒错人）。
            const seat = parsePoisonOrder(text, alive.filter((p) => p.id !== witch.id).map((p) => p.seat));
            if (seat) {
              s.night.poisonSeat = seat;
              s.witch.poison = false;
              const pt = bySeat(s, seat);
              this.priv(witch, `你在 ${seat} 号 ${pt ? pt.name : ''} 身上用了毒药`);
            }
          }
        }
      }
      s.night.witchDone = true; // 无论她用药还是选择不用，这一夜的女巫环节就算做完了
    }

    /* --- 3) 预言家查验 --- */
    const seer = alive.find((p) => p.role === 'seer');
    if (seer && !s.night.seerDone) {
      await this.gate();
      if (this.stopped) return;
      const checked = new Set((s.seerChecks || []).map((c) => String(c.id)));
      const candidates = alive.filter((p) => p.id !== seer.id && !checked.has(String(p.id)));
      if (candidates.length) {
        let seat = null;
        if (seer.isUser) {
          const r = await this.askHuman('seer', { me: seer, options: candidates, hint: '你是预言家，今晚查验谁？' });
          seat = r && r.seat ? Number(r.seat) : null;
        } else {
          const text = await this.askLLM(seer, nightPromptFor(s, seer, 'seer'), 'night');
          seat = parseSeat(text, candidates.map((p) => p.seat));
        }
        if (!seat) {
          const pick = pickRandom(candidates);
          seat = pick ? pick.seat : null;
        }
        const target = seat ? bySeat(s, seat) : null;
        if (target) {
          s.seerChecks = [...(s.seerChecks || []), { id: target.id, seat: target.seat, name: target.name, result: target.team, day: s.day }];
          // 规则里法官会当场给预言家手势 —— 这里就是那个"手势"（只有预言家本人看得到）
          this.priv(seer, `查验结果：${target.seat} 号 ${target.name} 是「${target.team === TEAM_WOLF ? '狼人' : '好人'}」`);
        }
      }
      s.night.seerDone = true;
    }

    // 这一夜跑完了：打上标记，下一夜（day 还没 +1）才会被当作"新的夜"重新初始化
    s.night.finished = true;
    s.phase = 'dawn';
    this.save();
    await this.sleepGap();
  }

  async phaseDawn() {
    const s = this.state;
    if (this.stopped) return; // 同上：停了就别再结算/播报
    // 断点续玩：这一天已经结算过（出局/遗言/开枪都做完了，只是没来得及改 phase 或被刷新打断），
    // 就只把阶段推进到下一步，不重复播报、不重复结算。
    if (s.dawnResolvedDay === s.day) {
      const w = checkWinner(s);
      if (w) {
        s.winner = w;
        s.phase = 'ended';
      } else {
        s.phase = 'day';
      }
      this.save();
      return;
    }
    await this.gate();
    if (this.stopped) return;
    const deaths = [];
    const knifeSeat = s.night.wolfTargetSeat;
    const savedSeat = s.night.savedSeat;
    // 同守同救不适用（本实现没有守卫）；被救则不倒牌
    if (knifeSeat && knifeSeat !== savedSeat) {
      const p = bySeat(s, knifeSeat);
      if (p) deaths.push({ player: p, cause: '狼人刀杀' });
    }
    if (s.night.poisonSeat) {
      const p = bySeat(s, s.night.poisonSeat);
      if (p && !deaths.some((d) => d.player.id === p.id)) deaths.push({ player: p, cause: '女巫毒杀' });
    }

    await this.say(`【法官】第 ${s.day} 天天亮了。`);
    if (deaths.length) {
      const deadText = deaths.map((d) => d.player.seat + ' 号 ' + d.player.name).join('、');
      await this.say(`【法官】昨晚出局：${deadText}。（不公布死因）`);
    } else {
      await this.say('【法官】昨晚是平安夜，没有人出局。');
    }
    s.lastNightDeaths = deaths.map((d) => d.player.id);

    // 结算出局 + 遗言 + 猎人开枪（首夜有遗言；被毒死不能开枪）
    for (const d of deaths) await this.killPlayer(d.player, d.cause, { lastWords: s.day === 1, canShoot: d.cause !== '女巫毒杀' });
    s.dawnResolvedDay = s.day;

    const winner = checkWinner(s);
    if (winner) {
      s.winner = winner;
      s.phase = 'ended';
    } else {
      s.phase = 'day';
    }
    this.save();
    await this.sleepGap();
  }

  async phaseDay() {
    const s = this.state;
    const alive = aliveOf(s);
    // 断点续玩：同一天重进这一阶段时，只补做还没发过言的人（否则刷新一次全体重说一遍）
    if (s.spokenDay !== s.day) {
      s.spokenDay = s.day;
      s.spokenSeats = [];
      s.fastVotes = [];
      // 快速模式下投票是"夹在发言里"投的：从发言开始就已经在收票了，
      // 所以这一刻起票数就不公开（上一轮已公布的结果也撤下），见 publicVoteTally。
      if (s.fastMode) {
        s.voteOpen = true;
        s.voteResult = null;
        s.voteLive = {};
      }
      await this.say(`【法官】第 ${s.day} 天发言开始，按座位顺序依次发言。`);
    }
    const spoken = new Set((s.spokenSeats || []).map(Number));
    for (const p of alive) {
      if (this.stopped) return;
      await this.gate();
      if (!p.alive) continue;
      if (spoken.has(Number(p.seat))) continue; // 这个人今天已经说过了
      const text = await this.speakTurn(p, { withVote: s.fastMode });
      // 票落盘（快速模式下投票是"发言里带的"，刷新后不能丢，否则会退化成逐人重投）
      if (text && (text.speech || text.vote || text.abstain)) {
        s.fastVotes = [...(s.fastVotes || []), { seat: p.seat, vote: text.vote, abstain: text.abstain }];
        // 实时票数：只是引擎内部计数，**不推给界面**（收票期间票数不公开，见 publicVoteTally）
        s.voteLive = tallyVotes((s.fastVotes || []).map((v) => ({ seat: v.vote })));
      }
      spoken.add(Number(p.seat));
      s.spokenSeats = [...spoken];
      this.save();
    }
    if (s.fastMode) this.pendingVotes = (s.fastVotes || []).slice();
    s.phase = 'vote';
    this.save();
    await this.sleepGap();
  }

  async phaseVote() {
    const s = this.state;
    const alive = aliveOf(s);
    /** @type {Array<{voter:object, seat:number|null}>} */
    let ballots = [];
    // 断点续玩：这一天的投票记录落盘在 s.voteBallots，刷新后接着投，不重头再问一遍
    if (s.voteBallotsDay !== s.day) {
      s.voteBallotsDay = s.day;
      s.voteBallots = [];
    }
    const voted = new Set((s.voteBallots || []).map((b) => Number(b.voterSeat)));
    s.voteLive = {};
    s.lastBallots = [];
    /**
     * 收票开始：**从现在起票数不公开**（界面只写"投票中"，见 publicVoteTally），
     * 上一轮已公布的结果也一并撤下。投票是"一人一票、投完即定"的，
     * 中途亮出"谁现在几票"等于替还没投的人（尤其是你）做决定。
     */
    s.voteOpen = true;
    s.voteResult = null;
    /**
     * 投票阶段的预算截止时间。**普通投票与平票 PK 重投各拿一份**（每份都是 voteBudgetMs）：
     * 两段都是"一人一次调用串行"，所以都要有上限；但**不能共用一份** ——
     * 供应商只是慢（不是挂住）时，普通投票走完就可能把预算吃光，共用的话 PK 会在开始时就被掐掉，
     * 变成"该 PK 却没 PK"（这属于把好局判坏了，比慢一点更糟）。各一份则最坏也就两段各自有界。
     * 声明在 if/else 外面是因为 PK 那段要用它。
     */
    let voteDeadline = Date.now() + this.voteBudgetMs;
    /** 预算用尽而中断（用来把法官台词说得准确些：那是"等待超时"，不是大家主动弃票） */
    let budgetBroke = false;
    const fastVotes = Array.isArray(s.fastVotes) && s.fastVotes.length ? s.fastVotes : this.pendingVotes;
    if (s.fastMode && Array.isArray(fastVotes) && fastVotes.length) {
      for (const v of fastVotes) {
        const voter = bySeat(s, v.seat);
        if (voter && voter.alive && voter.canVote !== false) ballots.push({ voter, seat: v.vote || null });
      }
      s.voteLive = tallyVotes(ballots);
    } else {
      // 已有票先还原（刷新续玩）
      for (const b of s.voteBallots || []) {
        const voter = bySeat(s, b.voterSeat);
        if (voter) ballots.push({ voter, seat: b.seat == null ? null : Number(b.seat) });
      }
      if (!voted.size) await this.say(`【法官】请投票放逐一名玩家。`);
      for (const p of alive) {
        if (this.stopped) return;
        const pausedMs = await this.gate();
        if (pausedMs > 0) voteDeadline += pausedMs; // 暂停的时间不算进投票预算
        if (!p.alive || p.canVote === false) continue;
        if (voted.has(Number(p.seat))) continue; // 这一票已经投过了
        // 预算检查**不能**拦在你（真人）前面：上游只是慢、没挂的时候，
        // 前面几个 AI 座位就能把预算耗光，轮到你的座位时直接 break ——
        // 你从来没被问过，票却被算成弃票。真人这一票由 HUMAN_TIMEOUT_MS 兜底，
        // 所以这里让真人座位无条件排到预算之外先问完。
        if (!p.isUser && Date.now() > voteDeadline) {
          // 预算用尽（多半是某次模型调用卡住）：没投的按弃票算，先把这一轮结束掉
          budgetBroke = true;
          this.warn('投票等待超时：还没投的人按弃票算，本轮照常结算');
          break;
        }
        let seat = null;
        const others = alive.filter((x) => x.id !== p.id);
        if (p.isUser) {
          // 盲投：这里**不给** tally（界面上一个数字都不能出现），票数要等本轮结算后才公布
          const r = await this.askHuman('vote', {
            me: p,
            options: others,
            hint: '点一个按钮投票放逐（结果会在所有人投完后一起公布）',
          });
          seat = r && r.seat ? Number(r.seat) : null;
        } else {
          const text = await this.askLLM(p, votePromptFor(s, p), 'vote');
          seat = parseDecline(text) ? null : parseSeat(text, others.map((x) => x.seat));
        }
        ballots.push({ voter: p, seat });
        s.voteBallots = [...(s.voteBallots || []), { voterSeat: p.seat, seat }];
        s.voteLive = tallyVotes(ballots);
        this.save();
      }
    }
    // 记下明细（诊断用；界面只显示票数，不显示谁投了谁）
    s.lastBallots = ballots.map((b) => ({ voterSeat: b.voter.seat, seat: b.seat }));
    s.voteLive = tallyVotes(ballots);

    // 计票
    const tally = new Map();
    for (const b of ballots) {
      if (!b.seat) continue;
      tally.set(b.seat, (tally.get(b.seat) || 0) + 1);
    }
    const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    /** 票数描述：平票 PK 重投之后会被**重算**成重投的票数（否则公告印的是 PK 之前的旧票数） */
    let detail = sorted.map(([seat, n]) => `${seat} 号 ${(bySeat(s, seat) || {}).name || ''} ${n} 票`).join('，');
    /** 本轮**可公开**的最终票数：平时就是这一轮，平票 PK 之后换成重投的（见函数里两处 publishVoteResult） */
    let published = Object.fromEntries(sorted);
    if (!sorted.length) {
      // 本轮到此结束（一张有效票都没有）：票数可以公开了（空票数在界面上就是"不显示"）
      publishVoteResult(s, published);
      // 预算用尽导致的"一张票都没有"要说清楚是等待超时，别让玩家以为大家都主动弃票了
      await this.say(budgetBroke ? '【法官】投票等待超时，本轮无人出局。' : '【法官】本轮全部弃票，无人出局。');
      s.phase = 'night';
      this.save();
      await this.sleepGap();
      return;
    }
    const top = sorted[0][1];
    const topSeats = sorted.filter(([, n]) => n === top).map(([seat]) => seat);

    if (topSeats.length > 1) {
      // 平票：PK 发言后由未平票者重投（规则文件第七章）。
      // 这一段要能"续玩"：s.pkSeats 非空说明 PK 已经开过（刷新回来），
      // 那就跳过平票公告与 PK 发言，只把还没投的重投补完（s.pkBallots 里是已投的）。
      const fresh = !Array.isArray(s.pkSeats) || !s.pkSeats.length;
      const pkSeats = fresh ? topSeats.slice() : s.pkSeats.map(Number);
      if (fresh) {
        s.voteRound = 1;
        s.pkSeats = pkSeats.slice();
        s.pkBallots = [];
        const tieText = pkSeats.map((x) => x + ' 号 ' + ((bySeat(s, x) || {}).name || '')).join('、');
        // 第一轮到此已经结算（平票也是结果）：先把票数公开，再公告 PK
        // （PK 的规则本身就要求全场知道"谁平票、各几票"，这属于"投票结束后"的信息）
        publishVoteResult(s, published);
        await this.say(`【法官】出现平票：${tieText}（各 ${top} 票），进入 PK 发言。`);
        // PK 发言同样要告诉发言人"顺序、谁还没轮到"（见 speakOrderNote）：这一轮已经 PK 说过的人
        // 由这个循环自己攒——**不能**用 s.spokenSeats（那是白天那一轮的记录，PK 时全场都说过话了）。
        const pkSpoken = [];
        for (const seat of pkSeats) {
          const p = bySeat(s, seat);
          if (!p || !p.alive) continue;
          const t = await this.speakTurn(p, { withVote: false, pk: true, pkSeats, spoken: pkSpoken.slice() });
          pkSpoken.push(Number(seat));
          if (t && t.speech) {
            /* 发言已写进群里 */
          }
        }
        await this.say('【法官】PK 发言结束，请平票者以外的玩家重新投票。');
        this.save();
      }
      // PK 重投＝**又一轮收票**：从这一刻起票数再次不公开（重投结果出来才公布），
      // 上面刚公开的那份平票票数也撤下 —— 不然你会看着票数决定重投给谁。
      s.voteOpen = true;
      s.voteResult = null;
      // PK 重投拿**自己的一份**预算：普通投票慢（但正常）时不该把 PK 挤掉（见本函数开头 voteDeadline 的说明）
      voteDeadline = Date.now() + this.voteBudgetMs;
      budgetBroke = false;
      const pkVoted = new Set((s.pkBallots || []).map((b) => Number(b.voterSeat)));
      const reBallots = (s.pkBallots || []).map((b) => {
        const voter = bySeat(s, b.voterSeat);
        return voter ? { voter, seat: b.seat == null ? null : Number(b.seat) } : null;
      }).filter(Boolean);
      for (const p of aliveOf(s)) {
        if (this.stopped) return;
        const pausedMs = await this.gate();
        if (pausedMs > 0) voteDeadline += pausedMs; // 同上：暂停不吃 PK 重投的预算
        if (!p.alive || p.canVote === false) continue;
        if (pkSeats.includes(p.seat)) continue; // 平票者不参与重投
        if (pkVoted.has(Number(p.seat))) continue; // 这一票已经投过了
        // 同普通投票：预算不能拦在真人前面（否则你的重投票从没被问过就被算弃票）
        if (!p.isUser && Date.now() > voteDeadline) {
          // 和普通投票共用一个预算：重投同样是串行调用，供应商整体慢时不能在这里无限拖
          budgetBroke = true;
          this.warn('投票等待超时：还没重投的人按弃票算，PK 结果照常结算');
          break;
        }
        const others = aliveOf(s).filter((x) => pkSeats.includes(x.seat));
        let seat = null;
        if (p.isUser) {
          const r = await this.askHuman('vote', { me: p, options: others, hint: `平票重投：只能在 ${pkSeats.map((x) => x + ' 号').join('、')} 里选，也可以弃票` });
          seat = r && r.seat ? Number(r.seat) : null;
        } else {
          const text = await this.askLLM(p, votePromptFor(s, { ...p, __pk: pkSeats }), 'vote');
          seat = parseDecline(text) ? null : parseSeat(text, pkSeats);
        }
        reBallots.push({ voter: p, seat });
        s.pkBallots = [...(s.pkBallots || []), { voterSeat: p.seat, seat }];
        this.save();
      }
      const reTally = new Map();
      for (const b of reBallots) {
        if (!b.seat) continue;
        reTally.set(b.seat, (reTally.get(b.seat) || 0) + 1);
      }
      const reSorted = [...reTally.entries()].sort((a, b) => b[1] - a[1]);
      if (!reSorted.length || (reSorted[1] && reSorted[1][1] === reSorted[0][1])) {
        // 重投也没分出胜负：重投的票数就是本轮的最终票数（公开它，别停在 PK 之前那轮）
        s.voteLive = Object.fromEntries(reSorted);
        s.lastBallots = reBallots.map((b) => ({ voterSeat: b.voter.seat, seat: b.seat }));
        s.pkSeats = [];
        published = Object.fromEntries(reSorted);
        publishVoteResult(s, published);
        await this.say(!reSorted.length && budgetBroke ? '【法官】PK 重投等待超时，本轮无人出局。' : '【法官】重投仍然平票，本轮无人出局。');
        s.phase = 'night';
        this.save();
        await this.sleepGap();
        return;
      }
      // 重投定胜负：公告要印**重投**的票数，实时票数同步换成重投的（规则：PK 后以重投结果为准）
      s.voteLive = Object.fromEntries(reSorted);
      s.lastBallots = reBallots.map((b) => ({ voterSeat: b.voter.seat, seat: b.seat }));
      // 重投结束＝本轮结算：公开的是**重投**的票数（PK 之前那份已经撤下了）
      published = Object.fromEntries(reSorted);
      publishVoteResult(s, published);
      detail = reSorted.map(([seat, n]) => `${seat} 号 ${(bySeat(s, seat) || {}).name || ''} ${n} 票`).join('，');
      topSeats.length = 0;
      topSeats.push(reSorted[0][0]);
      s.pkSeats = [];
      s.pkBallots = [];
    }

    const outSeat = topSeats[0];
    const out = bySeat(s, outSeat);
    // 票数收完了、结果马上就要公告 —— 这一刻才把票数交给界面（say() 里的 save() 会立刻刷新 HUD）
    publishVoteResult(s, published);
    await this.say(`【法官】放逐投票结果：${detail}。${outSeat} 号 ${out ? out.name : ''} 被放逐。`);

    if (out && out.alive) {
      // 白痴翻牌：免死一次，之后失去投票权
      if (out.role === 'idiot' && !out.revealedIdiot) {
        out.revealedIdiot = true;
        out.canVote = false;
        await this.say(`【法官】${out.seat} 号 ${out.name} 翻牌——是「白痴」！免于放逐，但从此失去投票权。`);
      } else {
        await this.killPlayer(out, '被投票放逐', { lastWords: true, canShoot: true });
      }
    }

    const winner = checkWinner(s);
    if (winner) {
      s.winner = winner;
      s.phase = 'ended';
    } else {
      s.phase = 'night';
    }
    this.pendingVotes = null;
    this.save();
    await this.sleepGap();
  }

  async phaseEnd() {
    const s = this.state;
    if (this.stopped) return; // 手动结束的局不再播报"身份公开/胜负"（用户已经主动退出了）
    // 幂等：宣布过就别再来一遍（刷新恢复时 phase 仍是 ended，会再走一次这个方法）
    if (s.endAnnounced) {
      s.over = true;
      this.save();
      return;
    }
    // 先把"结束"这个事实落盘，再公布身份：否则存档里会出现
    // "over=false + log 尾部是全员身份表"的中间态，被"接着上一局"捡起来。
    s.over = true;
    s.endAnnounced = true;
    this.save();
    const wolves = s.players.filter((p) => p.team === TEAM_WOLF);
    const gods = s.players.filter((p) => p.team === TEAM_GOOD && p.god);
    const villagers = s.players.filter((p) => p.team === TEAM_GOOD && !p.god);
    const why =
      s.winner === TEAM_WOLF
        ? countAlive(s).god === 0
          ? '神职全部出局（屠神）'
          : '平民全部出局（屠民）'
        : '狼人全部出局';
    // 这条 keep=true：局内所有其它消息都不进普通群聊，但"玩过一局、已经结束"要留下，
    // 这样角色既记得玩过，又知道该回到日常聊天了。
    await this.say(`【法官】本局狼人杀结束：${teamName(s.winner)}胜利（${why}）。大家散场，可以继续正常聊天了。`, { keep: true });
    const reveal = [...wolves, ...gods, ...villagers]
      .map((p) => `${p.seat} 号 ${p.name} = ${ROLES[p.role].name}${p.alive ? '' : '（已出局）'}`)
      .join('；');
    await this.say(`【法官】身份公开：${reveal}`);
    // 给每位角色写一条"长期记忆"：记得玩过这局、自己是什么身份、结果如何
    // （只写进本人的记忆，别的角色看不到；身份不会进群聊记录）
    await this.rememberGame(why);

    this.save();
    if (typeof this.handlers.onEnd === 'function') {
      try {
        this.handlers.onEnd({ winner: s.winner, state: s });
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 把这一局写进每位角色自己的长期记忆（facts）。
   * 用 facts 而不是 summary：记忆整理（滚动摘要）时会保留 facts，不会被冲掉。
   * @param {string} why 结束原因（如"狼人全部出局"）
   */
  async rememberGame(why) {
    const s = this.state;
    const d = new Date();
    const stamp = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    const result = `${teamName(s.winner)}胜利（${why}）`;
    for (const p of s.players) {
      if (p.isUser || !p.id) continue;
      const fate = p.alive ? '，我活到了最后' : `，我在第 ${num(p.deadDay, s.day)} 天出局（${p.deadReason || '出局'}）`;
      const line = `（和群友玩过的游戏）${stamp}在群「${s.groupName}」玩了一局狼人杀：我是「${ROLES[p.role].name}」，${result}${fate}。`;
      try {
        // 局中把角色删了：玩家对象是开局快照，这里要确认人还在，别给已删角色写记忆
        if (!(await getCharacter(p.id))) continue;
        // Per-game identity avoids losing a second game in the same group/day.
        // Atomic store dedup also prevents replay from restoring a withdrawn record.
        const gameId = String(s.gameId || `${s.groupId}:${s.createdAt}`);
        await appendGameMemoryFact(p.id, line, { gameId });
      } catch {
        /* 记忆写失败不影响结算 */
      }
    }
  }

  /* ---------------- 小工具 ---------------- */

  async sleepGap() {
    await sleep(STEP_GAP);
  }

  /**
   * 法官公告：写进群消息（所有人可见） + 记入公开信息
   * @param {string} text
   * @param {{keep?:boolean}} [opts] keep=true 表示这条在**游戏结束后仍会进普通群聊的上下文**
   *   （只用于"本局已结束"这类让角色知道'玩过、但已经散场'的公告）
   */
  async say(text, opts = {}) {
    const s = this.state;
    const line = String(text || '').trim();
    if (!line) return;
    // 被"结束"停掉之后不再播报（除非调用方明确 force，例如散场锚点）。
    // 否则停在夜里的那一阶段会继续把"天亮了/昨晚出局"写进群消息。
    if (this.stopped && !(opts && opts.force)) return;
    s.log = [...(s.log || []), line].slice(-120);
    try {
      await appendGroupMessage({ groupId: s.groupId, role: 'system', content: line, status: 'done', game: 'werewolf', keepGame: Boolean(opts && opts.keep) });
    } catch {
      /* 落库失败不影响游戏继续 */
    }
    if (typeof this.handlers.onJudge === 'function') {
      try {
        this.handlers.onJudge(line, s);
      } catch {
        /* 忽略 */
      }
    }
    this.save();
    await this.sleepGap();
  }

  /** 某位玩家"说话"：写进群消息 + 记入公开信息 */
  async speak(player, content) {
    const s = this.state;
    const text = String(content || '').trim();
    if (!text) return;
    if (this.stopped) return; // 停了就不再落发言
    s.log = [...(s.log || []), `${player.seat} 号 ${player.name}：${text}`].slice(-120);
    try {
      await appendGroupMessage({
        groupId: s.groupId,
        role: player.isUser ? 'user' : 'assistant',
        speakerId: player.isUser ? USER_ID : player.id,
        speakerName: player.name,
        content: text,
        status: 'done',
        auto: false,
        // 打上来源标记：局内消息不进普通群聊的提示词（见 core/group.js）
        game: 'werewolf',
      });
    } catch {
      /* 忽略 */
    }
    if (typeof this.handlers.onSpeech === 'function') {
      try {
        this.handlers.onSpeech(player, text);
      } catch {
        /* 忽略 */
      }
    }
    this.save();
  }

  /**
   * 把「公开发言」的流式增量推给界面（聊天页据此长出临时气泡，观感与普通群聊一致）。
   *
   * 只有发言才推：夜间行动/投票是**私密指令**（"刀杀：3号"），把半截命令画到聊天页上
   * 只会打扰人，而且它们本来就不该被别人看到。
   * 落库时由界面把临时气泡换成真消息（见 ui/groupchat.js 的 gmsg:appended）；
   * 这一轮没有发言（模型空回/被停掉）时推 null，让界面把气泡收掉。
   * @param {object} player
   * @param {string|null} full 已经累计出来的**原文**（界面用 liveSpeechPreview 裁成正文）；null = 收掉气泡
   */
  emitSpeechLive(player, full) {
    const h = this.handlers && this.handlers.onSpeechLive;
    if (typeof h !== 'function') return;
    try {
      h(player, full === null ? null : String(full || ''));
    } catch {
      /* 界面出错不能影响这一局继续跑 */
    }
  }

  /**
   * 顺序发言兜底：**不许质问"还没轮到的人怎么不说话"**。
   *
   * 白天是按座位顺序依次发言（见 phaseDay），后置位此刻**还没有机会开口**，
   * "他一直不出声"在顺序发言里根本不构成疑点。可模型会把公开记录里"没有 9 号的声音"
   * 读成"9 号一直躲着"——线上实测：8 号发言时质问还没轮到的 9 号"被人捞了一整轮还不出声"。
   * 与狼人兜底同一套三层防护：① 提示词写清顺序（speakOrderNote）② 犯了就点名纠正重说
   * ③ 还犯就把那句删掉；整段都在催就换成一句不违规的场面话。
   * 你的发言（人类玩家）不受影响。
   * @param {object} player
   * @param {string} text
   * @param {string} prompt 原提示词（纠正重试时复用）
   * @param {{pkSeats?:number[], spoken?:number[]}} opts 发言顺序（同 speakOrderFor 的入参）
   * @returns {Promise<string>}
   */
  async guardSilenceUrge(player, text, prompt, opts = {}) {
    const t = String(text || '');
    if (!t || !player || player.isUser) return t;
    if (!looksLikeSilenceUrge(t, this.state, player, opts)) return t;
    const { pending } = speakOrderFor(this.state, player, opts);
    this.debug(`系统：${player.seat} 号 ${player.name} 的发言在催还没轮到的人（${seatList(pending)}），已要求重说`);
    const fixPrompt =
      prompt +
      `\n\n【重要纠正】你刚才那条发言在催/点评 **${seatList(pending)}** 为什么不说话。` +
      '这一轮是**按座位顺序依次发言**，他们排在你后面，**此刻还没有机会开口**，' +
      '所以"不吭声 / 不出声 / 不表态"完全正常，不能当成疑点，也不能拿来踩或催。' +
      '请重新说一条（1~3 句）：只针对法官公告和**已经发过言的人**；想听后面那些人的态度，' +
      '就说"等 X 号表态"，但不要把它记成可疑。';
    const again = await this.askLLM(player, fixPrompt, 'day');
    const fixed = stripSilenceUrge(again && again.trim() ? again : t, this.state, player, opts);
    // 只留下一张票（发言被删光）时补一句场面话：不能让这个人看起来"什么也没说"，
    // 也不能把票丢了 —— 投票行原样接在后面（splitSpeechAndVote 照样认它）。
    const voteLine = (fixed.match(/(?:^|\n)[ \t]*投票\s*[:：][^\n]*/) || [''])[0].trim();
    const spokenLeft = fixed.replace(/投票\s*[:：][^\n]*/g, '').trim();
    if (spokenLeft) return fixed;
    return voteLine ? `${SILENCE_URGE_FALLBACK}\n${voteLine}` : SILENCE_URGE_FALLBACK;
  }

  /**
   * 狼人发言兜底：两种"战术自杀"要拦住
   *   · 认狼（自曝）—— 直接把阵营送掉
   *   · 出卖狼同伴（指认同伴是狼/可疑）—— 等于替好人清狼坑
   * 三层防护：
   *   ① 提示词里已经写死了这两条（teamRuleFor / 遗言提示）
   *   ② 万一模型还是犯：点名纠正，让它重说一次
   *   ③ 重说还犯：把出问题的那句直接删掉；整段都违规就换成一句不违规的场面话
   * 你的发言（人类玩家）不受影响——你想怎么演都行。
   * @param {object} player
   * @param {string} text
   * @param {string} prompt 原提示词（纠正重试时复用）
   * @returns {Promise<string>}
   */
  async guardWolfSpeech(player, text, prompt) {
    const t = String(text || '');
    if (!t || !player || player.team !== TEAM_WOLF || player.isUser) return t;
    const problems = [];
    if (looksLikeWolfConfession(t)) problems.push('你承认了自己是狼人');
    if (looksLikeSellingTeammate(t, this.state, player)) problems.push('你把狼同伴指认成了狼（或说同伴可疑）');
    if (!problems.length) return t;
    // 注意：这条不能写进 s.log —— s.log 是「公开信息」，会被拼进所有角色的提示词，
    // 写进去等于告诉全场「这个人认了狼 / 咬了自己人」。只记在 debug 里，供测试与排查用。
    this.debug(`系统：${player.seat} 号 ${player.name} 的发言违规（${problems.join('；')}），已要求重说`);
    const fixPrompt =
      prompt +
      `\n\n【重要纠正】你刚才那条发言有严重问题：${problems.join('；')}。` +
      '这都是狼人绝不能做的事。请重新说一条：继续伪装成好人，可以悍跳预言家、可以反咬、可以把怀疑引向**好人**——' +
      '但绝不能承认自己是狼，绝不能指认或暗示你的狼同伴有问题。';
    const again = await this.askLLM(player, fixPrompt, 'day');
    const ok = (x) => x && x.trim() && !looksLikeWolfConfession(x) && !looksLikeSellingTeammate(x, this.state, player);
    if (ok(again)) return again.trim();
    let cleaned = stripWolfConfession(t);
    cleaned = stripTeammateAccusation(cleaned, this.state, player);
    if (cleaned) return cleaned;
    // 整段都在违规：换成一句不违规的场面话
    return '（冷笑了一声）随你们怎么想。真要这么定，就别怪这局输得难看。';
  }

  /** 一轮发言：AI 走模型、你自己走界面 */
  async speakTurn(player, opts = {}) {
    const s = this.state;
    if (this.stopped) return null;
    await this.gate();
    const others = aliveOf(s).filter((p) => p.id !== player.id);
    const alive = others.map((p) => p.seat);
    if (player.isUser) {
      const r = await this.askHuman('speech', { me: player, hint: opts.pk ? '轮到你 PK 发言' : `轮到你发言（第 ${s.day} 天）`, withVote: opts.withVote !== false, options: aliveOf(s) });
      const text = r && r.text ? String(r.text) : '';
      const parsed = opts.withVote !== false ? splitSpeechAndVote(text, alive, others) : { speech: text, vote: null, abstain: false };
      if (parsed.speech) await this.speak(player, parsed.speech);
      else await this.say(`【法官】${player.seat} 号 你选择了跳过发言。`);
      // 投票改成"点按钮"为主：发言里如果已经写了票（高级用法）就直接用，否则单独问一次
      if (opts.withVote !== false && !parsed.vote && !parsed.abstain) {
        // 盲投：同样不给票数（见 phaseVote 里的说明与 publicVoteTally）
        const rv = await this.askHuman('vote', {
          me: player,
          options: others,
          hint: '点一个按钮投票放逐（结果会在所有人投完后一起公布）',
        });
        if (rv && rv.abstain) {
          parsed.abstain = true;
        } else if (rv && rv.seat) {
          parsed.vote = Number(rv.seat);
        } else {
          parsed.abstain = true; // 没选就当弃票
        }
      }
      return parsed;
    }
    /**
     * 发言顺序（顺序发言这一段提示词 + 后面的兜底都要用，见 speakOrderNote）：
     * · 普通白天发言：顺序＝存活玩家按座位升序，`state.spokenSeats` 是这一轮已经说过的人；
     * · 平票 PK 发言：顺序＝平票座位，已说过的人由 phaseVote 那个循环自己攒了传进来（opts.spoken）——
     *   不能用 `state.spokenSeats`（那是白天那一轮的记录，PK 时全场都已经说过话了）。
     */
    const orderOpts = { spoken: opts.pk ? opts.spoken || [] : s.spokenSeats, pkSeats: opts.pkSeats };
    const prompt = opts.pk
      ? dayPromptFor(s, player, { withVote: false, ...orderOpts }) + '\n（这是平票 PK 发言：请只发言，不要投票）'
      : dayPromptFor(s, player, { withVote: opts.withVote !== false, ...orderOpts });
    // live：这句话是给全场听的，流式增量要推给界面（观感与普通群聊一致）
    let text = await this.askLLM(player, prompt, 'day', { live: true });
    if (!text) {
      this.emitSpeechLive(player, null); // 没有发言：把临时气泡收掉，别让它一直挂着
      await this.say(`【法官】${player.seat} 号 ${player.name} 没有发言。`);
      return null;
    }
    // 狼人自曝兜底：模型万一不听话认了狼，先点名纠正重说一次，再不行就把那句话删掉
    text = await this.guardWolfSpeech(player, text, prompt);
    // 顺序发言的兜底：不许质问"还没轮到的人怎么不说话"（见 speakOrderNote）
    text = await this.guardSilenceUrge(player, text, prompt, orderOpts);
    const parsed = opts.withVote !== false ? splitSpeechAndVote(text, alive) : { speech: text.trim(), vote: null, abstain: false };
    if (parsed.speech) await this.speak(player, parsed.speech);
    else this.emitSpeechLive(player, null); // 整段只有一张票：同样要收掉气泡
    return parsed;
  }

  /**
   * 出局结算：遗言 + 猎人开枪
   * @param {object} player
   * @param {string} cause
   * @param {{lastWords?:boolean, canShoot?:boolean}} opts
   */
  async killPlayer(player, cause, opts = {}) {
    const s = this.state;
    if (!player || !player.alive) return;
    if (this.stopped) return; // 停了就不再结算出局（含遗言与猎人开枪）
    player.alive = false;
    player.deadReason = cause;
    player.deadDay = s.day;
    // 真人这一侧的私密提示（🔒）：priv 只进 privLog + onPrivate，界面只对"本人"显示，
    // 不进群聊、也不会拼进任何角色的提示词 —— 所以这里带 cause 是安全的（README 写明"你的死因只私下告诉你"）。
    this.priv(player, `你出局了（${cause}）`);
    // 规则文件第七章：法官公布出局者但**不公布死因**，所以这条公告不带 cause。
    // cause 只留在引擎内部：猎人能不能开枪（下面）、局末复盘、长期记忆。
    // ⚠️ 不要再把 cause 喂给模型：AI 角色没有"私密频道"，它知道的任何事都会顺着公开发言说出去
    //    （遗言就是公开发言 —— 见 lastWordsPromptFor 的注释与 docs/ARCHITECTURE.md 5.9）。
    await this.say(`【法官】${player.seat} 号 ${player.name} 出局。`);
    if (opts.lastWords) {
      if (player.isUser) {
        // 真人是当事人：死因只私下告诉他（操作条的 hint 与 🔒 提示，别人看不到）
        const r = await this.askHuman('lastWords', { me: player, hint: `你出局了（${cause}）。说一句遗言，或跳过`, options: aliveOf(s) });
        const text = r && r.text ? String(r.text) : '';
        if (text.trim()) await this.speak(player, text.trim());
        else await this.say(`【法官】${player.seat} 号 你放弃了遗言。`);
      } else {
        // AI 角色的遗言提示词里**没有 cause**（它只会公开发言，没法"只告诉它"）
        const lwPrompt = lastWordsPromptFor(s, player);
        // live：遗言也是给全场听的公开发言，同样要一句句长出来
        let text = await this.askLLM(player, lwPrompt, 'day', { live: true });
        text = await this.guardWolfSpeech(player, text, lwPrompt);
        if (text && text.trim()) await this.speak(player, text.trim().split('\n').slice(0, 3).join(' '));
        else this.emitSpeechLive(player, null); // 没有遗言：收掉临时气泡
      }
    }
    // 猎人开枪：被刀/被票出可以，被毒死不能。
    // 补充场规（写在 ruleCardFor 里）：**如果这次出局本身已经达成屠边胜负，就不再开枪** ——
    // 例：猎人作为最后一个神职被刀死，狼队此刻已经屠神获胜，这枪不该把胜负再翻回去。
    // 同批出局里若狼人也全灭，checkWinner 里"狼全灭优先"，仍按好人胜。
    const decidedNow = player.role === 'hunter' ? checkWinner(s) : '';
    if (player.role === 'hunter' && !decidedNow && opts.canShoot !== false && player.deadReason !== '女巫毒杀') {
      const targets = aliveOf(s);
      if (targets.length) {
        let seat = null;
        if (player.isUser) {
          const r = await this.askHuman('shoot', { me: player, options: targets, hint: '你是猎人，开枪带走一人（也可以放弃）' });
          seat = r && r.seat ? Number(r.seat) : null;
        } else {
          const text = await this.askLLM(
            player,
            // 这里也**不写 cause**：能不能开枪已经由引擎按 deadReason 判完了（上面那个 if），
            // 模型只需要抛一个座位号回来（这段回复不会被念出去，但"进模型的每个字都不含死因"
            // 这条不变式比"反正它不会说"更好守）。
            `【狼人杀 · 猎人开枪】你是 ${player.seat} 号 ${player.name}，身份「猎人」，你刚刚出局。\n存活玩家：${seatList(targets)}\n只输出一行：开枪：<编号>号（或 开枪：放弃）`,
            'day'
          );
          seat = parseDecline(text) ? null : parseSeat(text, targets.map((p) => p.seat));
        }
        if (seat) {
          const t = bySeat(s, seat);
          if (t && t.alive) {
            await this.say(`【法官】${player.seat} 号 ${player.name}（猎人）开枪带走了 ${t.seat} 号 ${t.name}！`);
            await this.killPlayer(t, '猎人开枪', { lastWords: false, canShoot: false });
          }
        }
      }
    }
    this.save();
  }

  /* ---------------- 模型调用 ---------------- */

  /**
   * 调一次模型拿决策/发言
   * @param {object} player
   * @param {string} prompt
   * @param {'night'|'day'|'vote'} kind
   * @param {{live?:boolean}} [opts] live=true 表示这一问是**公开发言**：
   *   把流式增量推给界面（handlers.onSpeechLive），让这句发言像普通群聊那样一句句长出来。
   *   夜间行动 / 投票 / 猎人开枪都不要开：它们是私密指令，半截命令不该出现在聊天页上。
   * @returns {Promise<string>} 失败返回空串
   */
  async askLLM(player, prompt, kind = 'day', opts = {}) {
    const s = this.state;
    const settings = this.settings || {};
    const characterModel = this.members.find((m) => String(m.id) === String(player.id))?.model || player.model;
    const provider = (characterModel && characterModel.provider) || settings.provider || 'deepseek';
    const model = (characterModel && characterModel.model) || settings.model || 'deepseek-flash';
    const apiKey = (settings.apiKeys || {})[provider] || '';
    const baseUrl = (settings.baseUrls || {})[provider] || '';
    const meta = PROVIDERS ? PROVIDERS[provider] : null;
    const needKey = !meta || meta.needKey !== false;
    if (!settings.useProxy && needKey && !apiKey) {
      this.stop('no-key');
      throw new Error('还没有配置 API Key：打开「设置 → 模型」填一个就能继续玩了。');
    }

    // 白天发言带完整人设（保持"还是同一个人"）；夜间行动**不装人设**（system 只用下面那句），省 token
    // —— 注意"不装人设"只是 system 这一侧；狼的夜间 user 提示词里另有一段公开记录（见 nightPromptFor）
    let system = '你正在参加一局狼人杀，请严格按格式输出，不要写多余的解释。';
    if (kind !== 'night') {
      const char = this.charByPlayerId.get(String(player.id));
      if (char) {
        let memory = this.memCache.get(String(player.id));
        if (!memory) {
          try {
            const store = await import('./store.js');
            memory = await store.getMemory(player.id);
          } catch {
            memory = { summary: '', facts: [] };
          }
          this.memCache.set(String(player.id), memory);
        }
        try {
          system = `${buildSystemPrompt(char, { settings, memory, runtime: getRuntime(player.id) })}\n\n你现在在玩狼人杀，请按下面的要求发言。`;
        } catch {
          /* 人设装配失败就用通用提示 */
        }
      } else if (player.isUser) {
        system = '你正在参加一局狼人杀。';
      }
      // 关键：把"只有本人看得到"的身份补进 system（白天发言与单独投票都要靠它）
      const priv = privateNoteFor(this.state, player);
      if (priv) system = `${system}\n\n${priv}`;
    }

    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    const params = {
      temperature: kind === 'night' ? 0.6 : 0.9,
      maxTokens: kind === 'night' ? 220 : 600,
      // **整局都关掉思考**（不只是夜间）。
      // 原因：DeepSeek 的 reasoning_content 与正文**共享同一个 max_tokens 预算**。
      // 狼人杀这条链路上模型只需要吐"1~3 句发言"或"一行指令"，思考纯属浪费，却常常吃掉
      // 400~600 token —— 预算被思考吃光后正文会被从中间切断（finish_reason=length），
      // 落进群聊就是"话说一半"（实测：600 全被思考占满时正文直接为空）。
      // 夜间行动原本就关（否则 220 token 全被思考吃掉），白天发言 / 投票 / 遗言 / 猎人开枪
      // 是同一条链路，同样必须关。
      thinking: false,
    };
    /** 这一问是不是"公开发言"：是的话把增量推给界面（见 emitSpeechLive） */
    const live = Boolean(opts && opts.live);

    /**
     * 走**流式**接口：这是私聊/群聊/主动消息都在用的同一条链路，
     * 非流式接口在部分中转站与推理模型上会返回空内容（表现就是"角色们全程不发言"）。
     * @param {object} [overrides] 覆盖 params（截断重试时放宽 maxTokens，见下面 truncated 的处理）
     */
    const attempt = async (overrides) => {
      const controller = new AbortController();
      this.controller = controller;
      // 到点就 abort：abort 会让 chatStream 抛错（或带着已流出的文字返回），走"这次没回应"的兜底，
      // 而不是让整局永远挂在这一句上。
      // 关键：**收到新内容就重新计时** —— 挂住不吐字的会被掐断，慢但一直在吐字的正常生成不会被误杀。
      let timer = null;
      /** 这次调用是否已经收尾：流式回调可能在 return 之后还被调一次，别让它再武装一个定时器 */
      let settled = false;
      const armQuietTimer = () => {
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* 忽略 */
          }
        }, this.currentAskTimeoutMs());
      };
      armQuietTimer();
      const useParams = overrides ? { ...params, ...overrides } : params;
      try {
        const r = await chatStream(
          {
            provider, model, apiKey, baseUrl, messages, params: useParams, useProxy: !!settings.useProxy, stream: true, signal: controller.signal,
            // 本层已有一个 quiet 看门狗（收到任何增量就重置，默认 60 秒），但"每次滴一点字"
            // 的供应商能让它永不触发 —— 不传这两个值时唯一的硬上限是 core/llm.js 的
            // 10 分钟总时限，一次投票就能把整局拖住。这里给一个与之匹配的硬上限：
            // 60 秒无新内容 / 90 秒总计（失败后还有非流式兜底，见下面那个 chat() 调用）。
            timeoutMs: 60000,
            totalTimeoutMs: 90000,
          },
          {
            onDelta: (delta, full) => {
              armQuietTimer();
              // 公开发言：顺手把增量推给界面（夜间行动/投票不推，见 opts.live）
              if (live) this.emitSpeechLive(player, full);
            },
          }
        );
        void this.countUsage(r, provider, model, player);
        const part = String((r && r.text) || '').trim();
        const aborted = !!(r && r.aborted);
        return {
          text: part,
          aborted,
          // 两种"没说完"都要认出来：
          //   ① 上游因 max_tokens 用尽而截断（finish_reason=length）；
          //   ② 看门狗把一次"不说话"的调用掐断，但已经吐出了半句 —— 这半句同样不能说成"说完了"
          //      （掐断本身不重试，理由见下面 quietAbort 那段注释）。
          truncated: !!(r && r.truncated) || (aborted && needsUnfinishedMark(part))
        };
      } finally {
        settled = true;
        if (timer) clearTimeout(timer);
        this.controller = null;
      }
    };

    let text = '';
    let lastErr = null;
    let quietAbort = false;
    let truncated = false;
    /**
     * 截断重试用的放宽额度：至少翻倍，也不低于 +256，上限 4096（再大只是烧钱）。
     * @param {object} base
     * @returns {object}
     */
    const withMoreTokens = (base) => {
      const cur = num(base && base.maxTokens, 600);
      return { ...base, maxTokens: Math.min(Math.max(cur * 2, cur + 256), 4096) };
    };
    try {
      const r = await attempt();
      text = r.text;
      quietAbort = r.aborted;
      truncated = r.truncated;
    } catch (err) {
      lastErr = err;
    }
    // 被 token 上限截断（finish_reason=length）：这半句话**不能**当成完整发言落库。
    // 先用双倍额度重问一次（仍走流式，公开发言的气泡会被新内容自然覆盖）；
    // 重问仍被切，就保留更长的那个，最后在尾巴上补"……"（见 markTruncatedTail）。
    if (truncated && !this.stopped && !quietAbort) {
      try {
        const r2 = await attempt(withMoreTokens(params));
        const t2 = r2.text;
        if (t2 && (!r2.truncated || t2.length > text.length)) {
          text = t2;
          truncated = r2.truncated;
        }
      } catch (err) {
        if (!lastErr) lastErr = err;
      }
    }
    // 空内容/失败都重试一次（用非流式兜底，覆盖"只支持非流式"的中转）。
    // 但被看门狗掐断（aborted）的不重试：供应商既然收下了流式请求却一直不吐字，
    // 换成非流式几乎同样装死，重试只会再干等一整个上限（实测每次都白等 60 秒）。
    if (!text && !this.stopped && !quietAbort) {
      const ctl = new AbortController();
      this.controller = ctl;
      const timer = setTimeout(() => {
        try {
          ctl.abort();
        } catch {
          /* 忽略 */
        }
      }, this.currentAskTimeoutMs());
      // 上一次是"被截断"的话，兜底这一次同样放宽额度，否则只是再被切一遍
      const fbParams = truncated ? withMoreTokens(params) : params;
      try {
        const r = await chat({
          provider, model, apiKey, baseUrl, messages, params: fbParams, useProxy: !!settings.useProxy, signal: ctl.signal,
          // 非流式没有增量事件，只能靠这两个上限兜住"上游挂着不回"
          timeoutMs: 60000,
          totalTimeoutMs: 90000,
        });
        text = String((r && r.text) || '').trim();
        truncated = !!(r && r.truncated);
        if (text) void this.countUsage(r, provider, model, player);
      } catch (err) {
        if (!lastErr) lastErr = err;
      } finally {
        clearTimeout(timer);
        this.controller = null;
      }
    }
    if (!text) {
      if (this.stopped) return '';
      // 连续没回应 → 后面的座位改用短等待，别每个都干等满 60 秒（供应商挂了时这是唯一能"快点走完"的办法）
      this.missStreak = (this.missStreak || 0) + 1;
      if (this.missStreak >= ASK_STALL_AFTER && !this.stallWarned) {
        this.stallWarned = true;
        this.warn('模型连续没有回应：这局剩下的环节改用更短的等待时间，不再长时间卡住');
      }
      this.warn(
        lastErr
          ? `模型调用失败：${(lastErr && lastErr.message) || lastErr}`
          : '模型返回了空内容：角色没法发言，建议在「设置 → 模型」换一个模型或检查中转站是否支持流式'
      );
      // 走 debug 而不是 log：log() 写的 state.log 是**公开信息**（会被拼进所有角色的提示词），
      // 而"某座位这轮没回应"等于告诉全场"这个座位有夜间行动（狼/预言家/女巫）"。
      this.debug(`⚠️ ${player.seat} 号 ${player.name} 这轮没回应`);
    } else {
      this.missStreak = 0;
      this.stallWarned = false;
    }
    // 重问之后仍被截断：至少让玩家看出来"这句话没说完"，别把半句伪装成完整发言。
    if (text && truncated) {
      text = markTruncatedTail(text);
      // 同样只写 debug：这是"这个座位这次调用出了问题"，属于不该公开的元信息
      this.debug(`⚠️ ${player.seat} 号 ${player.name} 的这次输出没说完（max_tokens 用尽或被掐断），已按"没说完"标注`);
    }
    return text;
  }

  /**
   * 这一次调用允许"多久没有新内容"：正常情况下是 askTimeoutMs（60 秒），
   * 连续 {@link ASK_STALL_AFTER} 次完全没回应就降级成 askStallMs（15 秒），任意一次正常返回即恢复。
   * @returns {number}
   */
  currentAskTimeoutMs() {
    return this.missStreak >= ASK_STALL_AFTER ? Math.min(this.askTimeoutMs, this.askStallMs) : this.askTimeoutMs;
  }

  /** 只提醒一次的警告（避免一局里弹几十条一样的提示） */
  warn(text) {
    const key = String(text || '').slice(0, 40);
    this.warned = this.warned || new Set();
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.state.warnings = [...(this.state.warnings || []), String(text || '')].slice(-5);
    if (typeof this.handlers.onWarn === 'function') {
      try {
        this.handlers.onWarn(String(text || ''));
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 用量记账（失败静默，不影响游戏） */
  async countUsage(res, provider, model, player) {
    try {
      const u = (res && res.usage) || {};
      const prompt = num(u.prompt !== undefined ? u.prompt : u.prompt_tokens, 0);
      const completion = num(u.completion !== undefined ? u.completion : u.completion_tokens, 0);
      if (!prompt && !completion) return;
      const store = await import('./store.js');
      const { addUsage, estimateCost } = await import('./llm.js');
      const total = num(u.total, prompt + completion) || prompt + completion;
      await addUsage({
        at: Date.now(),
        charId: String(player.id),
        groupId: this.state.groupId,
        provider,
        model,
        prompt,
        completion,
        total,
        cost: estimateCost(provider, model, { prompt, completion }),
      });
      void store;
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 交给界面等你的操作（全自动模式里唯一会停下来的地方）
   *
   * 必须带超时：这是全项目唯一"没有任何兜底"的等待 —— 界面那边的 resolve 只由
   * "你点了按钮"或"结束整局"触发（ui/werewolf.js 的 3 分钟计时器只弹提醒、
   * 不会替你操作）。轮到你投票/发言时切走页面或关掉面板，引擎就会永久 await，
   * 整局停在那儿且没有任何提示。
   * @param {string} kind
   * @param {object} req
   * @returns {Promise<object|null>}
   */
  async askHuman(kind, req = {}) {
    const s = this.state;
    s.pending = { kind, at: Date.now(), ...req };
    this.save();
    const fn = this.human && this.human[kind === 'speech' ? 'speech' : kind];
    if (typeof fn !== 'function') {
      s.pending = null;
      this.save();
      return null;
    }
    let out = null;
    let timer = null;
    let timedOut = false;
    try {
      // 超时不抛错，按"放弃这次操作"处理（弃票/跳过），让整局能继续走下去
      out = await Promise.race([
        fn({ ...req, state: s }),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, HUMAN_TIMEOUT_MS);
        }),
      ]);
    } catch {
      out = null;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (timedOut) {
      this.warn(
        `等你操作超过 ${Math.round(HUMAN_TIMEOUT_MS / 60000)} 分钟没有回应，这次按「放弃」处理（仍可继续这一局）`
      );
    }
    s.pending = null;
    this.save();
    return out || null;
  }

  /**
   * 只给某位玩家看的即时反馈（查验结果 / 用药结果 / 自己的死因）。
   * 走 handlers.onPrivate，由界面只在"本人"这一侧显示；**不会**进群聊消息，也不会发给别的角色。
   * @param {object} player
   * @param {string} text
   */
  priv(player, text) {
    if (!player || !text) return;
    const line = String(text);
    this.state.privLog = [...(this.state.privLog || []), `${player.seat} 号 ${line}`].slice(-40);
    if (typeof this.handlers.onPrivate === 'function') {
      try {
        this.handlers.onPrivate(player, line);
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 内部日志（只进内存/调试用，不写群消息） */
  log(text) {
    const s = this.state;
    s.log = [...(s.log || []), String(text)].slice(-120);
    this.save();
  }

  /** 只给开发与测试看的记录：**不会**进提示词、也不会发到群里 */
  debug(text) {
    const s = this.state;
    s.debug = [...(s.debug || []), String(text)].slice(-120);
    this.save();
  }
}

/** 把狼队友拼成「1 号 林晚、3 号 阿哲」这样的文本（给"你是狼人"的提示用） */
function humanMatesText(wolves) {
  return (Array.isArray(wolves) ? wolves : [])
    .filter((p) => p && !p.isUser)
    .map((p) => p.seat + ' 号 ' + p.name)
    .join('、');
}

/** 从数组里随机取一项 */
function pickRandom(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 开局前的模型自检：发一句极短的话，确认当前配置真的能拿到**非空**回复。
 * 这一步能挡住最常见的"开局了但角色全程不说话"（key 失效 / 中转站不支持流式 / 模型返回空）。
 * @param {object} settings
 * @returns {Promise<{ok:boolean, error:string}>}
 */
export async function preflight(settings = {}) {
  const provider = settings.provider || 'deepseek';
  const model = settings.model || 'deepseek-flash';
  const apiKey = (settings.apiKeys || {})[provider] || '';
  const baseUrl = (settings.baseUrls || {})[provider] || '';
  const meta = PROVIDERS ? PROVIDERS[provider] : null;
  const needKey = !meta || meta.needKey !== false;
  if (!settings.useProxy && needKey && !apiKey) {
    return { ok: false, error: '还没有配置 API Key：打开「设置 → 模型」填一个再开游戏' };
  }
  const messages = [
    { role: 'system', content: '你正在玩狼人杀。只回四个字：我准备好了' },
    { role: 'user', content: '请回复：我准备好了' },
  ];
  // 自检只验证“能否返回正文”，无需深度思考。关闭 DeepSeek 思考后
  // 再把上限提高到 256，给其他返回偏长的模型/中转站留出余量。
  const params = { temperature: 0, maxTokens: 256, thinking: false };
  let lastErr = null;
  // 先试流式（主链路）。自检是"用户点了按钮在等"的交互，不能落回 120 秒/10 分钟的默认值。
  try {
    const r = await chatStream(
      { provider, model, apiKey, baseUrl, messages, params, useProxy: !!settings.useProxy, stream: true, timeoutMs: 30000, totalTimeoutMs: 45000 },
      {}
    );
    if (String((r && r.text) || '').trim()) return { ok: true, error: '' };
  } catch (err) {
    lastErr = err;
  }
  // 再用非流式兜底
  try {
    const r = await chat({ provider, model, apiKey, baseUrl, messages, params, useProxy: !!settings.useProxy, timeoutMs: 30000, totalTimeoutMs: 45000 });
    if (String((r && r.text) || '').trim()) return { ok: true, error: '' };
    return { ok: false, error: '模型返回了空内容（可能不支持流式，或 max_tokens 太小被推理占满）' };
  } catch (err) {
    lastErr = err || lastErr;
  }
  return { ok: false, error: (lastErr && lastErr.message) || '模型调用失败' };
}

/** 便捷入口：跑完一整局 */
export function runWerewolf(opts) {
  return new WerewolfGame(opts).run();
}

export default {
  WerewolfGame,
  runWerewolf,
  preflight,
  ROLES,
  BOARDS,
  USER_ID,
  boardFor,
  boardLabel,
  assignRoles,
  aliveOf,
  countAlive,
  checkWinner,
  tallyVotes,
  tallyText,
  publicVoteTally,
  bySeat,
  byId,
  seatList,
  privateNoteFor,
  teamRuleFor,
  looksLikeWolfConfession,
  stripWolfConfession,
  looksLikeSellingTeammate,
  stripTeammateAccusation,
  hudExtraFor,
  ruleCardFor,
  parseSeat,
  parseDecline,
  parsePoisonOrder,
  splitSpeechAndVote,
  saveGame,
  loadGame,
  clearGame,
  clearAllGames,
  isActive,
  MIN_PLAYERS,
  MAX_PLAYERS,
  MIN_MEMBERS,
  MAX_MEMBERS,
};
