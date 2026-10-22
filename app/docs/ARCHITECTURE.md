# AI 聊天网站 · 架构与模块契约（冻结版 v1）

> 本文件是**实现契约**。所有模块必须严格遵守下面的导入路径、函数签名与数据字段；
> 任何偏离都会导致集成失败。实现语言为**原生 ES Module（浏览器直接运行，无构建步骤）**。

---

## 0. 技术基线（不可更改）

- 纯浏览器应用：`<script type="module">` + 原生 ES Module，**不使用**打包器、不使用 npm 依赖、不使用 TypeScript（用 JSDoc 标注类型）。
- 运行方式：`node server.mjs`（零依赖 Node 服务器，端口 5180）→ 浏览器打开 `http://127.0.0.1:5180`。
- 存储：IndexedDB（主），localStorage（设置/密钥/轻量状态）。
- 文件回填必须先完整取得所有远端消息与记忆，再在同一个 IndexedDB 跨表事务内清空并回填；读取或写入失败都不得留下半库数据。整库覆盖、清空和普通镜像写入共享全局文件锁。
- 运行时状态以 `updatedAt` 判断新旧；好感度允许下降，不得用 `Math.max` 合并。无时间戳的旧记录冲突时以磁盘为准。
- 代理模式的模型列表走 `/api/models`，由服务器持有密钥；`/api/llm`、`/api/tts`、`/api/models` 共用同一来源与局域网口令守卫。
- **禁止**使用 `import` 之外的模块系统；**禁止**引入任何 CDN 资源（必须能完全离线运行）。
- 所有源码为 UTF-8、LF、2 空格缩进、可读的中文注释。
- 所有面向用户的文案为**简体中文**。
- 绝不使用 `alert()`；错误通过 `ui/toast.js` 的 `toast()` 呈现。
- 所有 DOM 通过 `el()` 或模板字符串创建，**不拼接用户输入到 innerHTML**（防 XSS）。

---

## 1. 目录结构

```
项目/app/
├── index.html                    # 唯一入口（应用外壳 + 内联启动脚本）
├── manifest.webmanifest          # PWA
├── sw.js                         # Service Worker（离线缓存）
├── server.mjs                    # 零依赖静态服务器 + /api/llm 代理（含密钥托管）
├── styles/
│   ├── base.css                  # 设计令牌、reset、通用控件
│   └── app.css                   # 布局与组件样式（三栏 / 气泡 / 弹层）
├── core/
│   ├── bus.js                    # 极简事件总线
│   ├── util.js                   # 工具函数（id/日期/文本/哈希/下载/剪贴板）
│   ├── store.js                  # IndexedDB 持久层 + 设置 + 导出导入（含群聊）
│   ├── runtime.js                # 角色运行时状态（好感度/情绪/未读/时间感知）
│   ├── prompt.js                 # 提示词装配（记忆/时间/上下文预算）
│   ├── llm.js                    # 模型接入层（多供应商 + 流式 + 用量统计）
│   ├── filestore.js              # 本地文件存储同步（启动回填 + 每次改动镜像写盘）
│   ├── group.js                  # 群聊引擎（谁来说 / 怎么说 / 一轮怎么跑）
│   ├── werewolf.js               # 狼人杀引擎（板子/发牌/阶段状态机/胜负 + LLM 驱动角色行动）
│   └── proactive.js              # 角色主动性消息（定时器）
├── data/
│   ├── templates.js              # 内置人设模板库（≥30 个）
│   └── models.js                 # 供应商 / 模型 / 参数预设
├── voice/
│   ├── splitter.js               # 流式断句器
│   ├── tts.js                    # Speaker 抽象 + SpeechQueue + 缓存
│   └── stt.js                    # 语音输入（识别）
└── ui/
    ├── shared.js                 # 界面层公用工具（头像/emoji/ctx/localStorage，单一实现）
    ├── dom.js                    # el() / html 工具
    ├── icons.js                  # 内联 SVG 图标表
    ├── toast.js                  # 轻提示 + 确认对话框
    ├── sidebar.js                # 左侧：群聊区 + 好友列表 / 分组 / 搜索 / 新建
    ├── chat.js                   # 中间：消息流 / 输入区 / 流式 / 多版本 / 语音
    ├── werewolf.js                 # 狼人杀面板（私密身份卡 / 你的行动与投票 / 暂停结束）
    ├── groupchat.js              # 中间：群聊（多角色同屏 + 角色互相接话）
    ├── groupeditor.js            # 弹层：新建群聊 / 改群资料 / 拉人进群
    ├── favorites.js              # 弹层：收藏夹（好友私聊 + 群聊的收藏合并成一条流）
    ├── editor.js                 # 右侧 & 弹层：角色卡编辑 / 模板库 / 导入导出
    ├── settings.js               # 设置面板（模型 / 密钥 / 语音 / 群聊 / 数据 / 关于）
    └── app.js                    # 应用装配、路由、主题、快捷键、启动引导
```

---

## 2. 数据模型（字段名冻结）

### 2.1 Character（角色卡）

```js
{
  id: 'c_k3f9a2',            // 唯一 id，createId('c')
  name: '林晚',               // 必填，可命名
  avatar: '',                // 图片 dataURL 或 emoji 字符；空则用名字首字
  emoji: '🌙',               // 无头像图时显示
  color: '#6c8cff',          // 主题色（气泡/强调）
  gender: '女', age: '24', job: '插画师',
  tagline: '一句话简介',
  tags: ['温柔', '治愈'],
  group: '家人',              // 分组名，默认 '默认'
  pinned: false, muted: false,
  persona: {
    personality: '',          // 性格关键词
    mbti: '', values: '', style: '口语',        // 说话风格
    catchphrase: '', emojiHabit: '', particles: '',
    relationship: '朋友',     // 与用户关系
    addressUser: '你',        // 如何称呼用户
    world: '', place: '',
    speech: '',               // 说话禁忌 / 语言习惯
    taboo: ''                 // 禁区话题
  },
  systemPrompt: '',           // 完整系统提示词（高级，留空则由 persona 自动装配）
  examples: [ { user: '', ai: '' } ],            // few-shot
  authorNote: '',             // 作者备注（仅自己可见，注入提示词）
  lorebook: [ { keys: ['精灵族'], content: '', enabled: true } ],   // 世界书：关键词命中才注入
  affinity: 20,               // 初始好感度 0~100
  greeting: [ '……你来了。' ],  // 开场白（可多条随机）
  voice: VoiceConfig,          // 见 2.4
  model: null,                 // 覆盖全局模型配置：{ provider, model, presetId } | null
  createdAt: 1690000000000, updatedAt: 1690000000000,
  version: 1,
  history: [ { at, snapshot } ]  // 人设版本历史（最多 20 条，snapshot 为角色卡副本）
}
```

### 2.2 Message（消息）

```js
{
  id: 'm_...', charId: 'c_...',
  role: 'user' | 'assistant' | 'system',
  content: '文本',
  at: 1690000000000,
  variants: null,        // assistant 多版本：{ list: [文本...], index: 0 }
  emotion: '',           // assistant：happy/sad/angry/neutral/shy/excited/worried
  status: 'done' | 'streaming' | 'error',
  model: '', usage: null,   // { prompt, completion, total, cost }
  quoted: null,          // 引用回复：{ id, role, content }
  bookmarked: false,
  error: ''
}
```

### 2.3 Settings（全局设置，存 localStorage 键 `aichat.settings.v1`）

```js
{
  theme: 'dark' | 'light' | 'auto',
  accent: '#6c8cff',
  user: { name: '我', avatar: '', persona: '', gender: '' },     // 全局用户档案（gender 空串 = 不设定，不进提示词）
  provider: 'deepseek', model: 'deepseek-chat',
  apiKeys: { deepseek: '', openai: '', ... },        // 支持 server 托管（见 5.3）
  baseUrls: { deepseek: '', openai: '', ... },       // 自定义反代，空则用默认
  useProxy: false,                                   // 走后端 /api/llm
  params: { temperature: 0.85, topP: 1, maxTokens: 1024, presencePenalty: 0, frequencyPenalty: 0 },
  presets: [ { id, name, params } ],                 // 参数预设
  context: { maxMessages: 40, budgetTokens: 8000, summary: true, summaryKeep: 12, timeAware: true, affinity: true },
  typedEffect: true,                                 // 打字机
  sendKey: 'enter' | 'mod-enter',
  voice: {                                            // 全局语音默认
    enabled: true, provider: 'webspeech', voiceId: '', rate: 1, pitch: 1,
    autoplay: 'off' | 'short' | 'always', shortLimit: 60, cache: true,
    stt: { enabled: true, lang: 'zh-CN', autoSend: false }
  },
  proactive: { enabled: false, minGapHours: 6, quietStart: 23, quietEnd: 7, maxPerDay: 2 },
  budget: { monthlyYuan: 0, warnRatio: 0.8 }
}
```

### 2.4 VoiceConfig（角色声线，挂在 Character.voice）

```js
{ provider: 'webspeech' | 'cloud', voiceId: '', rate: 1, pitch: 1, autoplay: 'short', cache: true }
```

### 2.5 Group（群聊，IndexedDB 表 `groups`）

```js
{
  id: 'g_...',              // createId('g')
  name: '周五夜聊会',        // 必填
  avatar: '',               // 预留：群头像图片 dataURL
  emoji: '💬',              // 无图片时的群头像
  color: '#6c8cff',         // 主题色
  topic: '',                // 群主题 / 场景，作为世界观注入提示词
  members: ['c_1','c_2'],   // 角色 id 列表，≥2（界面层校验），≤24，去重保序
  pinned: false, muted: false,
  autoTalk: true,           // false = 只有被 @ 的角色才回你
  turnMode: 'smart',        // smart | round | random | mention（见 GROUP_TURN_MODES）
  maxAutoTurns: 3,          // 一轮最多几位角色发言（1~8）
  autoDelayMs: 900,         // 角色之间的"打字"间隔毫秒（0~8000）
  autoVoice: false,         // 是否用各角色自己的声线朗读（与 localStorage 的群朗读开关联动）
  greeting: [],             // 预留：开群招呼语
  createdAt, updatedAt, version
}
```

`settings.group`（全局默认项）形状为
`{ autoTalk, turnMode, maxAutoTurns, autoDelayMs, autoVoice, defaultMembers }`，
只在**新建群聊**时套用，已有群聊不受影响。

### 2.6 GroupMessage（群消息，IndexedDB 表 `groupMessages`）

在 Message 的基础上多出「谁说的」这一组字段（其余字段与 2.2 完全一致）：

```js
{
  id, groupId: 'g_...',
  role: 'user' | 'assistant' | 'system',
  speakerId: 'c_...',       // assistant 时为发言角色；user 时为空串
  speakerName: '林晚',       // 冗余存一份：角色被删后历史消息仍能显示发言人
  toIds: ['c_..','user'],   // 这句话 @ 了谁；'user' 表示 @ 到用户（界面显示"对你说"）
  auto: false,              // 预留：是否"自动接话"
  content, at, emotion, status, model, usage, variants, bookmarked, error
}
```

群消息**不写入** `messages` 表，因此建群/退群永远不会污染任何角色的私聊记录。

### 2.7 群聊相关的 localStorage 键

| 键 | 含义 |
|---|---|
| `aichat.lastGroup` | 上次打开的群聊 id |
| `aichat.lastKind` | `char` / `group`：下次启动回到哪一类会话 |
| `aichat.groupDraft.<groupId>` | 群聊输入框草稿 |
| `aichat.voiceOn.group.<groupId>` | 该群的朗读开关（`'1'`/`'0'`，缺省视为开） |
| `aichat.deleted.groups.v1` | 群聊删除墓碑（防止启动回填把删掉的群复活） |
| `aichat.werewolf.<groupId>` | 狼人杀对局存档（`WerewolfGame` 的整个 `state`：牌局、`log` 公开记录、`privLog` 私密记录、`debug`）。刷新后能接着打就靠它；`clearGame()` 删它 |

### 2.8 布局偏好（本机界面状态，不进设置）

| 键 | 含义 |
|---|---|
| `aichat.ui.headCollapsed` | 顶栏是否收起（`'1'`/`'0'`）。收起后顶栏（群聊还含成员条）`display:none`，中栏顶部留一条细拉手 |
| `aichat.ui.rightCollapsed` | 右栏（角色卡 / 群资料）是否收起（`'1'`/`'0'`） |

状态由 `ui/app.js` 持有（`readLayoutPrefs` / `setHeadCollapsed` / `setRightCollapsed`），
只体现在外壳的两个 class 上：`.shell.head-collapsed`、`.shell.no-right`。
开关按钮只负责发起切换（`ctx.toggleChatHead()` / `ctx.toggleRightPane()`，返回最新状态），本身不留状态，
文案由 `applyLayoutPrefs()` 统一同步，所以不会出现"面板已展开、按钮却还写着展开"的不同步。

两个开关的位置与恢复入口（**都不在顶栏的工具区里**，顶栏只放会话本身的工具）：

| 收起的 | 开关 | 收起后的恢复入口 |
|---|---|---|
| 顶栏 | 顶栏工具区最右的 `^`（`twoStateIconBtn`，双态图标：展开 `^` / 收起 `v`） | 中栏顶部 14px 细拉手（`headRestoreBar`），**必须在顶栏之外**，否则跟着一起被藏掉 |
| 右栏 | 右栏（角色卡 / 群资料）右上角的 `✕`（`rightCollapseBtn`，占原来的「编辑」铅笔位置；编辑入口在顶栏与正文里各还有一条） | 中栏右边缘 14px 竖拉手（`rightRestoreBar`），它占外壳网格的第三列而不是绝对定位浮着，所以不会压住消息区滚动条 |

- 窄屏（≤1000px）右栏本来就是 `display:none`，此时竖拉手也不显示（`@media (min-width: 1001px)` 才出现那条 14px 列）。
- 细拉手上的「返回列表」：窄屏（≤759.98px，与顶栏里 `.chat-back` 同一个断点）才出现 —— 手机上顶栏里的
  返回键会跟着顶栏一起被收起，不给这个键就会走进"回不去列表"的死角。纯 CSS 控制，JS 不需要额外同步。
- **两条拉手必须"同一套形式"**（改一条记得改另一条，`tools/` 里没有断言这条，靠这份文档约束）：
  容器底色 `--panel`、内侧 1px `--line-soft` 分隔线**画在按钮自己的边上**（挂在按钮上才会跟着
  `base.css` 的 `button:hover { border-color: var(--accent) }` 一起变蓝——这就是点击时的"蓝光"）、
  图标 `--dim-2`、悬停 `--text` + `--panel-2`。焦点圈统一 `outline: 2px solid var(--accent); outline-offset: -2px`
  （**必须内嵌**：细拉手紧贴 `#chatPane`，而 `#chatPane` 是 `overflow:hidden`，外扩的焦点圈会被裁掉，
  表现就是"竖拉手有蓝圈、细拉手没有"）。

---

## 3. 模块契约（导出签名必须逐字一致）

### 3.1 `core/bus.js`

```js
export const bus = {
  on(evt, fn) {},       // 返回 off()
  off(evt, fn) {},
  emit(evt, payload) {},
  once(evt, fn) {},
};
```
标准事件名（其余模块禁止自造）：
`char:changed` `char:deleted` `msg:appended` `msg:updated` `chat:open` `settings:changed`
`voice:state` `llm:usage` `runtime:changed` `toast`
跳转（搜索、收藏夹）：`chat:focus-message`（私聊，载荷 `{id, charId}`）
群聊追加：`group:changed` `group:deleted` `gmsg:appended` `gmsg:updated`
群聊内的跳转：`gchat:focus-message`（载荷 `{id, groupId}`，与 `chat:focus-message` 对称）

### 3.2 `core/util.js`

```js
export function createId(prefix = 'i'): string
export function uid(): string
export function debounce(fn, ms = 300): Function
export function throttle(fn, ms = 100): Function
export function escapeHtml(s: string): string
export function clsx(...parts): string                     // 过滤 falsy 并 join(' ')
export function hashCode(s: string): string                // 32 位十六进制
export function pick(array): any
export function sleep(ms): Promise<void>
export function clamp(n, min, max): number
export function fmtTime(ts): string                        // 14:05
export function fmtDay(ts): string                         // 今天 / 昨天 / 3月5日 / 2024年3月5日
export function fmtDate(ts): string                        // 2024-03-05 14:05
export function relTime(ts): string                        // 刚刚 / 5 分钟前 / 3 小时前 / 2 天前
export function isSameDay(a, b): boolean
export function timeContext(): { now, hour, minute, dateStr, weekStr, partOfDay, isWeekend }
export function num(v, d = 0): number
export function estimateTokens(text: string): number       // 中文按 1 字≈1 token，英文 4 字符≈1
export function countChars(text: string): number
export function download(filename: string, blobOrText: string | Blob, mime = 'application/json'): void
export function readFileAsText(file: File): Promise<string>
export function readFileAsDataURL(file: File): Promise<string>
export function copyText(text: string): Promise<boolean>
export function firstChar(s: string): string
export function truncate(s: string, n: number): string
export function stripMarkdown(s: string): string           // 供 TTS 朗读前清洗
```

### 3.3 `ui/dom.js`

```js
export function el(tag: string, props?: object, ...children): HTMLElement
   // props: { class, id, text, html(仅可信常量), style(object|string), dataset(object),
   //          on: { click: fn }, attr: {...}, value, placeholder, type, disabled, checked }
export function frag(...children): DocumentFragment
export function qs(sel: string, root = document): Element | null
export function qsa(sel: string, root = document): Element[]
export function clear(node: Element): void
export function mount(parent: Element, ...children): void
export function on(target, evt, selOrFn, fn): () => void     // 事件委托
export function autoGrow(textarea: HTMLTextAreaElement, max = 160): void
export function scrollToBottom(node: Element, smooth = true): void
export function isNearBottom(node: Element, threshold = 80): boolean
```

### 3.4 `ui/icons.js`

```js
export const icons: Record<string, string>;   // 名 → <svg ...> 字符串（stroke=currentColor, 24x24）
export function icon(name: string, size = 18, extraClass = ''): HTMLElement;
```
必需图标名：`send stop plus search settings edit trash copy refresh star bookmark pin
bell belloff mic mic-off speaker speaker-off moon sun close check chevron-down chevron-left
chevron-right user users image download upload dice sparkles brain clock heart smile
book menu more link globe bookmark-on shield key chart wand group arrow-left arrow-right paperclip
at user-plus theater`

### 3.5 `ui/toast.js`

```js
export function toast(msg: string, type?: 'info'|'ok'|'warn'|'error', ms?: number): void
export function confirmDialog(opts: { title: string, message?: string, okText?: string,
                                      cancelText?: string, danger?: boolean }): Promise<boolean>
export function promptDialog(opts: { title: string, label?: string, value?: string,
                                     placeholder?: string, multiline?: boolean }): Promise<string|null>
export function modal(opts: { title: string, body: Node|string, width?: number,
                              actions?: Array<{text, kind?: 'primary'|'ghost'|'danger', onClick(close)}> }):
                { close(): void, root: HTMLElement, body: HTMLElement }
```

### 3.6 `core/store.js`

```js
// ---- 角色 ----
export async function listCharacters(): Promise<Character[]>          // 已按 pinned/updatedAt 排序
export async function getCharacter(id): Promise<Character|null>
export async function saveCharacter(char): Promise<Character>         // 自动补全默认字段、更新 updatedAt、压入 history
export async function deleteCharacter(id): Promise<void>              // 同时删除其消息
export async function duplicateCharacter(id): Promise<Character|null>
export async function importCharacter(json): Promise<Character>       // 兼容 SillyTavern V2 角色卡
export function toSillyTavern(char): object                           // 导出 V2 角色卡
// ---- 消息 ----
export async function listMessages(charId): Promise<Message[]>
export async function appendMessage(msg): Promise<Message>            // msg 缺省字段自动补全，emit msg:appended
export async function updateMessage(id, patch): Promise<Message|null> // emit msg:updated
export async function deleteMessage(id): Promise<void>
export async function deleteMessages(charId, ids: string[]): Promise<void>
export async function clearMessages(charId): Promise<void>
export async function searchMessages(charId, keyword): Promise<Message[]>  // charId=null 表示全局
export async function getMessage(id): Promise<Message|null>
// ---- 收藏夹（私聊 + 群聊合并，时间倒序；bookmarked 是消息自己的字段，不需要新表） ----
export async function listBookmarks(): Promise<BookmarkItem[]>
   // BookmarkItem: { kind:'char'|'group', id, at, role, content,
   //                 charId, groupId, speakerId, speakerName, game }
export async function countBookmarks(): Promise<number>
// ---- 记忆 ----
export async function getMemory(charId): Promise<{ summary: string, facts: string[], updatedAt: number, summarizedUpTo: number }>
export async function saveMemory(charId, mem): Promise<void>
// ---- 设置 ----
export function getSettings(): Settings                 // 深拷贝，已与默认值合并
export function setSettings(patch): Settings            // 浅合并并 emit settings:changed
export function resetSettings(): Settings
// ---- 数据 ----
export async function exportAll(charIds?: string[]): Promise<Blob>   // 完整备份 zip→实为 .json 包
export async function importAll(fileOrJson): Promise<{ chars: number, messages: number }>
export async function wipeAll(): Promise<{ ok: boolean, fileOk: boolean, fileError: string }>
   // ok=false 表示"磁盘确实需要清而没清成功"（界面据此提示，绝不再无条件报成功）；见 5.13③
export async function dbStats(): Promise<{ chars, messages, bytes }>
export function onStorageError(fn): void
```

### 3.7 `core/runtime.js`

```js
export function getRuntime(charId): { affinity: number, mood: string, lastChatAt: number|null,
                                      streak: number, lastProactiveAt: number, proactiveCount: number,
                                      proactiveDay: string, unread: number }
export function setRuntime(charId, patch): object           // emit runtime:changed
export function bumpAffinity(charId, delta): number
export function markRead(charId): void
export function unreadTotal(): number
export function initCharacterRuntime(char): void            // 用 char.affinity 初始化
export function affinityLabel(v: number): string            // 陌生/认识/熟络/亲近/交心
export function detectEmotion(text: string): string         // 从用户文本粗略识别情绪
export function setMood(charId, mood): void
export function daysSince(ts): number
```

### 3.8 `core/prompt.js`

```js
export function buildSystemPrompt(char, ctx): string
export function matchLore(char, text): Array<{keys:string[], content:string}>   // 世界书关键词命中（只返回启用且命中的）
export function applyWorldPreset(char, worldId, opts?: {loreMode?:'replace'|'merge'}): object
   // 套用世界观预设。默认 loreMode:'replace' —— 换世界时移除上一套预设带来的条目（手写条目保留）；'merge' 为旧的叠加行为
   // ctx: { settings, memory, runtime, timeCtx }
export function buildMessages(char, history, opts): { messages, meta }
   // opts: { settings, memory, runtime, userText, budgetTokens }
   // 返回 OpenAI 格式 [{role, content}]，meta = { breakdown:[{label, tokens, kind}], total, kept, dropped }
export function summarizeIfNeeded(char, history, opts): Promise<{ memory, summarized: boolean }>
   // 历史超出预算时调用 llm 生成摘要；失败时静默返回原 memory
export function rebuildMemory(char, history, settings): Promise<object>   // 手动"整理记忆"
```

### 3.9 `core/llm.js`

```js
export const PROVIDERS: Record<string, {
  id, label, kind: 'openai'|'anthropic'|'gemini'|'ollama',
  baseUrl, models: string[], keyName?: string, needKey: boolean, docs?: string
}>;

export async function chat(opts): Promise<{ text, usage, raw, model, finishReason, truncated }>
   // opts: { provider, model, apiKey, baseUrl, messages, params, useProxy, stream: false }
export async function chatStream(opts, handlers?): Promise<{ text, usage, model, aborted, finishReason, truncated }>
   // opts 同上 + { stream: true, signal }
   // handlers: { onDelta(text, fullText), onDone(full), onError(err) }
   // finishReason = 上游的结束原因；truncated=true 表示被 max_tokens 截断（正文是半句话，见 5.17）
export function isTruncatedFinish(reason): boolean   // length / max_tokens / max_output_tokens / token_limit
export async function listModels(provider, apiKey, baseUrl): Promise<string[]>   // 失败返回 []
export function estimateCost(provider, model, usage): number   // 人民币估算，未知返回 0
export async function addUsage(record): Promise<void>          // 累计用量（设置面板统计）
export async function getUsage(): Promise<{ total: {prompt,completion,total,cost}, daily: Record<string, {tokens,cost,calls}>, byChar: Record<string,{tokens,cost,calls}> }>
export async function clearUsage(): Promise<void>
export function abortController(): AbortController             // 便捷构造
export const llmErrors: { isAuth(err), isNetwork(err), isRateLimit(err), humanize(err): string };
```

### 3.10 `data/models.js`

```js
export const PROVIDERS_META // = llm.PROVIDERS（由 data/models 提供上游数据，llm.js 从这里导入）
export const DEFAULT_PRESETS: Array<{ id, name, params }>
export const MODEL_PRICING: Record<string, { in: number, out: number }>   // 元/百万 token
export const CHAT_MODELS: Record<string, string[]>                        // provider → 常用模型
export const PARAM_HINTS: Record<string, { label, min, max, step, desc }> // 参数滑块的展示元数据
// 思考模式三态（见 5.19）：界面只认这三个，别在 ui/settings.js 里另写一套 if
export const THINKING_CHOICES: Array<{ value: 'default'|'off'|'on', label, desc }>
export function thinkingChoiceOf(params?: object): 'default'|'off'|'on'   // params.thinking → 选项（非布尔值= default）
export function thinkingParamOf(choice: string): boolean|null             // 选项 → params.thinking（default = null）
```

### 3.11 `voice/splitter.js`

```js
export function createSplitter(opts?: { minFirst?: number, min?: number, max?: number }):
  { push(chunk: string): string[], flush(): string[], reset(): void }
```
默认 `{ minFirst: 8, min: 14, max: 90 }`，切分规则与《语音方案》一致。

### 3.12 `voice/tts.js`

```js
export class SpeechQueue {
  constructor(speaker, cfg, handlers?: { onSentence?(text, i), onStart?(), onEnd?(), onError?(e) })
  push(sentences: string[]): void
  stop(): void          // 打断
  get speaking(): boolean
  get pending(): number
}
export const speaker: {
  speak(text: string, cfg: VoiceConfig, signal?: AbortSignal): Promise<void>
  stop(): void
  pause(): void; resume(): void
  listVoices(lang = 'zh'): Array<{ id, name, lang, local: boolean }>
  unlock(): void                 // 用户手势内调用，解锁音频上下文
  test(text: string, cfg: VoiceConfig): Promise<void>
  onPlaybackSkipped: ((reason: string) => void) | null   // 设备放不出声时回调（UI 挂 toast 提示，见 5.10）
}
export function speakText(text: string, cfg: VoiceConfig): Promise<void>   // 单句朗读
export function stopSpeaking(): void
export function voiceAvailable(): { tts: boolean, stt: boolean }
export function voiceFor(char, settings): VoiceConfig     // 合并角色声线与全局默认
export function clearVoiceCache(): Promise<void>
export const CLOUD_VOICE_PRESETS: string[]   // 云端音色常用预设（只是下拉建议，不是白名单）
export const CLOUD_TTS_MODELS: string[]      // 云端模型常用预设
export function cloudConfig(s?): { provider, model, apiKey, baseUrl, useProxy, label, needKey }
```

**云端语音的供应商 / 密钥 / 地址（两条铁律，见 5.11）**：`provider` 取
`settings.voice.ttsProvider || settings.provider`，密钥与地址**只认这个供应商** ——
`apiKey = voice.apiKey || apiKeys[provider]`、`baseUrl = voice.baseUrl || baseUrls[provider] || PROVIDERS_META[provider].baseUrl`。
**任何一级都不得回退到 `keys.openai` / `urls.openai`**（那会把 OpenAI 的密钥发到别家接口上）。
`custom` 且没配地址时 `baseUrl` 为空串，由 `fetchCloudAudio()` 抛中文错误，而不是偷偷打到 OpenAI。
代理模式下客户端必须把 `provider`（以及用户配的 `baseUrl`）一起发给 `/api/tts`，
服务端据此选上游与密钥；`server.mjs` 的 `handleTTS` 因此也接受 `baseUrl` 覆盖（同 `/api/llm`）。

### 3.13 `voice/stt.js`

```js
export function sttAvailable(): boolean
export function createRecognizer(opts?: { lang?: string, interim?: boolean,
  onResult?(text: string, isFinal: boolean), onEnd?(), onError?(err),
  silenceMs?: number,      // 静默多久没有识别结果就自动收工（默认 8000ms；计时跨自动重启累计）
  onSilence?() }):         // 静默自动停止时回调（不是错误，UI 用它提示"好一会儿没听到你说话"）
  { start(): void, stop(): void, get listening(): boolean }
```

### 3.14 `ui/sidebar.js` / `ui/chat.js` / `ui/editor.js` / `ui/settings.js`

每个模块导出：
```js
export function renderSidebar(root: HTMLElement, ctx): void
export function renderChat(root: HTMLElement, ctx): void
export function openCharacterEditor(charOrNull): void       // editor.js
export function openTemplateGallery(): void                 // editor.js
export function openSettings(section?: string): void        // settings.js
export function focusMessage(id): void                      // chat.js：滚动到某条私聊消息并高亮
export function openFavorites(): { close, root, body }       // favorites.js：收藏夹面板
```
> 注：`openImportDialog()` / `openExportDialog()`（editor.js）**已删除**——界面入口在改用
> "数据自动落盘本地文件"时就已按需求移除，两个弹窗从此无人调用却一直挂在模块里；
> 备份包导出/导入的**能力**仍在 `core/store.js`（`exportAll` / `importAll` / `toSillyTavern` /
> `importCharacter`）并有用例覆盖，需要时新写一个入口即可（历史实现见 2.0.7 及更早的版本快照）。
> 详见 5.15。
`ctx`（由 `ui/app.js` 传入）：
```js
{
  get currentChar(), get currentCharId(), get settings(), get characters(),
  openChat(charId), reloadCharacters(), rerender(part?: 'sidebar'|'chat'|'all'),
  // 群聊（v2 新增，全部必须存在）
  get groups(), get currentGroup(), get currentGroupId(), get groupMembers(), get groupMsgCount(),
  openGroup(groupIdOrNull), reloadGroups(), openGroupEditor(groupOrNull),
}
```
`ctx.groupMembers` 返回的是**已经解析成角色卡**的成员数组（群成员里已被删除的角色会被自动过滤），
所以 UI 层不需要自己去 store 里查角色。

### 3.14b `ui/groupchat.js` / `ui/groupeditor.js`（群聊界面）

```js
export function renderGroupChat(root: HTMLElement, ctx): void      // 中间栏：群聊
export async function refreshGroupMessages(): Promise<void>        // 重画消息流
export function renderGroupPanel(root: HTMLElement, ctx): void     // 右栏：群资料
export function stopGroupRound(reason?: string): void              // 打断这一轮
export function isGroupBusy(): boolean
export function openGroupSearchDialog(): void                      // 群内搜索
export function appendGroupNotice(text: string): void              // 本地系统提示（不落库）
export async function focusGroupMessage(id): Promise<boolean>      // 跳到某条群消息（收藏夹/搜索用，会等渲染）

export function openGroupEditor(groupOrNull, opts?): { close, root, body }   // groupeditor.js
export function openMemberPicker(group, onSaved?): object                    // groupeditor.js
export function openNewGroupDialog(): object                                 // groupeditor.js
```
- `renderGroupChat()` 每次调用都会重置会话级状态（流式、朗读、语音输入），
  所以 `ui/app.js` 切换群聊时直接重新调用它即可，不需要额外的清理。
- 群资料发生变化（改成员、改接话策略）后，`ui/groupchat.js` **自己整块重绘中栏**
  （顶栏成员叠头像、成员条、输入框占位符里都嵌着群名/成员），
  再通过 `ctx.rerender('all')` 让 app.js 处理侧栏与右栏。

### 3.14c `core/group.js`（群聊引擎）

```js
export const USER_SPEAKER = 'user';
export const TURN_MODES = Array<{ id:'smart'|'round'|'random'|'mention', label, desc }>;

export function memberName(member): string
export function memberEmoji(member): string
export function mentionTargets(text, members, userName?): { memberIds: string[], user: boolean }
export function lastSpeakerId(history): string
export function relevanceScore(member, ctx): number
export function planSpeakers({
  group, members, history?, text?, maxTurns?, mode?, force?, excludeIds?
}): string[]                                   // 返回本轮发言角色 id（顺序 = 发言顺序）
export function formatTranscript(history, opts?): string         // 「名字：内容」
export function stripSpeakerPrefix(text, names): string
export function buildGroupMessages({
  group, speaker, members, history?, settings?, memory?, runtime?, userName?, budgetTokens?, maxMessages?
}): { messages: Array<{role,content}>, meta: object }

export class GroupRound {
  constructor({ group, members, settings?, userName?, userText?, history?,
                maxTurns?, mode?, force?, excludeIds?, handlers? })
  get spoken()            // 本轮已经落库的消息
  plan(): string[]        // 本轮发言名单
  stop(reason?): void     // 打断（当前流式会 abort，未开口的不再开口）
  async run(): Promise<{ turns, reason, messages, plan }>
}

export function runGroupRound(opts): Promise<object>   // new GroupRound(opts).run()
```

`handlers`（全部可选，允许返回 Promise；返回 Promise 时引擎会 await）：
```js
{
  onPlan(speakers),                  // 选定本轮名单
  onTurnStart(speaker, i, total, meta),
  onDelta(delta, full, speaker),
  onTurnDone(msg, speaker, i),        // msg 已经落库
  onTurnError(err, speaker, i),       // 单个角色失败不中断整轮
  onRoundEnd({ turns, reason, messages, plan }),
}
```
`reason` 取值：`done`（正常说完）/ `user`（被打断）/ `no-key`（没有 API Key）/
`silent`（本轮没有人被 @，全体安静）/ `no-members`（群为空）/ `switch`（切换会话）。

**群聊提示词的两个关键设计**（决定"人物之间能不能真的对话"）：
1. **整段转写进 system**：最近的群聊记录以「发言人：内容」的纯文本放进 system 消息，
   再附一条 user 指令「现在轮到你（谁）发言」。这样模型不需要区分 user/assistant，
   既避免了"替别人说话"，又天然兼容只支持 system+user 的接口。
2. **谁来说由 `planSpeakers()` 决定**：被 @ 的角色一定排第一，其余按
   `smart`（相关度 + 发言均衡 + 一点随机）/ `round`（轮流）/ `random`（随机）补齐，
   刚说完的人会被降权；`mention` 策略下没人被 @ 就全体安静。

### 3.14d `core/werewolf.js` / `ui/werewolf.js`（狼人杀）

```js
/* ---------- 常量与板子 ---------- */
export const TEAM_WOLF = 'wolf' / TEAM_GOOD = 'good'
export const ROLES = { wolf, seer, witch, hunter, idiot, villager }   // 含 name/team/god/desc
export const BOARDS = { 6..13: { wolf, villager, gods[], witchAntidoteOnly? } }   // 取自规则文件 4.1
export const MIN_PLAYERS = 6 / MAX_PLAYERS = 13 / MIN_MEMBERS = 5 / MAX_MEMBERS = 12
export const USER_ID = 'user'
export function boardFor(playerCount): board | null      // 人数不合法返回 null
export function boardLabel(board): string                 // "3 狼 · 3 民 · 预言家、女巫、猎人"
export function teamName(team): string

/* ---------- 状态与判定（全是纯函数，可在 Node 里单测） ---------- */
export function assignRoles(players, board): player[]     // 洗牌发牌（唯一随机来源）
export function aliveOf(state): player[]
export function countAlive(state): { wolf, god, villager, total }
export function checkWinner(state): team | ''             // 屠边判定
export function tallyVotes(ballots): { seat: number }
export function tallyText(state, tally): string           // tally 必须显式传入（不回退 voteLive，见 5.9"盲投"）
export function publicVoteTally(state): { seat: number }  // 界面唯一允许读票数的入口：收票期间返回 {}
export function bySeat(state, seat) / byId(state, id) / seatList(players): string

/* ---------- 提示词装配（发给角色的每一段都从这里出，见 5.9） ---------- */
export function publicLogText(state, limit = 40): string          // 公开信息 → 进所有人的提示词
export function privateFacts(state, me): string                   // 只有本人：狼同伴 / 查验 / 药
export function ruleCardFor(state, short): string                 // 本局规则速查（夜间精简 / 白天完整）
export function teamRuleFor(me): string                           // 阵营铁律（狼：绝不认狼）
export function hudExtraFor(state, me) / privateNoteFor(state, me)
export function nightPromptFor(state, me, kind: 'wolf'|'seer'|'witch', extra = ''): string
export function dayPromptFor(state, me, opts?: { withVote?: boolean, pkSeats?: number[], spoken?: number[] }): string
//  ↑ opts 里的 pkSeats/spoken 是"平票 PK 发言"的顺序信息（见 5.20）
export function speakOrderFor(state, me, opts?): { order, index, spokenBefore, pending }
export function speakOrderNote(state, me, opts?): string       // 【发言顺序】那一段（顺序发言的主防线）
export function votePromptFor(state, me): string
export function lastWordsPromptFor(state, me): string     // 遗言（**不带死因**：见 5.9 的"死因不进提示词"）

/* ---------- 解析与兜底 ---------- */
export function parseSeat(text, allowedSeats, players) / parseDecline(text)
export function splitSpeechAndVote(text, allowedSeats, players): { speech, vote, abstain }
export function liveSpeechPreview(raw): string            // 流式预览：把原文裁成"能直接显示的正文"（见 5.16）
export function looksLikeWolfConfession(text): boolean            // 认狼句式（第一人称才算）
export function stripWolfConfession(text): string
export function looksLikeSilenceUrge(text, state, me, opts?): boolean   // 催"还没轮到的人"说话（见 5.20）
export function stripSilenceUrge(text, state, me, opts?): string

/* ---------- 存档与引擎 ---------- */
export function saveGame(state) / loadGame(groupId) / clearGame(groupId) / isActive(groupId)
export async function preflight(settings): { ok, error? }         // 开赛前探一次模型可用性
export function runWerewolf(opts): Promise<state>
export class WerewolfGame {
  constructor({ group, members, settings?, userName?, human?, handlers?, fastMode?, state? })
  // human：把"你"的决策交给界面（夜间行动/投票/发言/遗言），返回 null = 跳过
  // handlers（引擎只调这 8 个）：onJudge(line, state) / onSpeech(player, text) / onPrivate(player, text)
  //                              / onState(state) / onEnd({ winner, state }) / onWarn(text) / onError(err)
  //                              / onSpeechLive(player, full|null)  ← 公开发言的流式增量（见 5.16）
  async run() / pause() / resume() / stop(reason) / save()
  // askLLM(player, prompt, kind, { live: true })：这一问是公开发言，把流式增量推给界面
}

/* ---------- ui/werewolf.js（面板与 HUD） ---------- */
export function openWerewolfPanel(group, ctx): void      // 开局面板 / 进行中面板
export function stopWerewolf(group, reason = 'user'): void
export function werewolfActive(groupId): boolean
export function isPanelOpen(): boolean
export function submitUserText(text): boolean            // 输入框里的话交给引擎（轮到你发言时）
export function awaitingSpeech(): boolean / awaitingAction(): boolean
// HUD 的票数区只在"本轮投票结算后"写「投票结果：…」，收票期间只写「投票中」（盲投，见 5.9）
```
- **座位每局重洗**：`createState()` 先 `shuffled()` 洗名单再交给 `assignRoles()`，所以**你不固定是最后一号**
  （以前是"群成员按入群顺序 + 你固定末位"，于是你永远 9 号）。座位号 = `players` 下标 + 1，
  数组因此始终**按座位升序**——白天"按座位顺序依次发言"那套循环依赖这个不变量。
  写测试时**不要按座位号写死角色或动作**（座位随机、真人会随机占座）：按 `isUser` / 角色查找，
  `tools/werewolfcheck.mjs` 里有个页内助手 `assignToAI()` 专门干这件事（它把剧本角色发给非真人玩家）。
  另注：`p.players[6]` 这类下标假设在洗座位后会静默跑偏——真人当上剧本角色时引擎走 `askHuman` 而不是脚本化的 `askLLM`。
- **信息边界是硬约定**（详见 5.9）：`privateFacts()` / `priv()` / `debug()` 不进 `state.log`，
  公开面（`state.log` + 群消息）里不得出现"谁是什么身份"；玩家身份与狼同伴走 `priv()`。
- **狼队内必须互相可见**：AI 狼读 `privateFacts()` 的"你的狼同伴"（含玩家座位），玩家读私有提示 + HUD。
- 引擎与 UI 的全部往来都通过 `handlers`：`onJudge` 走群消息（公开）、`onPrivate` 走 🔒 私密提示、
  `onSpeech`/`onState`/`onEnd`/`onWarn`/`onError` 供 HUD 与收尾用；UI 不直接改 `state`。

### 3.15 `core/proactive.js`

```js
export function initProactive(ctx): void       // 启动定时检查（每 60s）
export function maybeTrigger(char, ctx): Promise<boolean>   // 生成一条主动消息并入库
export function stopProactive(): void
```

### 3.15b `core/filestore.js`（本地文件存储）

```js
export function fileStatus(): { available, dir, status:'off'|'ok'|'syncing'|'error', error, lastSync, pending }
export async function available(force?): Promise<boolean>
export async function syncOnBoot(): Promise<{ ok, action:'off'|'none'|'pull'|'push'|'error', chars, messages, dir, error? }>
export async function syncNow(): Promise<{ ok, action, chars?, messages?, error? }>
export async function snapshotNow(): Promise<{ ok, file?, counts?, error? }>
export function mirrorCharacter(char): Promise<boolean>
export function mirrorCharacterDeleted(charId): Promise<boolean>
export function mirrorMessages(charId, messages): Promise<boolean>
export function mirrorMessageDeleted(charId, ids): Promise<boolean>
export function mirrorMessagesReplace(charId, messages): Promise<boolean>
export function mirrorMemory(charId, memory): Promise<boolean>
export function mirrorSettings(settings, runtime): Promise<boolean>
export function mirrorWipeAll(charIds): Promise<boolean>
export function noteDeleted(charId, at?): void
export function clearDeleted(): void
```

- 服务端接口（`server.mjs`）：`GET /api/db/state`、`POST /api/db/replace`、`POST /api/db/snapshot`、
  `POST /api/db/wipe`、`GET|POST|PUT|DELETE /api/db/{characters|memory|groups}/:id`、
  `GET|POST /api/db/{messages|groupmsgs}/:id`、`POST /api/db/{messages|groupmsgs}/:id/replace`、
  `GET|POST /api/db/settings`。
- 落盘目录默认 `app/data/db/`，可用 `--data-dir` 或 `AICHAT_DATA_DIR` 覆盖：
  `characters/<角色id>.json`、`messages/<角色id>.ndjson`、`memory/<角色id>.json`、
  `groups/<群id>.json`、`groupmsgs/<群id>.ndjson`、`deleted/<id>.json`（角色墓碑）、
  `deleted/g-<群id>.json`（群聊墓碑）、`settings.json`、`runtime.json`、`backup-<日期>.json`。
- **启动同步策略**：磁盘上有**角色或群聊** → 以磁盘为准清空并回填本地库（群里已被删除的成员会被顺手过滤掉）；
  磁盘为空而本地有 → 把本地整体推上盘；两者都空 → 不做任何事。写入用「临时文件 + rename」保证原子性。
  判据里必须带上群聊：删角色会把群成员摘光，角色被删完时盘上只剩群文件，只看"有没有角色"
  就会让零成员的群与它的聊天记录再也回填不出来（见 5.14①）。"盘上只有群、本地还有角色"这种
  盘面不整体回填（避免把本地角色冲掉），交给"本地推上盘"那条路，两边都不会丢。
- `core/store.js` 的每个写操作（saveCharacter / deleteCharacter / appendMessage / updateMessage /
  deleteMessage(s) / clearMessages / saveMemory / setSettings / wipeAll，以及群聊的
  saveGroup / deleteGroup / appendGroupMessage / updateGroupMessage / deleteGroupMessage /
  clearGroupMessages）都会调用对应的 `mirror*`；镜像失败只记状态、**绝不阻塞**聊天。
- 群聊删除同样留墓碑（localStorage `aichat.deleted.groups.v1`），防止旧标签页在启动回填时把删掉的群复活。
- 事件：`filestore:status`、`filestore:restored`、`filestore:pushed`。

### 3.16 `ui/app.js`（入口，`index.html` 引入）

- 创建三栏布局、主题、启动引导（"🔊 点击开启语音"手势解锁）、PWA 注册。
- 路由：`location.hash` = `#/chat/<charId>` / `#/group/<groupId>` / `#/settings` / `#/new`。
- 当前会话是「角色私聊」还是「群聊」由 `currentCharId` 与 `currentGroupId` 二选一决定（互斥）：
  `renderChatInto()` / `refreshMessages()` / `renderRightPane()` 三处按它分流到
  `ui/chat.js` 或 `ui/groupchat.js`；`aichat.lastKind` 记住上次打开的是哪一种，启动时回到同一个地方。
- 全局快捷键：`Ctrl/Cmd+K` 搜索、`Ctrl/Cmd+N` 新角色、`Esc` 关闭弹层 / 打断生成、`Ctrl/Cmd+/` 快捷键帮助。
- 移动端：单列 + 返回按钮。
- `globalThis.__AICHAT__`（自动化钩子）：`ctx` / `openChat` / `openGroup` / `openGroupEditor` /
  `state`（含 `currentGroupId`、`groups`）/ `abort` / `rerender` / `fileStatus` / `groupBusy()`。

---

## 3.17 `ui/shared.js`（界面层公用工具 · 单一实现）

```js
export function isImageAvatar(avatar): boolean      // data:image / http(s) / blob: / 站内绝对路径
export function entityEmoji(who): string            // emoji 优先，其次非图片 avatar 文本，最后名字首字（图形簇安全）
export function avatarNode(who, size?, third?): HTMLElement   // 图片 > emoji > 首字；third 为 true 显示在线点，为字符串则当底色
export function fillAvatar(box, who): HTMLElement
export function ctxChar(ctx) / ctxCharId(ctx) / ctxSettings(ctx) / ctxChars(ctx) / ctxCall(ctx, name, ...args)
export function readLS(key, fb?) / writeLS(key, v) / removeLS(key) / readLSJson(key, fb?) / writeLSJson(key, v)
export function userNameOf(settings): string
export function colorOf(entity, fallback?): string
export function changedKeys(a, b): string[]
export function twoStateIconBtn(openIcon, shutIcon, title, onClick, marker, size?): HTMLElement
export function headRestoreBar(onClick, onBack?): HTMLElement
export function presetCombo(presets, current, onChange, opts?): HTMLElement   // 预设下拉 + 自定义输入
export function rightCollapseBtn(onClick): HTMLElement
export function rightRestoreBar(onClick): HTMLElement
export function captureVoiceError(cfg): () => string   // 试听时取回云端语音的真实失败原因（见 5.12②）
```

**硬性约定（防止同一功能多份拷贝再次分叉）**：

- 上面这些能力**只允许存在于 `ui/shared.js`**，任何界面模块必须 import，不得再复制实现。
- 背景：重构前 `isImageAvatar` 有 3 种不同实现（对 `/x.png` 的判断互不一致）、`avatarNode` 有 3 种
  （同一个角色在不同界面头像不同）、`readLS/writeLS/userName/curSettings` 在 chat 与 groupchat 里各一份
  且部分已经改岔。这类"多份拷贝"是后续 bug 的主要来源。
- `core/util.js` 同样是唯一的工具来源（`dayKey` / `moodZh` / `safeCostWith` / `toGraphemes` 都在这里）。
- emoji 相关处理一律走 `toGraphemes()` / `takeGraphemes()` / `firstChar()`，
  **禁止用 `Array.from(x)[0]` 或 `x.slice(0,2)`** —— 那会把变体选择符（🕳️）、ZWJ 家庭序列（👨‍👩‍👧）、
  肤色修饰（👍🏽）切坏。这条已有回归用例（tools/selftest.mjs）。

---

## 4. 视觉规范（必须一致）

- 深色为默认。色板（CSS 变量见 `styles/base.css`）：
  `--bg #0f1115` `--panel #171a21` `--panel-2 #1e222b` `--line #2a2f3a`
  `--text #e7e9ee` `--dim #8b93a7` `--accent #6c8cff`（可由设置覆盖）
  `--ok #4ec9a8` `--warn #e0b341` `--danger #ff6b6b` `--werewolf #ff9500`（狼人杀启动键的亮橙，见 5.7）
- 亮色主题通过 `html[data-theme="light"]` 覆盖同名变量。`--werewolf` 也要覆盖（浅色 `#e2761b`）：
  描边风格下橙是**文字色**，白底上亮橙天然吃亏（`#ff9500` 只有 2.05:1）。
- 圆角：控件 8px、卡片 12px、气泡 14px、弹层 16px。
- 字体：`-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`。
- 三栏布局：`grid-template-columns: 288px 1fr 340px`；`<1000px` 收起右栏；`<760px` 单栏。
- 气泡：我方靠右、accent 背景白字；角色靠左、`--panel-2` 背景。
- 消息间距 14px、气泡内边距 10px 14px、行高 1.65。

---

## 5. 关键行为约定

### 5.1 流式对话流程（`ui/chat.js`）
1. 用户发送 → `appendMessage` 入 user 消息 → 立即渲染。
2. `buildMessages()` 装配上下文（含记忆摘要、时间感知、好感度）。
3. `chatStream()` 收到 delta → 打字机渲染到临时气泡；同时 `splitter` 攒句 → `SpeechQueue.push()` 逐句朗读。
4. 结束 → `appendMessage` 落库（含 usage/emotion）、`bumpAffinity(±)`、更新 runtime 的 mood。
5. 失败 → 消息 `status:'error'` 并显示"重试"按钮；语音失败**绝不影响**文字。
6. 停止按钮 → `signal.abort()` + `SpeechQueue.stop()`。

### 5.2 多版本回复
重新生成时若上一条 assistant 消息已有内容，则追加到 `variants.list` 并切换 `index`，气泡下方显示 `◀ 2/3 ▶`。

### 5.2b 群聊一轮的完整流程（`ui/groupchat.js` + `core/group.js`）
1. 用户在群里发一句话 → `appendGroupMessage({groupId, role:'user'})` → 立即渲染；
2. `startRound()` 构造 `GroupRound`：
   - `autoTalk === false` 且不是"强制开聊" → 用 `mention` 策略（没人被 @ 就全体安静）；
   - 否则用群自己配置的 `turnMode`，`maxTurns = group.maxAutoTurns`；
   - 圆桌模式（没有任何用户输入）传 `force: true`，保证"只应 @"的群也能被点起来。
3. `GroupRound.run()` 依次点名：
   - 角色之间 `await sleep(group.autoDelayMs)`（默认 0.9 秒，"打字"节奏）；
   - 每个角色用**自己的人设 + 自己的模型（角色卡可覆盖）**装配群聊提示词；
   - `chatStream` 的 delta 直接画进「某某正在输入…」的临时气泡（群聊不做打字机：
     多个角色排队时，跟上节奏比逐字动画更重要）；
   - 说完 → `appendGroupMessage({speakerId, speakerName, toIds})` → 增量插入气泡。
4. 群内朗读开着时，`onTurnDone` 会 `await SpeechQueue.idle()`，
   等这位角色"说完"再让下一位开口（每人用自己的声线，不抢话）。
5. `stopGroupRound()`（停止按钮 / 圆桌按钮 / Esc / 切换会话）会 `round.stop()`：
   abort 当前流式、移除临时气泡、停朗读；已经说出口的半句会保留下来（≥2 字才落库）。
6. 一轮结束：刷新消息流、`markRead(groupId)`、刷新侧栏与未读；`no-key` / `silent` 会给本地提示。

多角色同屏的视觉约定：气泡左侧竖线、发言人姓名、头像底色都取该角色自己的主题色
（`--char-color`），连续同一个人的消息只在第一条显示头像与名字（`.msg.gmsg.cont`）。

### 5.3 API Key 安全
- 默认 `useProxy: false`：密钥存 localStorage，浏览器直连供应商。
- `useProxy: true`：请求发往 `/api/llm`，由 `server.mjs` 注入密钥（从环境变量或 `app/.env` 读取），客户端不持有密钥。
- 设置面板必须明确提示"密钥仅保存在本机浏览器/服务器"。
- 服务器上的密钥**只能发往该供应商自己的地址**：`keyFor(provider)` 与 `checkUpstreamOverride(baseUrl)`
  都按同一个 `provider` 取值，客户端给的 `baseUrl` 只有在"请求已获授权"且（设置了
  `AICHAT_ALLOWED_UPSTREAMS` 时）落在允许列表内才会被采用，否则 403。见 5.13②。

### 5.4 离线
Service Worker 缓存全部静态资源；无网络时应用可用，只有调用模型会失败并给出友好提示。

### 5.5 未知输入处理
角色卡字段缺失一律用默认值补齐（`normalizeCharacter()` in store.js）；
群聊与群消息同理（`normalizeGroup()` / `normalizeGroupMessage()`），成员去重、策略非法回退 `smart`、数值夹紧。

### 5.6 群聊与私聊的隔离（不可破坏的约束）
- 群消息只写 `groupMessages` 表，`charId` 字段复用为 `groupId` 只为复用索引，**绝不写 `messages` 表**；
- 因此：建群、退群、清空群聊记录都不会影响任何角色的私聊历史；
- 删除角色时 `pruneGroupMembers()` 会把它从所有群聊里摘掉，避免群里留下一个永远不说话的头像；
- 群的未读/已读复用 `core/runtime.js` 的 `unread`／`markRead`（以 groupId 为 key），
  所以侧栏与页面标题的未读数天然把群聊算在一起。

### 5.7 狼人杀启动键的橙色强调

右栏「群资料」动作区里的狼人杀按钮用 `.btn-werewolf`（`styles/base.css`）。它是**描边风格**，
形态与 `(.btn-danger)`「清空」完全对称，只换颜色：透明底 + 1px 橙边 + 橙字 + 加粗。
换句话说，右栏那排按钮里"有颜色的字和边框"就是强调手段，不用实心色块。

- 令牌语义与 danger 对称：`--werewolf` = **文字与边框**色，`--werewolf-text` = 悬停填充后的文字色。
- 两套主题的橙**必须分开给**（橙在这里是文字色，白底上越亮越读不清）：
  - 深色 `#ff9500`（色相 35°、饱和度 100%，压在 `--panel` 上 **7.92:1**，比原来的 `#f0913a` 更亮也更清楚）；
  - 浅色 `#e2761b`（白底 **3.07:1**，过 WCAG 对大字/图形控件的 3:1 线；亮橙与可读性的折中，
    `#ff9500` 只有 2.05:1。若哪天要把浅色也拉到正文级 4.5:1，得回到 `#b85c0e` 这种偏深的橙）。
  - 悬停填充两套主题都用深字 `#2a1a06`（深色 7.65:1 / 浅色 5.48:1）。
- `:hover` 填成橙色，所以如果要改回实心态，记得显式写回 `border-color` 与字色，否则会落到 `base.css` 的
  `button:hover { border-color: var(--accent) }`，在橙底上描出一圈蓝边。
- 它是动作区的第一个按钮，与「编辑」「清空」同高同行（35px，同一 flex 行）。

狼人夜间"不刀人"这一点：规则文件要求狼人每晚必须刀一人，所以界面上的按钮写作
**「今晚不刀人」并先弹一次确认**（`ui/werewolf.js` 的 `renderAction`）；引擎侧保持"给什么用什么"
（人类玩家返回 null → 平安夜），不再偷偷替他选目标 —— 场景用例（`tools/werewolfcheck.mjs` 的 T）
就是靠"放弃 = 平安夜"构造"今晚没有人被刀"的。

### 5.8 初始载入时的滚动位置（踩过的坑）

刷新后必须**已经停在最后一条**，不能出现"先停在顶部、再一路滑到底"。

- `.chat-body` 上**不要**写 `scroll-behavior: smooth`：它会让容器内所有程序化滚动都变成动画，
  包括 `scrollTop = n` 赋值与 `scrollTo({ behavior: 'auto' })`——`'auto'` 的语义正是"用元素 CSS 上的值"。
  需要平滑的地方由 `ui/dom.js` 的 `scrollToBottom(node, true)` 显式传 `'smooth'`。
- `scrollToBottom(node, false)` 传的是 **`'instant'`**，不是 `'auto'`。实测写 `'auto'` 时初始载入会出现
  56 个中间帧、约 1.2 秒的滚动动画。
- 初始载入要**同步滚一次**（首帧画出来就在底部），再在 `requestAnimationFrame` 里补一次
  （字体、头像可能在这一帧之后才把高度撑开）。见 `ui/chat.js` / `ui/groupchat.js` 的 `loadConversation()`。

### 5.9 狼人杀的续玩 / 中断 / 数据清理（踩过的坑）

**刷新续玩是"阶段内接上"，不是"整个阶段重放"**（`core/werewolf.js`）：

- 每个阶段的入口都有幂等标记，续玩只补做没做过的部分：
  `night.no` + `night.finished` + `night.wolfDone/witchDone/seerDone`（夜间）、
  `dawnResolvedDay`（天亮结算）、`spokenDay/spokenSeats`（今天谁发过言）、
  `voteBallots/voteBallotsDay`（已投的票）、`pkSeats/pkBallots`（平票重投进度）。
- ⚠️ **`night.finished` 不能省**：一夜跑完后 `day` 还没 +1，只判"night 存在"或"night.no === day"
  会把"下一夜"误判成"这一夜的重入"，天数永远不增 → `night→dawn→day→vote` 无限循环（踩过一次，
  表现为整个标签页卡死、所有 CDP 调用超时）。`run()` 里另有一道安全网：同一 `phase#day`
  在最近 8 步内出现 3 次就强制把这一夜标记为已跑完并写 debug，宁可推进粗糙也不能卡死。
- 旧格式存档在 `loadGame()` 里归一化：补 `night.no`，并按存档的 `phase` 决定 `night.finished`
  （落在夜里＝没跑完；落在天亮/白天/投票/已结束＝跑完了）。
- 子步骤里"人没了/没牌了"的情况也要打标记（女巫没药、预言家已出局、候选为空），否则那一夜永远做不完。

**中断与退出**：`stop()` 之后 `say/speak/killPlayer/phaseNight/phaseDawn/phaseEnd` 一律直接返回
（避免"人都走了法官还在报幕"）；`phaseEnd` 先落盘 `over/endAnnounced` 再公布身份。

**界面上"轮到你了"必须有入口**：`ui/groupchat.js` 的 `renderGroupChat` 会整体重建中栏，
所以它每次都调用 `ui/werewolf.js` 导出的 `refreshWerewolfUi(g.id)` 重推 HUD 与操作条；
不在对局所在群时只推"关闭"（绝不把 A 局的 HUD 画到 B 群）。同一页面同时只允许一局：
`beginGame` 用模块级 `starting` 挡住自检期间的重入，并拒绝在别的群还有未结束的对局时开局。

**数据层要清对局存档**：删群（`ui/groupchat.js` 的 `removeGroup`）、清空全部数据
（`ui/settings.js` 的 `wipeAll` 之后 `clearAllGames()`）都要清 `aichat.werewolf.*`；
局中禁止"清空群聊记录"（群消息清了但引擎的 `state.log` 还在拼进提示词，角色会引用你看不到的信息）。

### 5.10 语音：每一步 await 都必须有兜底（踩过的坑）

`voice/tts.js` 的朗读链是"合成 → 解码 → 播放"，**每一环都可能不返回**，所以每一环都要有看门狗：

- **播放（`playBlob`）必须有看门狗**。有些环境里 `AudioContext.state` 是 `running`、`currentTime`
  却几乎不推进（没有音频输出设备 / 远程桌面 / 虚拟机），此时 `src.onended` **永不触发**——
  没有兜底的话 `speakText()` 的 Promise 永久 pending，朗读卡在第一句不再往下读。
  现在的两道兜底：①按 `buffer.duration + 600ms` 定时 resolve；②音频时钟 1.2s 内几乎不走
  （`currentTime` 增量 < 0.05s）就认为设备不可用、直接略过（窗口取 1.2s 是为了让蓝牙这类慢启动设备也能走起来）。
  `<audio>` 兜底路径同样有看门狗（拿到 metadata 后按 `duration + 800ms`，拿不到则 30s 硬上限）。
- **`decodeAudio` 要超时**（8s）：坏数据时 `decodeAudioData` 可能既不回调也不 resolve；
  超时后 reject，`playBlob` 会退到 `<audio>` 路径。
- **云端合成（`fetchCloudAudio`）要超时**（30s）：供应商不返回时不能一直干等。预取 `speaker.warm()`
  走的是同一个函数，所以也受保护。
- `speakWebSpeech()` **本来就有**看门狗（按文本长度估时长）——正是它的存在反衬出 `playBlob` 漏了，
  排查这类"朗读卡住"时先看是哪条路径在等。
- 断句器（`voice/splitter.js`）的兜底硬切**必须落在图形簇边界上**（用 `core/util.js` 的 `toGraphemes()`）：
  `buf.slice(0, max)` 会把 emoji / 代理对劈成两半，下一段以半个字符开头，送进 TTS 就是乱码
  （与 3.17 的 emoji 规范同一条约束）。
- **云端合成超时 15s**（不是 30s）：供应商不响应时最多等 15s 就降级，用户不必等半分钟；
  期间也可以点"停止"立刻打断。
- **设备放不出声要告诉用户**：看门狗略过播放时会调 `speaker.onPlaybackSkipped(reason)`
  （模块内限流 10s 一次），`ui/app.js` 把它接到一条 toast —— 否则朗读悄无声息地跳过，看起来像功能坏了。
  设备正常时**不得**误报（`tools/audiocheck` 那条反向检查守着）。
- **语音输入有静默自动停止**：连续 `silenceMs`（默认 8s）没有识别结果就主动收工并回调 `onSilence`，
  避免"麦克风一直开着、又没在说话"时界面长期停在"正在听…"；静默计时跨自动重启累计，
  所以不会因为浏览器重启一次识别就把 8 秒重新数一遍（`ui/chat.js` / `ui/groupchat.js` 各接了一条提示）。
- 回归守：`tools/e2e.mjs` 里有两条 —— "`/api/tts` 请求被真实发出并拿到音频" 与
  "音频设备『时钟不走』时朗读不会卡死（playBlob 看门狗）"（后者用桩把病态环境固定下来）。

### 5.11 音色要"可手填"，不能只有预设

云端音色名与模型名**完全由供应商定义**，所以 UI 一律用「预设下拉 + 自定义输入」
（`ui/shared.js` 的 `presetCombo()`，设置 → 语音 与 角色卡 → 语音 共用）：

- 下拉只放常用预设（`CLOUD_VOICE_PRESETS` / `CLOUD_TTS_MODELS`，来自 `voice/tts.js`）；
  当前值不在预设里时补一条「（自定义）xxx」，保证**界面显示的就是真正在用的值**。
- 用它可以接：**Edge TTS**（`zh-CN-XiaoxiaoNeural`，中文音色最多且免费）、MiniMax（`speech-02-hd`）、
  阿里百炼 CosyVoice、硅基流动、OpenAI 系（alloy/nova/…）、以及**本地自建**的
  OpenAI 兼容 TTS（Kokoro-FastAPI、openedai-speech + XTTS、GPT-SoVITS、CosyVoice、F5-TTS 等，
  支持参考音频克隆 → 一人一嗓）。接法：接口地址填那个服务的 `/v1`，音色名填它的音色/克隆名。
- **每个角色可以单独设云端音色**（角色卡 → 语音 → 云端音色；留空则跟随全局）。
  `voiceFor(char, settings)` 的优先级：角色卡 > 全局默认。
- 切"语音来源"或切云端供应商时，**只清"当前值其实是系统音色名"的情况**
  （那种名字云端会 400 后静默降级回系统音色）；手填的云端音色必须原样保留。
- 回归守：`tools/` 里暂无专条，验证脚本见提交说明；核心断言是"手填值能落库 + 角色级音色生效 + 切供应商不清值"。

### 5.9 狼人杀的信息边界（踩过的坑，三条都已有回归用例）

`ui/werewolf.js` 顶部写着约定：**你的身份只画在 HUD/面板（本地 DOM，不进消息、模型看不到）**；
别人只在自己的提示词里知道自己的身份。下面三条：前两条是违反它之后的实际事故，
第三条（2026-09-19 补）是靠这条不变式兜着的一处设计取舍。

- **法官公告绝不能提"谁是什么身份"**。开局那条原来写成
  `【法官】身份已发到每个人手里（只有本人知道）。9 号就是你自己：你的身份是「猎人」。`——
  它走的是 `say()`（进 `state.log` + 发成群消息），而白天发言/遗言的提示词会把 `publicLogText()`
  整段拼进去，于是 **18/28 条 AI 提问**里都带着它：狼人直接知道你（9 号）是猎人（屠边目标）、
  AI 还会被"**你自己**"三个字绕晕（它的提示词开头写着它是 4 号狼人）。
  现在公开部分只说"身份已发到每个人手里（只有本人知道）。"，身份与狼同伴走 `priv()`
  （只进 `privLog` + `onPrivate`，UI 上是 🔒 提示）。
  **狼队内必须互相看得到**：AI 狼看 `privateFacts()` 的"你的狼同伴"，玩家看那条私有提示 + HUD，
  两边都要覆盖到（`tools/werewolfcheck.mjs` 的 S 条守着）。
- **女巫那句"今晚被刀的是…"要按局面分开写**，不能拼成一句：没人被刀时原来会串成
  `今晚被刀的是：（今晚没有人被刀）（解药已用完或不能自救）`——既自相矛盾，又在**药还在**的时候
  谎报"解药已用完"；被刀的是女巫自己时也误报成"药没了"。现在的三种分支：
  `今晚被刀的是：X 号 XX。你可以用解药救 TA…` / `（被刀的是你自己，你不能自救）` /
  `（解药已用完）`，没人被刀则直接说 `今晚没有人被刀。`（见 T 条）。
- **夜里也要给 AI 狼喂公开记录**（2026-09-19 补）：`nightPromptFor(s, me, 'wolf')` 现在拼上
  `publicLogText(s, 40)` + 一行"怎么挑刀口"。原来 AI 狼夜里只看得到"存活名单 + 规则"——谁跳了预言家、
  谁在带队冲同伴、票都投给了谁，一概不知道，刀口只能靠模型直觉（实测接近随机），
  "屠边优先刀神职"这种最基本的思路都落不了地；白天发言/投票的提示词早就带着这段公开记录，夜里补齐。
  **这条之所以安全，正是因为上面第一条**：`state.log` 里不含任何人的身份（身份只走 `priv()`）。
  回归守：`tools/werewolfcheck.mjs` 的 L 条（公开记录必须真的进狼的夜间提示词）与 S 条（公开面 0 泄露）。
- **AI 女巫的夜间提示词也带公开记录**（2026-09-22 补）：与狼同一段 `publicLogText(s, 40)`
  拼在**用药选项菜单之前**（顺序不能动，`extra` 的最后一句是"只输出一行…"，格式指令必须收尾）。
  原先女巫夜里只有「今晚谁被刀 + 存活名单 + 规则」——白天谁跳了预言家并报了查杀、谁在带队、谁的票最
  集中一概看不到，"用不用毒、毒谁"完全靠模型先验，甚至出现"白天已经认定某人是狼、夜里却没有渠道把
  这个判断带进用药决策"（夜间调用的 `messages` 只有一条 system + 一条 user，不共享白天那次发言的上下文）。
  安全性同狼那一条：`state.log` 不含任何人的身份，且**今晚谁被刀**是法官本来就该私下告诉女巫的信息（走
  `extra`，不改）。预言家的夜间提示词**仍不带**这段（查验只认一个座位号，夜间继续省 token）。
  同一轮还补了**两行"怎么用药"的思路 + 一行毒药候选**（对应狼那句"怎么挑刀口"）：
  - 思路：解药优先救"被刀且像好人或关键神职"的人；毒药留给**最像狼**的人（被公开查杀、被多人围票、
    发言与投票自相矛盾），首夜这种没有可信信息的局面留着往往比盲毒划算。
  - **候选必须写明**：AI 手上那份"存活玩家"是**含她自己**的，而引擎只认"存活且非本人"的座位
    （`phaseNight` 的 `parsePoisonOrder` 白名单）——不写清楚，模型报自己或报已出局的人就白报一次，
    这一夜的毒药决策静默作废（药不消耗，但判断没了）。
  - 只有**毒药还在**时才拼这两行（6 人局只有解药、毒药已用完都不提毒）；6 人局连"毒"字都不多提。
  - 这两行**只进 AI 的提示词，不进 `phaseNight` 的 `witchExtra`**：`witchExtra` 同时是真人女巫操作条上
    的 hint，怎么用药是玩家自己的事，游戏不该在旁边教他打牌。
  - 段里刻意**不出现"今晚"二字**：L/T 条按 `prompt.indexOf('今晚')` 截女巫那段 `extra` 核对措辞
    （见 T 条），多一处会把它截错行。
  回归守：`tools/werewolfcheck.mjs` 的 L 条（女巫提示词必须含公开记录段与法官公告、含用药思路，毒药候选
  不得出现她自己，且这些都排在「从下面这些里选一种」之前；6 人局不得出现毒药候选/毒药思路；预言家那份
  不得被加长）。
- **死因不进提示词**（2026-09-20 补，"当事人知道自己怎么死的"这条事故）：规则是"法官只公布谁出局、
  **不公布死因**"，但 `lastWordsPromptFor()` 的第一行原来写着
  `你刚因为「女巫毒杀」出局了`——遗言却是**公开发言**，于是首夜双死时两个死者都把死因说了出去
  （线上原文："狼第一刀砍了本座""啊——被毒了啊"），等于替女巫宣布**毒药已经用掉、解药已经出手**，
  首夜最贵的一条信息白送。现在**叙述与引擎判定分离**：
  - `player.deadReason` 只留在 state 里，给"猎人能不能开枪""局末复盘/长期记忆"这类**引擎判定**用；
  - `lastWordsPromptFor(s, me)` **不收 cause**，正文只写"你刚刚出局了"，并明写一条
    "死因是谜，场上没有人知道你是怎么死的，别替法官编一个死因出去"；猎人开枪那条
    `【狼人杀 · 猎人开枪】`同理（能不能开枪引擎已经按 `deadReason` 判完了，模型不需要知道）；
  - 真人这一侧**照旧**：`priv()` 与遗言 hint 都是**私密通道**（只进 `privLog` + `onPrivate`，
    UI 只对本人显示、不进群聊、也不拼进任何提示词），所以"你的死因只私下告诉你"这条 README 承诺不变。
  回归守：`tools/selftest.mjs`（纯函数：带不带第三参都不出现死因、且 deadReason 不被提示词读取）
  与 `tools/werewolfcheck.mjs` 的 X 条（按剧本摆出"首夜一刀一毒"的双死局面，真跑一遍，
  断言进模型的提问与公开消息里 0 死因、而引擎侧的 `deadReason` 完整）。
- **投票是"盲投"：收票期间票数不公开**（2026-09-20 补）。原来界面把"谁现在几票"实时亮出来
  （HUD 一行 `票数：3 号 林晚 2 票 · …` + 投票按钮上的 `2 票` 角标），而投票是**一人一票、投完即定**、
  且引擎是**串行**收票（一人一次 `askHuman`/`askLLM`）——于是"还没投的人"能看着已有票数决定自己投谁，
  等于替别人做决定（你自己那一票尤其明显：点下去之前就知道谁领先）。
  现在的信息边界与**写入口**只有三个字段（`createState` 里定义，`loadGame` 给旧存档补默认值）：
  - `state.voteLive`：引擎内部的实时计数，**任何界面/提示词都不准直接读它**
    （`tallyText()` 因此不再回退到它：`tallyText(state)` 现在返回空串）；
  - `state.voteOpen`：是否正在收票。收票期从 `phaseVote()` 开头（快速模式则提前到 `phaseDay()`
    一开始，因为票是夹在发言里投的）一直持续到本轮**结算完**；平票 PK 重投会**再次**置为 true；
  - `state.voteResult`：**已公开**的本轮结果 `{ day, round, tally }`，只允许在
    "票收完了、结果马上就要公告"那一刻由 `publishVoteResult()` 写入（早了就是泄票，晚了界面会一直停在"投票中"）。
  界面（`ui/werewolf.js`）只认 `publicVoteTally(state)`：`voteOpen` 为真时它返回空，
  HUD 就只写一句「投票中（结果投票结束后公布）」；结算后才写「投票结果：…」。
  夜里/天亮也不显示（那时没有投票在进行，挂一份票数会被误读成跟当前行动有关）。
  平票 PK 是唯一"提前给数字"的地方，而且必须给：公告要说清"谁平票、各几票"，否则没人知道该重投给谁。
  回归守：`tools/selftest.mjs`（`publicVoteTally` / `tallyText` 的盲投断言）与
  `tools/werewolfcheck.mjs` 的 Y 条（摆出"别人都投完了、只等你这一票"的局面真跑一遍：
  收票期间条上/按钮上/HUD 里 0 票数，结算后 HUD 与法官公告才出现票数）。

### 5.11 模型调用卡死：三层看门狗（踩过的坑，"投票投不完＝整局卡死"的根因）

**症状**：狼人杀走到投票，法官喊"请投票放逐一名玩家"之后就再也不动了，刷新页面回来还是停在那儿，
看起来像死循环。**根因不在投票逻辑**（平票 PK 只有一轮，重投再平票就"本轮无人出局"收尾，
12 人局跑满也只走有限步），而是**某一次模型调用永远不返回**：

- 旧版 `core/llm.js` 的空闲看门狗（`DEFAULT_TIMEOUT_MS = 120s`）**每收到一个字节就重置**（`readSSE` 的
  `onActivity`），而 `readSSE` 又把 SSE 心跳（`: ping`）当"无内容"忽略 —— 于是中转站/网关只要
  周期性发心跳，看门狗就被无限重置，调用**永不返回也永不报错**。
  实测（`chatStream` 的 `timeoutMs` 设 1.5 秒、观察 6 秒）：静默流 1.5 秒被掐断；
  心跳流（每 300 ms 一个心跳，客户端实际收到 19 个）6 秒后仍挂起 —— 即"永久挂起"。
- 现在共用的模型调用层只在收到正文或推理增量时重置空闲计时，并设整次请求总时限；
  `tools/llm-timeout-check.mjs` 验证心跳、慢流、推理、总时限与主动停止。
- 投票是**一人一次调用串行**的，12 人局就是 10 次串行调用，任何一次挂住都等于整局停住。

**修复是三层的，缺一层都不够**（`core/werewolf.js`）：

1. **单次调用看门狗**（`askTimeoutMs`，默认 60 秒）：在 `askLLM` 里自己起计时器 abort。
   计时是**收到新内容就重置**（`chatStream` 的 `onDelta` 回调里重新计时），不是"整次调用总时长"——
   本地大模型首字慢、吐字也慢是正常的，总时长硬上限会把**正在正常生成**的发言误杀成"这次没回应"。
   实测：6 段内容、总 4.8 秒（远超 2 秒上限）的慢流被完整保留（"字1…字6"，`missStreak` 仍是 0）；
   而只发心跳的调用在一个上限内被掐断。
2. **掐断后不再重试非流式**：被看门狗掐断（`chatStream` 返回 `aborted: true`）说明供应商收下了请求却
   不吐字，换非流式几乎同样装死。实测每次白等从 2×上限降到 1×上限（2.00 秒）。
   **注意别把关：**"只支持非流式"的中转是**报错**（400），不是掐断，所以仍会照旧回退到非流式并拿到内容
   （回归用例里专门守这条）。
3. **连续没回应就降级等待**（`askStallMs`，默认 15 秒；连续 `ASK_STALL_AFTER = 2` 次触发）：
   跨调用累计 `missStreak`，任意一次正常返回立刻清零并恢复 60 秒等待。
   实测降级后单次从 2.00 秒降到 0.70 秒，且第五次正常返回后 `missStreak` 归零、等待上限回到 2000 ms。
   挨着的 `voteBudgetMs`（默认 5 分钟）是最后一道：投票阶段总预算用尽就把没投的按弃票算，
   **保证"投票一定会结束"**（实测 8 人局、每次投票调用慢 2 秒、预算 3 秒：只问到第 2 个人就收尾，
   1 张弃票，整局照常走完）。这个预算是**普通投票与平票 PK 重投各一份**（`voteDeadline` 声明在
   `if/else` 外面、进 PK 时重新计时）—— 两段都是"一人一次调用串行"，所以都要有上限；但**共用一份会把好局判坏**：
   供应商只是慢（不是挂住）时普通投票就能把预算吃光，共用的话 PK 一开场就超时、一个人都问不到，
   变成"该 PK 却没 PK"。踩过两次：① 一开始只给普通投票那段设了预算，PK 那段完全没有上限；
   ② 后来改成两段共用一份，又变成 PK 被饿死。回归用例 G 在**应用副本上做过 A/B**：共用预算 6/6 次
   "重投 0 人、本轮无人出局"，各一份 6/6 次"重投问到 2 个人"。
   预算用尽而中断时法官台词也要说准：一张票都没投到时说"投票等待超时，本轮无人出局"
   （而不是"本轮全部弃票"，那会让人以为大家都主动弃票了），PK 重投同理。

三层的分工：1 管"这一次别永久挂住"，2 管"别为一次已经挂住的调用再等一遍"，3 管"供应商整体挂了时整局还能走完"。

**这轮改动特意复核过的风险面**（都写进了 `tools/stallcheck.mjs`，13 条）：

- **续玩**（H）：投票投到一半刷新页面 → 走 `loadGame()` + `new WerewolfGame({ state })` 这条真实路径接着投，
  已投的票不会被重复问；新增的计时器/`missStreak` 全是内存态，不落盘、不影响存档格式。
- **暂停**（I）：挂住的调用进行中按暂停，2.5 秒内状态完全不变；继续后照常走完（`gate()` 也在每次提问前）。
  而且**暂停的时间不算进投票预算**（M）：`gate()` 返回"这次因为暂停等了多久"，投票/PK 两段各自把它加回截止时间。
  不这么做的话，预算只有 5 分钟时"按个暂停去接杯水"再回来，这一轮会把还没投的人全按弃票算
  —— 实测（预算 600ms、暂停 2 秒）不还时间时"7 人在场问了 0 人"，还时间后"7 人在场问满 7 人"。
- **真人回合**（J）：**真人不会被任何超时跳过**（实测真人想 3.5 秒 > 单次上限 1.2 秒，引擎照等；只对模型调用计时）。
- **结束本局**（K）：挂住时点结束，`run()` 在 0.12 秒内收尾、`controller` 清空、无未捕获异常。
- **极速模式**（L）：`fastMode` 走 `s.fastVotes`，不经过上面这些计时器，整局正常结束。
- **慢模型的误杀**（B）：计时按"有没有新内容"重置，实测 5 段内容、总 4.8 秒（远超 2 秒上限）的慢流被完整保留。
- **只支持非流式的中转**（D）：掐断才不重试；接口**报错**（400）仍会自动回退到非流式并拿到内容。
- 一个取证时的坑：`voteBudgetMs: 0` 会被构造函数的 `|| 默认值` 兜回 5 分钟（0 是 falsy），"极小预算"要写 1ms。

回归用例：`node tools/stallcheck.mjs`（14 项，假供应商 + 真浏览器，离线可跑）。
跑之前注意：这套用例里有多条"墙钟耗时"断言，机器被别的进程（比如另一个 agent 在跑测试）占满时，
`Runtime.evaluate` 会整体超时（实测连片报 `CDP 调用超时`，而同一条用例在机器空闲时 8/8 精确通过）。
工具对这种情况只做一件事：**刷新页面后把该用例重跑一次**（断言失败绝不重试，重跑会在输出里标注），
并用 `STALL_DEBUG=1` 可以打印每条用例后的健康检查（页面响应耗时 / 未关闭连接 / 未清理的心跳定时器）。

---

### 5.12 三条"用户能直接感知"的坑（都有回归用例守着）

**① 导入备份后群消息一刷新就消失**（`core/store.js` 的 `importAll`）

启动同步是"以磁盘为准"：`syncOnBoot` 在盘上有角色时会先 `wipeLocalOnly()`、再按
`characters/`、`messages/`、`groups/`、`groupmsgs/` 回填。因此**任何"只进 IndexedDB、没落盘"的写入，
都会在下次启动时被抹掉**。`importAll` 原本给角色、私聊消息、记忆、群资料都调了 `mirror*`，
唯独漏了群消息（`appendGroupMessagesBulk()` 是"不镜像"的批量写入），于是：
导入后群消息在页面上看得见，一刷新 `syncOnBoot` 把本地库清空重建，盘上没有 `groupmsgs/<群id>.ndjson`
的群就被回填成空群 —— 群还在、消息全没了。

- 修法：导入完成后按群分组调 `mirrorGroupMessages(groupId, list)`，并 **`await`**
  （角色/私聊那两处是 `void`，但导入是用户主动发起的一次性动作，返回前必须写完盘，
  用户立刻刷新也不能丢）。
- 同一个坑的另一半在 `wipeAll()`：它原来是 `void mirrorWipeAll([])`（不 await），
  而"覆盖导入"（`merge:false`）紧接着就要往磁盘写新数据 —— 那次整库删除晚一步到达，
  就会把刚写进去的文件再删掉。现在 `wipeAll()` 会 `await mirrorWipeAll([])`
  （文件存储不可用时 `mirror()` 立刻 `resolve(false)`，不会挂住）。

回归用例：`node tools/dbcheck.mjs` 第 7 节（导入 → 落盘检查 → **刷新页面** → 群消息仍在）。

**② 非 OpenAI 云端语音：发错密钥 + 请求错服务商**（`voice/tts.js` 的 `cloudConfig` / `fetchCloudAudio`）

直连模式的 `apiKey` / `baseUrl` 原来是
`v.apiKey || keys[provider] || keys.openai` / `v.baseUrl || urls[provider] || urls.openai`，
最后那一级是**跨供应商回退**：选了 Qwen 又没填 Qwen 密钥时，一把 OpenAI 的密钥会被发到
DashScope 的接口上（既泄露密钥，又必然 401 —— 用户看到的就是"云端语音播放失败"）。
现在密钥与地址**只认所选供应商**：`apiKeys[provider]` → 拿不到就留空，
地址再退到 `PROVIDERS_META[provider].baseUrl`（官方地址），`custom` 没配地址则留空并由
`fetchCloudAudio()` 抛中文错误（"请在设置 → 语音里填写接口地址"）。
直连前还会先校验"缺地址 / 缺密钥"，不再把上游的 401/404 甩给用户。

代理模式的另一半：客户端原来只送 `{ text, voice, model, rate }`，而 `server.mjs` 的
`handleTTS` 写死了 `UPSTREAM[provider]?.baseUrl || 'https://api.openai.com/v1'` ——
于是"选了 Qwen / 填了自建反代地址"在代理模式下被**悄悄改成 OpenAI**。现在客户端把
`provider`（以及用户配的 `baseUrl`）一起送上，服务端按 `provider` 取密钥、按 `baseUrl` 覆盖上游地址
（与 `/api/llm` 同一套：地址优先客户端给的 → 供应商默认值；`ollama` / `lmstudio` 不要求密钥；
地址必须以 `http(s)://` 开头）。

回归用例：`node tools/selftest.mjs` 的 7.6 节（`cloudConfig` 的供应商/密钥/地址矩阵）；
`node tools/e2e.mjs` 第 6 节（客户端请求体带 `provider`+`baseUrl`；再直接打真实 `/api/tts`，
用假供应商核对"请求确实发到了所选地址、且带的是那个供应商的密钥"）。

配套的可用性修复：`speaker.speak()` 按设计**永不 reject**（云端失败静默降级到浏览器内置），
所以"试听"按钮原来既 catch 不到、也不显示原因，用户只看到"点了没反应"。现在
`ui/shared.js` 的 `captureVoiceError(cfg)` 会挂上 `cfg.onError` 把真实原因取回来，
设置面板与角色卡编辑器的"试听"都会 `toast('云端语音失败：…')`（缺密钥 / 缺地址 / 上游报错一目了然）。

**③ 上下文预算分项加起来大于 total（记忆被算两遍）**（`core/prompt.js` 的 `buildMessages`）

记忆摘要与事实是**装进 system 提示词**的（`buildSystemPrompt` 第 8 节），已经含在 `sysTokens` 里；
但 `meta.breakdown` 又把记忆单列一条，于是"角色人设与准则"和"记忆摘要"各算了一遍，
分项之和 = `total` + 记忆 token。用户看到的就是"分项数字对不上"（设置 → 上下文预算）。

- 修法：照 `buildSystemPrompt` 的原样（同样的前缀、同样 `slice(0,30)`）拼出记忆那一段，
  把它的 token 从 `sysTokens` 里减掉作为"角色人设与准则"，记忆单独成项 ——
  **`breakdown` 各项之和恒等于 `meta.total`**（这也是回归用例的断言）。
- `core/group.js` 的 `buildGroupMessages` 没有这个问题（它把人设与记忆合在"人设与群聊规则"一项里，
  不单列记忆），改动时别在那边补一条"记忆摘要"项，否则同样会重复计算。

回归用例：`node tools/selftest.mjs` 的 "buildMessages：分项之和等于 total"。

---

### 5.13 访问控制与写盘的坑（`securitycheck.mjs` 守着）

**① 静态路径保护：必须先归一化再判断。**

`serveStatic()` 原来是"先拿原始路径做敏感路径正则，再 `path.normalize` 落地"：

```js
let rel = decodeURIComponent(urlPath.split('?')[0]);
if (/^\/data\/db(\/|$)/.test(rel) || rel.startsWith('/.env')) { 403 }   // ← 判断的是原样路径
const target = path.normalize(path.join(ROOT, rel));                    // ← 这里才折叠 ..
```

于是 `/x/../.env.example`、`/x/../data/db/settings.json`、`//data/db/settings.json`
（多重斜杠让 `^\/data\/db` 匹配不上）都能**先绕过检查、再被归一化到真实文件**，正常返回 200 ——
`data/db/settings.json` 里存着 API Key，`.env` 里是供应商密钥。

现在统一走 `normalizeUrlPath()`（解码 → 统一分隔符 → `path.posix.normalize`）→
`path.resolve(ROOT, '.' + rel)`（带分隔符的前缀校验）→ `isProtectedPath(相对路径)`，
且在归一化**之后**判断；非法百分号编码（`/%zz`）直接 400（以前会抛异常变成 500）。
点文件/点目录（`.env`、`.gitignore`、`.DS_Store`…）、`data/db/**`、`tools/**` 一律不通过 HTTP 暴露，
`data/models.js` 这类应用模块照常可读。**判定顺序是这条的关键，别再改回去。**

**② 非本机请求必须带口令（`AICHAT_PROXY_TOKEN`）。**

`guardApi()` 只判断 Origin，而"不带 Origin"（curl、脚本、任意非浏览器客户端）一律放行 ——
于是 `--host 0.0.0.0` 时局域网上任何设备都能 `GET /api/db/state`（含设置与密钥）或
`POST /api/db/wipe {force:true}` 清空整库；`AICHAT_PROXY_TOKEN` 当时只管 `/api/llm`。

现在：

| 来源 | 行为 |
|---|---|
| 回环（127.0.0.1 / ::1） | 一律放行（本机就是信任边界，桌面端与测试脚本零改动） |
| 非回环 + 服务器没配 `AICHAT_PROXY_TOKEN` | **403 `remote-needs-token`**，响应里写明怎么开 |
| 非回环 + 配了口令 | 必须带对口令（`X-Aichat-Token` / `Authorization: Bearer` / `?token=` / Cookie），否则 401 `bad-token` |

口令还负责 `/api/llm`、`/api/tts`、`/api/db/*` 全部接口；`GET /api/health` 对非本机只回 `{ok:true}`。
`guardApi()` 里顺序是 **先 Origin（防 CSRF）后口令**：跨站页面即使拿到口令也进不来。

局域网浏览器不必手填口令：`GET /?token=<口令>` 会种一个
`aichat_token=…; HttpOnly; SameSite=Strict` 的 Cookie（口令正确才种），
之后页面里的同源接口请求自动带上。同一套逻辑顺带修掉了"手机用 `192.168.x.x` 打开时所有接口 403"：
`isTrustedOrigin()` 现在拿 Origin 的 host 与**请求的 Host** 比（同源即放行），
而不是拿它去比 `--host` 的值（`0.0.0.0` 永远对不上真实局域网 IP）。

**③ 客户端指定的上游地址必须与凭据绑定，写盘只写"确实待写"的字段。**

- `/api/llm` 与 `/api/tts` 都接受请求体里的 `baseUrl`（自定义反代是正常功能），
  但服务器会把自己的 Key 附上去 —— 等于"调用方可以让服务器带着 Key 去请求任意地址"。
  现在：非本机请求先被 ② 挡住；此外可用 `AICHAT_ALLOWED_UPSTREAMS` 显式列出允许的地址前缀，
  不在列表内一律 403 `upstream-not-allowed`，且**不会向上游发出任何请求**。
- `core/filestore.js` 的待写队列曾把 `null` 当成"有待写 runtime"：
  `mirrorSettings()` 里 `(statePayload && statePayload.runtime)` 在 `statePayload` 为 `null` 时得到
  `null`，而 `sanitizeRuntime(null)` 返回 `{}` —— 于是一次"只改设置"的写入也会带上 `runtime:{}`，
  服务端看到 truthy 就把 `runtime.json`（好感度 / 未读）整份覆盖成空对象。
  现在合并前先把 `null` 归一成 `{}`，两处发送（去抖定时器 / 关窗兜底 `flushStateNow`）共用
  `hasRuntimePayload()` 判断，没有待写内容就**不带该字段**；服务端也按"字段存在且是对象"才覆盖
  （显式传 `{}` 仍表示清空，清库时用得到）。
  注意：浏览器 localStorage 里仍有副本，启动时会合并回去，所以这个坑**不会**在普通刷新时立刻显现 ——
  清站点数据或换浏览器才会发现丢进度，这也是它藏得久的原因。
- `wipeAll()` 现在返回 `{ ok, fileOk, fileError }`："浏览器已清、磁盘没清掉"会被
  `ui/settings.js` 如实报出来，而不是无条件弹"已清空全部本机数据"
  （磁盘清空失败时旧数据会在下次启动被回填）。

---

### 5.14 其余踩过的坑：空群 / 语音缓存 / 上游断开 / 草稿（都有回归用例）

**① 零成员群必须活得下来**（`core/store.js` 的 `importAll`、`core/filestore.js` 的 `syncOnBoot`）

删角色会把它从所有群里摘掉（`pruneGroupMembers`），成员被删光的群就是**零成员群** ——
这是产品里的合法状态，群资料、主题、接话策略与 `groupmsgs/<群id>.ndjson` 都还挂在它上面。
两个地方曾经把它弄丢：

- `importAll` 里写着"成员 0 个也合法"的注释，代码却是 `if (!g.members.length) continue;` ——
  备份里的空群被整个丢掉（连它的聊天记录也一起没了）。现在照常入库。
- `syncOnBoot` 以"磁盘上有角色"为整体回填的判据。角色全被删掉后盘上只剩群文件，
  判据不成立 → 清掉浏览器数据再打开就什么都回填不出来，群看着就消失了。
  现在判据是"盘上有角色**或**有群"；另外补一条：**盘上只有群、本地还有角色**时不整体回填
  （否则会把本地那些还没写盘成功的角色冲掉），交给"把本地推上盘"那条路。

回归用例：`node tools/dbcheck.mjs` 第 7.5 节（删光成员 → 清浏览器数据 → 重开 → 群与 2 条记录都回填；
备份导出/导入也不跳过空群）。

**② 云端语音的磁盘缓存打不开**（`voice/tts.js` 的 `openDB`）

主库 `aichat` 由 `core/store.js` 以 **v2** 创建（角色/消息/记忆/用量/群聊 + `ttsCache`），
而 tts.js 写的是 `indexedDB.open('aichat', 1)` —— 用**较低版本**打开一个已存在的库会直接
`VersionError`，`dbFailed` 被置位：**磁盘缓存永远打不开**。症状是刷新后每句云端语音都重新请求
（更慢、更贵），"清空缓存"也只清得掉内存里那一份。现在不传版本号（库在就按当前版本打开，
库不在就新建 v1 并由 `onupgradeneeded` 补表）；万一库里确实没有 `ttsCache` 表，
就老实降级成"只用内存缓存"，绝不报错、绝不抢版本号。

回归用例：`node tools/e2e.mjs` 第 6 节的"磁盘缓存能写入也能清空"（断言主库版本 2、写入 ≥1 条、清空后 0 条）。

**③ 客户端取消后上游必须被掐断**（`server.mjs` 的 `handleLLM`）

以前上游 `fetch` 没接取消信号：用户点"停止"、关页或切会话后，服务器还在原地读上游的流 ——
上游继续算 token（白花钱），连接与额度也一直占着。现在用一个 `AbortController` 同时驱动
"掐上游"与"跳出转发循环"，触发条件是 `req` 的 `aborted`/`close` 与 **`res` 的 `close`（且
`!writableEnded`，用来区分"我们把响应写完了"和"对端提前走了"）**；客户端自己断开造成的
fetch 失败不再当成 502 报错，也不再往已关闭的响应上写。

回归用例：`node tools/e2e.mjs` 第 6 节的"客户端取消后上游连接被切断"（假上游在 `res.on('close')` 里记一笔）。

**④ 入库失败必须留下用户打的字**（`ui/chat.js` 的 `doSend`、`ui/groupchat.js` 的 `sendCurrent`）

两条发送路径原来都是"**先清空输入框与草稿、再保存**"：一旦 `appendMessage` 失败
（IndexedDB 写不进去、配额满、连接被关），就只剩一个 toast，用户刚打的那段话凭空消失。
现在单聊在 `doSend` 的 catch 里、群聊在 `appendGroupMessage` 成功之后才清空；失败时把原文写回
输入框与草稿（并恢复引用条），提示语也改成"内容已留在输入框"。

回归用例：`node tools/dbcheck.mjs` 第 7.5 节的单聊/群聊两条（把 `store.openDB()` 的连接关掉
来模拟写失败，断言输入框与草稿都留着原文）。

**⑤ 诊断工具自身的可靠性**（`tools/cdp.mjs`、`tools/stallcheck.mjs`、`tools/aligncheck.mjs`）

- `Cdp.send()` 的超时定时器从来不清理：一次狼人杀用例上千条命令，每条都留一个 120s 定时器，
  一直堆在事件循环里（拖慢墙钟断言、退出前还得挨个等）。现在响应/出错都会 `clearTimeout`。
- 超时后只 `reject` 是不够的：页面里那段脚本还在跑，它占着页面与定时器不放，**下一条用例跟着超时**
  （"一超时就连片超时"的来源）。现在超时会额外发一条 `Runtime.terminateExecution` 让浏览器停下
  当前执行（失败忽略）。超时时长可用 `new Cdp(ws, { timeoutMs })` 覆盖，默认仍是 120s。
- `freePort()`（`tools/cdp.mjs` 导出）：让系统分配一个空闲端口再释放，测试脚本不再靠
  "基址 + 随机数"在窄端口段里撞 `EADDRINUSE`。**整套工具都改用了它**（服务端口、假上游端口、
  以及无头 Chrome 的 `--remote-debugging-port`）：e2e / dbcheck / groupcheck / uicheck /
  stallcheck / werewolfcheck / affinitycheck / aligncheck / securitycheck / browser-check。
  stallcheck 在启动失败时还会打印服务器输出，而不是只报"等待超时"。
- `tools/aligncheck.mjs` 原来固定 `process.exit(0)`：发现问题也判成通过。现在按
  `problems.length` 返回退出码，CI / 批量跑测试才拦得住布局回归。

回归用例：`node tools/selftest.mjs` 第 7.7 节（CDP 超时兜底 / 定时器清理 / `freePort()` 可用）。

---

### 5.15 冗余代码清理：什么算"残留"、什么算"有意保留的接口"

项目历史上有一批"重构后留下的旧入口 / 旧字段 / 旧别名"，既没有调用方也不影响功能，
但一直占着位置（最典型的是 `ui/editor.js` 里约 300 行的导入/导出弹窗）。**这一节定下判定标准**，
以后遇到同类情况按它办：

| 类别 | 判定 | 处置 |
|---|---|---|
| 界面入口被删/改名后留下的旧实现（弹窗、旧字段写入、旧别名） | 残留 | **删**（连同只被它使用的私有 helper 与 import） |
| 契约文档（本文件 3.x）里明确列出的**工具库成员**（`core/util.js`、`ui/dom.js`、`ui/shared.js`） | 有意保留 | 不删 |
| store / 引擎对外 API（供控制台调试、扩展、测试使用） | 有意保留 | 不删，列进 `audit.mjs` 的 `EXPORT_API_ALLOW` |

**本轮实际删掉的**：

- `ui/editor.js`：`openImportDialog()`、`openExportDialog()`（约 300 行）+ 只被它们使用的
  `buildChatMarkdown()` / `fileSafe()` / `dateStamp()`，以及随之变空的 import
  （`importAll` / `exportAll` / `toSillyTavern` / `importCharacter` / `listMessages` / `download` /
  `fmtDay` / `readFileAsText`）、两个从来没人用的常量（`TAGS_LIMIT` / `EXAMPLES_LIMIT`）和一条孤儿注释。
  → 同时更新了本文件 3.14 的契约条目与 `tools/selftest.mjs` 的导出契约清单。
- `core/werewolf.js`：旧别名 `guardWolfConfession()`（方法体就是 `return this.guardWolfSpeech(...)`）。
- `ui/shared.js`：`charEmoji` 别名（`entityEmoji` 的旧名字）+ 本文件 3.17 里对应那一行。
- `ui/settings.js`："主动性"开关里那条写 `context.proactive` 的兼容写入（该字段早已无人读取）。
- `ui/sidebar.js`：文件头注释里"底部：统计条 + 数据备份 / 导入 / 导出 快捷入口"（入口早已移除）。

**保留**（零调用是有意的，已写进 `tools/audit.mjs` 的豁免表，不再报噪音）：
`core/store.js` 的 `getMessage` / `resetSettings` / `deleteMessages` / `apiKeyFor` / `baseUrlFor` / `chatVolume`、
`core/group.js` 的 `memberEmoji`、`ui/toast.js` 的 `hasOpenModal` / `closeAllModals`、
`core/proactive.js` 的 `triggerNow`；三个标准工具库整块豁免。

**工具侧的防复发**：`tools/audit.mjs` 新增第 7 节规则——
1. **导出的**函数/常量/类若全项目没有调用点 → warning（第 6 节的老规则只查"**非导出**的顶层 function"，
   而这批残留恰恰全是导出的，所以以前查不出来）；
2. 类方法若整个方法体只是 `return this.某方法(...)` 的旧别名、且没人调用 → warning。

两个容易搞错的地方也在代码里注明了：统计引用要**把 `tools/` 算上**（备份导入导出这类能力只被测试用到，
仍属"有人用"）；同时要**摘掉 `selftest.mjs` 里那张导出契约清单**——那里的名字只是字符串，
会让"只有契约在要求、实际没人调用"的死代码看起来像有人用（弹窗藏了十几个版本正是这个原因）。

回归方式：`node tools/audit.mjs` 应为 0 阻断 0 警告；往任一非工具库模块里塞一个没人调用的
`export function`，它必须报 warning（已按此法反向验证）。

### 5.16 狼人杀的输出观感：流式 + 增量插入，两个都漏了就和普通聊天不一样

**症状**（一眼能看出来）：普通聊天里字是一个个出来的、出新消息列表也不跳；
狼人杀里发言是**一整句突然蹦出来**，而且**每出一条屏幕就跳一下**。两个根因是独立的：

1. **引擎把流式内容自己攒着**：`askLLM` 走的是同一条 `chatStream` 链路，但 `onDelta` 只用来
   重置"安静看门狗"（见 5.11），delta 从不往界面传；攒够了一次性
   `appendGroupMessage({ game: 'werewolf', status: 'done' })`。
   修复：`askLLM(player, prompt, kind, { live: true })` 把增量交给 `handlers.onSpeechLive(player, full)`，
   由 `ui/werewolf.js` 的 `speechLiveEvent()` 转成 bus 事件 `werewolf:speech`，
   `ui/groupchat.js` 用**普通群聊那套临时气泡**（`createStreamNode` + "正在输入…"）显示。
   - **只给"公开发言"开**（白天发言 / PK 发言 / 遗言）：夜间行动、投票、猎人开枪是私密指令，
     把 `刀杀：3号` 这种半截命令画到聊天页上只会打扰人，而且它们本来就不该被别人看到。
   - **推的是"预览正文"而不是原文**：模型原文里还有 `投票：<编号>号` 这类格式行
     （落库前会被 `splitSpeechAndVote()` 拆掉），直接显示会先冒出来再消失。
     `liveSpeechPreview(raw)` 按同一套规则裁掉格式行，且对**最后一行**更宽容（写到一半的票先不显示）。
     selftest 用一个不变式守着它：**任何前缀的预览都必须是最终正文的前缀**。
   - 真消息落库时由群聊把临时气泡换成它；中断（结束游戏 / 切群 / 出错 / 局终）时
     `ui/werewolf.js` 推 `{ off: true }` 收掉气泡，否则会留一句没说完的话挂在聊天页上。
2. **狼人杀的消息走了"整块重绘"**：此前 `renderMessages()` 在 `clear(listEl)` 后整列表重建，而 `.msg` 上挂着
   `animation: msgIn .22s`（`styles/app.css`）——重建等于**所有气泡重播一遍入场动画**，滚动位置也被顶回去。
   普通群聊本来有增量路径（`onTurnDone` 只 append 新气泡），但**狼人杀不走 `GroupRound`**
   （它的 `busy` 永远是 false），消息从 store 的 `gmsg:appended` 进来，
   于是每条法官公告/发言都落到 `scheduleRefresh()` → `renderMessages()`。
   修复：`gmsg:appended` 里对 `game === 'werewolf'` 的消息走 `appendItemIncremental()`
   （入列 + 按需补日期分割线 + 只 append 这一条 + `syncJumpButton()`）；
   🔒 私密提示（`appendGroupNotice`）同样改走增量 —— 它一局里出现得很频繁，跳一下特别显眼。

**回归守**（`tools/werewolfcheck.mjs`）：

- **V 条**：页内装 `MutationObserver`，（a）数"同一批里清掉 ≥2 条气泡"= 整块重绘，要求 **0 次**；
  （b）记录每条临时气泡的文字变化序列，要求同一气泡里观察到 ≥4 次变长、且每一步都是最终文字的前缀；
  （c）在"气泡被真消息替换"的瞬间核对两者文字**完全一致**。
  引擎那半边也一起守：真引擎 `speakTurn()` 说一句（`handlers.onSpeechLive` 接的就是
  `speechLiveEvent`，即真链路），要求增量 ≥4 段、投票那一问**一段都不推**、没有发言时推 `null`。
  （模型偶发空回时引擎推 `null` 收气泡是**正确**行为，所以用例会重试到真的说出话，
  断言只看最后那次成功发言的增量段。注意两点，都是踩过的坑：
  ① 重试必须**重新发牌** —— 同一个 `game` 的角色分配是固定的，重试同一局只会拿到同样的结果；
  ② 假模型必须**避开狼同伴**（从提示词的「你的狼同伴：…」那行抠座位号排除掉）。
  否则它猜的对象正好是同伴时，那条发言会被引擎的"卖同伴"兜底整句删掉（只剩一张票 = 这一轮没发言），
  V 用例拿到空手而归、I 用例（真人当狼）还会被同伴刀掉而失去白天回合 —— 实测约 5% 的局会撞上。
  这两条都是**假模型的锅**，引擎那侧的兜底有 H 用例专门守着。）
  - 判据必须**按批**统计：`clear()` 是一个一个 `removeChild` 的，按单条 mutation 记录看永远只有 1 个
    `removedNode` —— 第一版就是这么把"整块重绘"数成了 0（这个坑值得记住）。
  - 假模型为此加了个慢速流开关（`/slowstream`，2 字一包、8ms 一包）：默认假模型一个 tick 就写完，
    界面等于一步到位，观察不到"在长"。用例无论成败都要关掉它（`finally` 里关），
    否则整条链路变慢会把后面的用例拖成 CDP 超时。
- **W 条（对照组）**：2026-10-20 起，普通消息同样使用节点协调，不再作为整块重绘对照。
  先人工移除两条隐藏气泡，要求同款判据数到 ≥1 次，再要求真实普通消息追加时重绘为 0、旧节点保留。
  这条仍用于证明 V 的检测有效，不以放宽 V 的判据来适配优化。

### 5.17 狼人杀"话说一半"：思考与正文抢 `max_tokens`（踩过的坑，`werewolfcheck` 的 W 条守着）

**症状**：AI 角色的发言停在半个词上 —— "…4 号、5 号互相开了一枪，枪口"、"…9 号点了 10 号半句就收，
也软。我这"。落库的那条与上屏的气泡**就是这半句**（不是渲染问题），跟"说完了"长得一模一样，
而且同一局里有人能说完整句、有人只剩半句，看着像随机 bug（切点取决于"这一次思考花了多少 token"）。

**根因是模型调用参数，不在渲染也不在截断逻辑**：

- DeepSeek 的 `reasoning_content` 与正文**共享同一个 `max_tokens` 预算**。`askLLM` 以前只对夜间行动
  关思考（`...(kind === 'night' ? { thinking: false } : {})`）：白天发言 / 遗言 / 猎人开枪（`'day'`）
  与投票（`'vote'`）都没关，`params.thinking` 为 `null` 时 `core/llm.js` 与 `server.mjs` 都**不会下发**
  这个字段，于是按**模型默认（思考开）**跑。
- 一句 1~3 句的发言根本用不着思考，而思考常吃掉 400~600 token；600 的额度被吃光后正文就被从中间切断。
  实测（真实 DeepSeek，与引擎完全同参数）：`completion = 600` 撞上限、`finish_reason = "length"`，
  思考 758 字而正文只剩 43 字，另一次正文直接为空；同一条提问加上 `thinking: false` 后 730ms
  返回完整正文（快 5 倍、便宜 10 倍）。夜间那条注释早写过这件事（220 token 会被思考吃光），
  白天这条链路只是漏了。
- **截断完全没人发现**：整条链路以前把 `finish_reason` 丢掉了（全仓 `grep finish_reason` 零命中），
  而 `askLLM` 的"没内容才重试"只看 `!text` —— 半句话是非空文本，于是被当成完整发言直接落库。

**修复两条，缺一条都不够**：

1. **整局关思考**：`askLLM` 的 `thinking: false` 从"仅夜间"改成"所有 `kind`"。
2. **识别并处理截断**：`core/llm.js` 每种协议解析器补 `finish(obj)`（OpenAI `finish_reason`、
   Anthropic `stop_reason`、Gemini `finishReason`、Ollama `done_reason`），`chat()` / `chatStream()`
   一并返回 `finishReason` 与 `truncated`（`isTruncatedFinish()`）；`askLLM` 收到截断时
   **先用双倍额度重问一次**（600 → 1200，仍走流式，公开气泡会被新内容自然覆盖），
   重问仍被切就保留更长的那个，再用 `markTruncatedTail()` 在结尾补"……"。
   判据收在 `needsUnfinishedMark()` 一处：**以汉字收尾**才算没说完（正常收尾是句读，实测也有角色以
   "且尽此杯。🍶"这种表情收尾），结尾本身是一行完整指令（"投票：3号 / 刀杀：5号"）时不算。
   同一个判据也用在**看门狗掐断**这条路上：掐断前已经吐出的半句同样标注"没说完"
   （掐断仍然不重试，理由见 5.11 的第 2 层）。被截断/被掐断只写 `debug`
   （`log` 是公开信息，会被拼进所有角色的提示词）。代理模式同理：
   `server.mjs` 的 SSE 转发补上了 Anthropic 的 `stop_reason` 与 Gemini 的 `finishReason`，
   否则走代理时客户端拿不到截断信号。

**回归守**：`werewolfcheck` 的 W 条（假模型 `/truncate`：`soft` = 只切第一次 → 必须重问并采用完整版；
`hard` = 连重问也切 → 必须留半句并补"……"；同时核对狼人杀的每一次调用都带 `thinking: disabled`），
加上 `selftest` 的五条（`isTruncatedFinish` 口径、`chat()`/`chatStream()` 上报截断、
`markTruncatedTail` / `needsUnfinishedMark` 的判据、白天发言"关思考 + 截断重问"、
看门狗掐断时半句照样标注且不重试）。

**注意**：关思考只作用于狼人杀这条链路（`askLLM` 自带 params）；私聊/群聊仍按用户设置走模型默认值。
用户要在聊天里改这个默认值，走设置 → 模型 → 生成参数的「思考模式」三态开关（见 5.19）。

### 5.18 收藏夹（消息上的 ☆ 没有地方统一翻看）

**背景**：消息操作栏里一直有「收藏」（`ui/chat.js` / `ui/groupchat.js` 的 `MSG_ACTIONS`），
收藏后只在气泡上加一行 `.msg-mark` 的"★ 已收藏"——**收藏完就没地方看了**，要翻回去只能自己滚。
现在补上"收藏夹"这一层：左栏工具条（左上角）的 🔖 进入，一条**时间倒序的合并流**，
好友私聊与群聊的收藏都在里面，点一下跳回原消息。

**数据层（`core/store.js`）**：
- `bookmarked` 是**消息自己的字段**（私聊与群聊都有，见 `normalizeMessage` / `normalizeGroupMessage`），
  删消息、清空会话、导出导入、镜像写盘都跟着消息走 —— 所以收藏夹**不需要新表、也不需要新索引**，
  更**不动数据库版本**（加索引要升 `DB_VERSION`，那是一次有风险的迁移，不值得为低频功能做）。
- `listBookmarks()` 把两张表里 `bookmarked` 的消息合并成**统一形状**（`kind` / `id` / `at` / `content` /
  `charId` / `groupId` / `speakerId` / `speakerName` / `game`）并按时间倒序；`countBookmarks()` 只数条数。
  名字（好友名 / 群名 / 发言人）由 UI 侧按 id 去 `listCharacters()` / `listGroups()` 里查，store 只管数据。

**界面层（`ui/favorites.js`）**：
- 入口在 `ui/sidebar.js` 的 `buildHead()`：与「全局搜索」相邻（同一类"翻旧账"的动作），
  标题写着"收藏夹（收藏过的对话）"；面板本身是一个 `modal()`。
- 行内可以**按关键词过滤**（正文 / 来源名 / 发言人），点主体跳转，右侧 🔖 一键取消收藏。
- 跳转复用既有的两条链路（与全局搜索同一套约定，见 5.9）：
  私聊 `bus.emit('chat:focus-message', { id, charId })`、群聊 `bus.emit('gchat:focus-message', { id, groupId })`；
  `ui/app.js` 负责切会话 + 定位。**群聊这条路要额外重试等渲染**：刚 `openGroup()` 完群消息还在异步读，
  所以 `ui/groupchat.js` 对外的 `focusGroupMessage()` 会重试 8 次 × 150ms 再判"这条消息不在当前群聊里"
  （群内搜索那条老路径仍然用同步版，它面对的消息早就渲染好了）。
- 面板开着时监听 `msg:updated` / `gmsg:updated` 跟着刷新（在别处点 ☆ 也能立刻看到），
  关掉后必须退订（`modal()` 没有 onClose 回调，所以用"存活检查 + 定时兜底"退订）。
  会话被删掉的收藏不会静默失败：跳转时明确提示"所属的好友/群聊已被删除"。

**两个排版坑（都踩过，`styles/app.css` 的收藏夹那一段有注释）**：
1. **`.hit` 是 `<button>`，而 base.css 的全局 `button` 规则写着 `white-space: nowrap`** ——
   不在这一行显式改回 `normal`，`.h-text` 的 `-webkit-line-clamp` 完全失效：
   长正文会**一行横向裁掉**（不是省略号，是直接没了）。同一个坑，全局搜索面板也一直中着。
2. 来源名 / 群名 + 发言人 + 时间都**不肯缩也不换行**时，整行会撑破弹层：实测 390px 宽下
   `.fav-list` 横向溢出 167px（"一个名字特别长的群聊" + "名字很长的发言人"）。
   所以这几段要 `flex-wrap: wrap` + `min-width: 0` + 各自 `ellipsis`。

**回归守**：`uicheck`（私聊：左上角入口 → 面板列出收藏 → 点击跳回并高亮 → 取消收藏后 store 里也没了）、
`groupcheck`（群聊：收藏群消息 → 切到好友私聊再点跳转 → 自动切回群并高亮）、
`dbcheck`（私聊 + 群聊合并、时间倒序、取消收藏即时移除、两个 `ndjson` 里都写着 `"bookmarked":true`）。

### 5.19 生成参数里的「思考模式」开关（DeepSeek）

**背景**：5.17 把狼人杀整局的思考关掉了，理由是"思考与正文共享 `max_tokens`"；但**私聊/群聊那条链路
完全没有这个开关**——设置 → 模型 → 生成参数里只有五个滑块（温度/核采样/长度/话题新鲜度/重复抑制），
用户既看不到"现在到底开没开思考"，也没法关。而 DeepSeek 的默认是**开**（5.17 实测），
1024 的额度经常被思考吃掉一半，表现是"回复短、慢、还更贵"，用户只能自己猜原因。

**为什么不是勾选框**：请求级字段（`thinking: {type:'enabled'|'disabled'}`）只有两态，但**"不下发"本身是一态**——
`core/llm.js` 的 `normParams()` 用 `null` 表示"不干预模型默认行为"，`buildOpenAIBody()` 只在拿到布尔值时才写这个字段。
如果用勾选框，"没勾"到底等于"关思考"还是"回到默认"就说不清了（这两种行为对 DeepSeek 恰好相反）。
所以界面给**三态**：`跟随模型默认` / `关闭思考` / `开启思考`。

**落点（三处，各管一段）**：
- `data/models.js`：`THINKING_CHOICES`（选项文案）+ `thinkingChoiceOf(params)` / `thinkingParamOf(choice)`
  ——**映射只此一处**，界面不许自己写 `if`（与 5.17 的 `needsUnfinishedMark` 同一个套路）。
  非布尔值（脏设置、手改备份）一律算 `default`：宁可不下发，也不要因为一个字符串就把请求变成 `enabled`。
- `core/store.js`：`DEFAULT_SETTINGS.params.thinking = null` = 默认不下发（**保持老用户的行为不变**：
  这个功能上线前大家跑的就是模型默认）。
- `ui/settings.js`：`renderThinkingRow(meta, s)` —— 生成参数区的最后一个字段，选完立刻 `patch` 落盘，
  并按当前供应商换提示文案：非 DeepSeek 时点明"这个字段不会下发"（其他 OpenAI 兼容站不认它，
  `server.mjs` 与 `core/llm.js` 都只对 `provider === 'deepseek'` 写这条字段），
  另外写明**狼人杀对局自带关闭、不受这里影响**（5.17 的硬编码优先级更高）。

**生效范围**：私聊 / 群聊 / 主动消息（`core/proactive.js` 会展开 `settings.params`）跟着这个开关走；
**记忆总结**（`core/prompt.js` 自带的 `{temperature:0.3, maxTokens:700}`）与**狼人杀**（`askLLM` 自带 params）
都不看它 —— 与 5.17 的分工一致。参数预设里存了 `thinking` 就会跟着预设一起切换
（`另存为预设` 存的是 `getSettings().params` 的整份拷贝），没存的那几套内置预设**不动**用户当前的思考模式。

**回归守**：`selftest`（三态映射与往返、脏值当默认、`DEFAULT_SETTINGS` 不下发、三态各自的请求体）、
`uicheck`（设置面板里三态可选、写进设置、重开面板回显、选回默认写的是 `null`）、
`e2e`（真链路两条：① 用界面控件选「关闭思考」→ 发一条消息 → **假模型收到的请求体里确实是 `thinking.disabled`**，
选回「跟随模型默认」→ 请求体里没有这个字段；② 直接打服务端 `/api/llm`，**代理模式下 DeepSeek 带 `disabled`、
非 DeepSeek 供应商的同一个 `thinking:false` 被丢掉**）。

### 5.20 顺序发言：前置位不能质问"后面的人怎么不说话"（踩过的坑）

**现象**：白天是**按座位顺序**一个一个说（`phaseDay()` 的循环），可前几位发言的人会去质问**还没轮到**的座位，
最典型的一句（线上原文，8 号发言）：

> 我更想看看 9 号 Iris 怎么接——**被人捞了一整轮还不出声**，这反倒比 1 号更值得记一笔。

9 号排在 8 号后面，**那一刻根本还没轮到它开口**。"一直不出声"在顺序发言里不构成任何疑点，
这是模型把时间线看错了，不是它"演得有问题"。

**根因**：给发言人的提示词里只有两段相关材料 —— `存活玩家：…` 与 `【已经公开发生的事】`
（`publicLogText()`）。前者只给名单，后者只给**已经说过什么**；**没有任何一处告诉它"现在轮到谁、你是第几位"**。
于是模型只能从"公开记录里没有 9 号的声音"倒推，得出"9 号一直躲着"。

**修法（三层，与狼人认狼那套兜底同构）**：
- **① 提示词讲清时间线**（主防线）：新增 `speakOrderFor()` / `speakOrderNote()`，
  由 `dayPromptFor()` 拼在公开记录与【发言要求】之间，内容全部是公开信息：
  本轮顺序（存活玩家按座位升序）／你是第几位／在你之前**已经发过言的是谁**／**还没轮到的是谁**，
  并明写两条禁止项：不要催他们发言、不要把"不吭声 / 不出声 / 不表态"当疑点；
  想听后面的人表态可以说"等 X 号表态"，但不算疑点。【发言要求】里再重复一条短提醒。
  顺序与引擎的循环**同源**：普通发言＝存活玩家按座位升序，PK 发言＝平票座位升序
  （`speakOrderFor` 的 `pkSeats`）；PK 的"已经说过"只能来自 PK 自己那一轮
  （`phaseVote()` 里那个 `pkSpoken` 局部数组），**不能**读 `state.spokenSeats` ——
  那是白天那一轮的记录，PK 时全场都已经说过话了。
- **② 检测 + 纠正重说**：`looksLikeSilenceUrge(text, state, me, opts)` 只在
  "**点名了还没轮到的座位**（座位号或名字）**且**出现沉默/催促用词"时判真；
  句子里带"昨天 / 上一轮 / 第 N 天"这类时间标记时一律放过 ——
  "5 号昨天一整轮都没怎么说话"是**对过去几轮的正常复盘**，不能误伤（宁可少判）。
  命中后 `guardSilenceUrge()` 点名纠正重说一次（与 `guardWolfSpeech()` 一致，重说不再推流）。
- **③ 删句兜底**：重说还犯就把那句删掉（`stripSilenceUrge()`，投票行单独保留）；
  整段都在催才换成一句不违规的场面话。**人类玩家不受任何限制**（你想怎么问都行）。
- 没有权威"谁已经说过"记录时（直接拼提示词的调用方、老存档），`speakOrderFor()` 按顺序发言的
  **常态**推断（前面的人说过了、后面的还没轮到），而不是写成"你是第一个发言的人"这种假话。
- **遗言不在覆盖范围内**：`lastWordsPromptFor()` 不带这一段、也不过 `guardSilenceUrge()`
  —— 遗言发生在"天亮公布死讯"与"被票出结算"两个时刻，与"本轮按座位顺序发言"无关，
  它的提示词本来也只让当事人谈自己的事。日后若遗言里也冒这类句子，接同一条兜底即可。

**回归守**：`tools/selftest.mjs` 5.7 的三条用例（顺序说明的措辞与 PK 分支／检测与删句的
不误伤边界／引擎层"纠正重说 → 删句 → 场面话"三步，含"人类玩家不被改写"与 PK 提示词的顺序），
以及 `tools/werewolfcheck.mjs` 的 **Z 条**（假模型故意照提示词里的"还没轮到的"去踩那一位：
每次发言提问都要带【发言顺序】/「你是第 N 位」/「身后的人还没轮到」，引擎必须拦下，
群里 0 条"催沉默"，兜底记录只进 `debug`）。

---

### 5.21 数据一致性与长聊天性能（2026-10-20）

详见 [修改记录](BUGFIX-2026-10-20.md)，回归入口为 `node tools/optimizationcheck.mjs`。

- 消息及群消息的读、改、写在同一事务内完成；群消息编辑不得改变原听众。角色与群资料保存也在同一事务内校验浏览器版本、更新记录。
- 角色卡和群资料镜像携带 `base`（编辑前快照）及 `data`（编辑后快照）。`core/entity-sync.js` 三方合并实际改动字段；不相交的字段自动合并，同字段不同值返回 HTTP 409。服务端版本、更新时间与角色历史按实际提交结果维护，重复重放不重复增加版本。
- 老队列不带 `base` 时仍兼容读取和创建；双方都有版本号时，旧版本整卡覆盖会被拒绝。无版本号的旧格式接口仅作兼容，不提供完整的多端冲突保护。
- 冲突操作保留在持久队列，浏览器草稿和电脑文件均保留。侧栏底部的「资料有冲突」打开两端内容对照；用户可保留电脑版本，或只将本次修改的字段合并到最新电脑版本。队首修改与其他窗口同步共用锁，处理完继续重放并重新载入。
- 设置中的「立即同步」走待同步队列与回填流程，避免用旧浏览器快照整体覆盖另一端更新。`syncNow()` 保留为明确的整库替换接口，供兼容、迁移和测试使用。
- `replaceLocalSnapshot()` 在 `characters/messages/memory/groups/groupMessages` 五表事务中一次提交；不清理用量、音频缓存或运行时状态，也不会为回填记忆额外发起镜像写入。
- 侧栏通过既有的拥有者索引和复合时间索引读取每个会话的末条消息与数量，不读取全部正文。`listConversationStats()` 合并提供私聊和群聊摘要；旧查询接口保留。
- 聊天界面初次读取最近 100 条，点击「加载更早的消息」每次扩展 100 条。搜索、收藏与引用跳转可扩展到目标消息；同时间戳按 IndexedDB 的字符串主键顺序排列。过期的异步分页结果不得覆盖新会话。
- `ui/message-list.js` 按稳定键协调节点，只替换变化的气泡。私聊与群聊共享分页和节点协调实现；狼人杀发言仍增量显示。模型生成、摘要与导出读取完整历史，不依赖界面已加载条数。
- NDJSON 首次超过 2MiB 时压实；之后新增至少 `max(2MiB, 压实后体积的一半)` 才再次压实，避免有效内容超过 2MiB 后每次追加都整文件重写。
- 主库版本仍为 2，无数据格式迁移；Service Worker 更新至 `aichat-v56`，补齐新增共享模块预缓存。

## 6. 验收标准（自测清单）

1. `node server.mjs` 后打开 `http://127.0.0.1:5180` 无控制台报错。
2. 左侧好友列表出现内置人设（≥30），可点击切换，每个角色独立聊天记录。
3. 未配置密钥时，"设置 → 模型"给出明确引导；配置后能流式收到回复。
4. 角色可新建/编辑/命名/删除，刷新后仍在（IndexedDB）。
5. 消息：编辑、重新生成（多版本切换）、删除、复制、收藏、引用回复可用。
6. 语音：角色回复时逐句朗读，可打断；音色可按角色选择并试听。
7. 搜索：跨角色/单角色搜索命中并跳转；群内搜索同样可用。
8. 导出全部数据为 JSON 并能重新导入还原（含群聊与群消息）——**在 store 层验证**
   （`exportAll` / `importAll`；界面上的导入导出入口已按需求移除，见 5.15）。
9. 深色/亮色切换正常；移动端单栏可用。
10. 所有模块 `node --check <file>` 语法通过（ES module 用 `node --input-type=module --check`）。
11. **群聊**：左侧「群聊」区可新建群聊并拉 ≥2 位角色进群；群里说话能被多角色接话；
    被 @ 的角色先开口；"让他们自己聊"能在没有用户输入时继续往下聊；
    生成中可随时打断；刷新页面后群聊与记录仍在；`app/data/db/groups`、`app/data/db/groupmsgs` 有对应文件。
    （`node tools/groupcheck.mjs` 会逐条验证上面这些。）
12. **收起顶栏 / 右栏**：顶栏工具区最右的 ^ 收起后顶栏（群聊含成员条）消失、顶部留 14px 细拉手（与竖拉手同宽）、消息区变高，点拉手能拉回来；
    右栏右上角的 ✕ 收起右栏后中栏吃掉整行、右边缘出现 14px 竖拉手（不压消息区滚动条），点竖拉手能拉回来；
    **顶栏工具区里不该再出现右栏开关**；两个开关各自独立、可同时收起；刷新后状态保持；
    按钮文案跟着状态走；窄屏（≤1000px）右栏本来就隐藏，竖拉手也不出现；
    窄屏（≤759.98px）收起顶栏后，细拉手左半边带「返回列表」（≥30px 触摸目标），点它能回到列表，重进会话仍是收起态。
13. **狼人杀**：群里 5~12 位成员（+ 你 = 6~13 人）时右栏的启动键可开局，人数不够要给出明确提示；
    **座位每局随机**（你不固定是最后一号，且数组按座位升序）；
    夜间行动（刀人 / 查验 / 用药）、白天发言+投票、平票 PK、遗言、猎人开枪都按 5.9 与本文档的板子表走；
    局内消息不影响普通群聊（结束后角色知道"已散场"）；认狼会被提示词 + 引擎兜底拦下。
    另外两条**信息边界**必须满足：公开面（群消息 + `state.log`）里不出现"某座位 = 某身份"，
    本人身份与（是狼时的）狼同伴走私密通道，而**狼队内仍互相可见**；女巫"今晚被刀的是…"在
    "没人被刀 / 被刀的是自己 / 解药已用完"三种情形下措辞正确。
    投票期间**一个票数都不能露**（盲投，见 5.9）：投票条、按钮角标、HUD 都不给数字，
    只有本轮结算完（法官公告那一刻）才公布。
    （`node tools/werewolfcheck.mjs` 会逐条验证上面这些，其中 S 条守信息边界、T 条守女巫措辞、Y 条守盲投。）
14. **导入备份后一刷新数据仍在**（见 5.12①）：导入完成后磁盘上必须有 `groupmsgs/<群id>.ndjson`，
    刷新页面（会走 `syncOnBoot` 的"以盘为准"回填）后群消息条数不变。
    （`node tools/dbcheck.mjs` 第 7 节逐条验证。）
15. **云端语音认对供应商**（见 5.12②）：选 Qwen / 自定义供应商时，直连只带该供应商的密钥与地址
    （绝不回退 OpenAI 的），代理模式把 `provider`+`baseUrl` 交给 `/api/tts` 且服务端据此选上游。
    （`node tools/selftest.mjs` 7.6 节 + `node tools/e2e.mjs` 第 6 节验证。）
16. **上下文预算分项自洽**（见 5.12③）：设置 → 上下文预算里各项之和等于显示的 total。
    （`node tools/selftest.mjs` 的 "分项之和等于 total" 用例验证。）
17. **静态路径与接口鉴权**（见 5.13①②）：`/x/../.env.example`、`//data/db/settings.json` 这类
    原样路径一律 403 且无内容泄露；正常资源仍 200；`--host 0.0.0.0` 时非本机请求没有口令就被拒，
    本机请求不受影响。
    （`node tools/securitycheck.mjs` 第 1、2 节逐条验证，其中穿越用例走**原始 socket** ——
    `fetch()` 会自己把 `..` 归一化掉，用它测不出这个漏洞。）
18. **代理与写盘**（见 5.13②③）：不在 `AICHAT_ALLOWED_UPSTREAMS` 内的自定义上游地址收不到服务器 Key；
    只改设置（关页兜底与去抖两条路径）都不会覆盖 `runtime.json`；磁盘清空失败时界面提示失败。
    （`node tools/securitycheck.mjs` 第 3、4 节 + `node tools/dbcheck.mjs` 第 8 节验证。）
19. **零成员群不丢**（见 5.14①）：把群里成员删光后，群与它的聊天记录在"清掉浏览器数据再打开"、
    以及"备份导出→导入"之后都还在。
    （`node tools/dbcheck.mjs` 第 7.5 节验证。）
20. **云端语音磁盘缓存可用**（见 5.14②）：播一句云端语音后 `ttsCache` 表里能查到记录，
    "清空缓存"能把磁盘上的记录清掉（主库版本仍是 2）。
    （`node tools/e2e.mjs` 第 6 节验证。）
21. **取消生成会掐断上游**（见 5.14③）：客户端中止流式请求后，上游连接随即被关闭。
    （`node tools/e2e.mjs` 第 6 节验证。）
22. **写失败不吞草稿**（见 5.14④）：模拟 IndexedDB 写入失败后，单聊与群聊的输入框、草稿里都留着原文。
    （`node tools/dbcheck.mjs` 第 7.5 节验证。）
23. **诊断工具可靠**（见 5.14⑤）：`node tools/selftest.mjs` 第 7.7 节验证 CDP 超时兜底与 `freePort()`；
    `stallcheck` 能自己找到空闲端口并在启动失败时打印原因；`aligncheck` 发现问题返回非零退出码。
24. **狼人杀的输出观感与普通聊天一致**（见 5.16）：角色的公开发言在临时气泡里**逐段长出来**
    （≥4 次可见增长，且中途每一态都是最终文字的前缀），落库那条消息与气泡里最后显示的字**完全一致**；
    投票/夜间这类私密指令不推给界面；中断时气泡会被收掉；
    这一局里新消息都是**增量插入**、整块重绘 0 次（对照组用普通消息证明这套检测看得见重绘）。
    （`node tools/werewolfcheck.mjs` 的 V 条 + W 条对照组验证。）
25. **生成参数里的思考模式可切三态，且真的落到请求体**（见 5.19）：「设置 → 模型 → 生成参数」里
    「思考模式（DeepSeek）」是三态（跟随模型默认 / 关闭思考 / 开启思考）；选「关闭思考」后私聊发出的请求带
    `thinking:{type:'disabled'}`，选「跟随模型默认」时请求体里**没有** `thinking` 字段（= 不干预模型默认）；
    重开设置面板回显的是刚存的那一态；选回默认写的是 `null` 而不是 `false`；
    服务器代理模式下同样按 provider 决定发不发（DeepSeek 发、其他供应商丢）；狼人杀的每一次调用**仍然**带
    `disabled`（不受这里影响）。
    （`node tools/selftest.mjs` 的「思考模式三态」+ `node tools/uicheck.mjs` 的设置面板用例
    + `node tools/e2e.mjs` 第 3.5 节的两条 + `node tools/werewolfcheck.mjs` 的 W 条验证。）
26. **顺序发言不许催"还没轮到的人"**（见 5.20）：每个发言人的提示词里都要有【发言顺序】那一段
    （本轮顺序、你是第几位、已经发过言的是谁、还没轮到的是谁），且明令禁止把后置位的沉默当疑点；
    模型若仍去质问还没轮到的座位，引擎先纠正重说一次、还犯就删掉那句（票不能丢）；人类玩家不受限制。
    （`node tools/selftest.mjs` 5.7 的三条用例 + `node tools/werewolfcheck.mjs` 的 Z 条验证。）
