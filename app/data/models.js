/**
 * data/models.js
 * ---------------------------------------------------------------------------
 * 供应商 / 模型 / 参数预设 / 价格表 —— 本文件是模型接入层的**唯一上游数据源**。
 * core/llm.js 从这里导入 PROVIDERS_META、CHAT_MODELS、MODEL_PRICING。
 *
 * 约束：原生 ES Module，零依赖，浏览器直接运行，所有文案为简体中文。
 * 说明：价格单位为「元 / 百万 token」，为 2025 年公开报价的**估算值**
 *      （美元报价按 1 USD ≈ 7.2 CNY 折算），仅用于成本预估展示，
 *      不代表供应商最终账单；供应商调价时只需修改本文件。
 * ---------------------------------------------------------------------------
 */

/**
 * @typedef {Object} ProviderMeta
 * @property {string}   id        供应商 id（也是 settings.provider 的取值）
 * @property {string}   label     中文显示名
 * @property {'openai'|'anthropic'|'gemini'|'ollama'} kind 协议类型
 * @property {string}   baseUrl   接口根地址（不含 /chat/completions 等末段）
 * @property {string[]} models    常用模型名（与 CHAT_MODELS 保持一致）
 * @property {boolean}  needKey   是否需要 API Key
 * @property {string}  [keyUrl]   申请 / 管理密钥的地址（设置面板给出跳转）
 * @property {string}  [keyName]  密钥字段显示名（契约 3.9 字段）
 * @property {string}  [docs]     官方文档地址（契约 3.9 字段，与 keyUrl 同源）
 * @property {string}  [note]     设置面板展示的中文提示
 */

/**
 * 供应商元数据（契约 3.10）。
 * 顺序即设置面板的下拉顺序：国内直连优先，本地与自定义置后。
 * @type {Record<string, ProviderMeta>}
 */
export const PROVIDERS_META = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek（深度求索）',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    needKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    keyName: 'DeepSeek API Key',
    docs: 'https://api-docs.deepseek.com/zh-cn/',
    note: '国产高性价比模型；Flash 更快更省，V4 Pro 更强。两者均支持思考/非思考模式。'
  },

  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'o4-mini'
    ],
    needKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyName: 'OpenAI API Key',
    docs: 'https://platform.openai.com/docs/api-reference',
    note: '国内直连通常需要代理；若无法访问可在「自定义」里填写反向代理地址。'
  },

  moonshot: {
    id: 'moonshot',
    label: 'Moonshot（Kimi）',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      'kimi-k2-0905-preview',
      'kimi-k2-turbo-preview',
      'kimi-latest',
      'moonshot-v1-128k',
      'moonshot-v1-32k',
      'moonshot-v1-8k'
    ],
    needKey: true,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    keyName: 'Moonshot API Key',
    docs: 'https://platform.moonshot.cn/docs/api/chat',
    note: '长上下文友好；moonshot-v1-128k 支持约 12.8 万 token 上下文。'
  },

  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-plus', 'glm-4-flashx', 'glm-4-flash'],
    needKey: true,
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    keyName: '智谱 API Key',
    docs: 'https://docs.bigmodel.cn/',
    note: 'glm-4-flash 免费额度较大，适合日常闲聊。'
  },

  qwen: {
    id: 'qwen',
    label: '通义千问（DashScope 兼容模式）',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      'qwen3-max',
      'qwen-max',
      'qwen-plus',
      'qwen-turbo',
      'qwen3-235b-a22b',
      'qwen-long',
      'qwen-vl-plus'
    ],
    needKey: true,
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    keyName: 'DashScope API Key',
    docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    note: '使用的是百炼「OpenAI 兼容模式」地址，不是 dashscope 原生 SDK 地址。'
  },

  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-235B-A22B-Instruct-2507',
      'Qwen/Qwen3-8B',
      'moonshotai/Kimi-K2-Instruct',
      'zai-org/GLM-4.5-Air',
      'THUDM/glm-4-9b-chat'
    ],
    needKey: true,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    keyName: 'SiliconFlow API Key',
    docs: 'https://docs.siliconflow.cn/',
    note: '一个 Key 聚合多家开源模型，模型名需带组织前缀（如 deepseek-ai/）。'
  },

  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter（聚合）',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'openai/gpt-4.1-mini',
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-haiku-4.5',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-chat',
      'qwen/qwen3-235b-a22b',
      'meta-llama/llama-3.3-70b-instruct'
    ],
    needKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    keyName: 'OpenRouter API Key',
    docs: 'https://openrouter.ai/docs',
    note: '一个 Key 访问多家模型，计费为美元结算、按量折算。'
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic（Claude）',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
      'claude-3-7-sonnet-latest',
      'claude-3-5-haiku-latest'
    ],
    needKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyName: 'Anthropic API Key',
    docs: 'https://docs.anthropic.com/zh-CN/api/messages',
    note: '浏览器直连需服务端允许 CORS，本模块已自动附带直连所需请求头。'
  },

  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    needKey: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyName: 'Gemini API Key',
    docs: 'https://ai.google.dev/gemini-api/docs',
    note: '系统提示词会以 systemInstruction 字段下发；国内直连通常需要代理。'
  },

  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen3', 'qwen2.5', 'llama3.2', 'deepseek-r1', 'gemma3', 'mistral'],
    needKey: false,
    keyUrl: 'https://ollama.com/download',
    keyName: '（本地无需密钥）',
    docs: 'https://docs.ollama.com/api/openai-compatibility',
    note: '需先执行 ollama serve 并 ollama pull 模型；断网也能用。'
  },

  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    needKey: false,
    keyUrl: 'https://lmstudio.ai/',
    keyName: '（本地无需密钥）',
    docs: 'https://lmstudio.ai/docs/local-server',
    note: '在 LM Studio 中开启 Local Server 后即可连接，模型名以其加载的标识为准。'
  },

  custom: {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    kind: 'openai',
    baseUrl: '',
    models: [],
    needKey: true,
    keyName: 'API Key',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    note: '手动填写兼容 OpenAI 协议的接口根地址（需以 /v1 结尾）与模型名。'
  }
};

/**
 * provider → 常用模型列表（契约 3.10）。
 * 与 PROVIDERS_META[provider].models 内容保持一致（此处为独立副本，避免被外部改写）。
 * @type {Record<string, string[]>}
 */
export const CHAT_MODELS = Object.keys(PROVIDERS_META).reduce((acc, id) => {
  acc[id] = PROVIDERS_META[id].models.slice();
  return acc;
}, /** @type {Record<string, string[]>} */ ({}));

/**
 * 由 id 取供应商元数据；未知 id 返回 custom 的副本（保证调用方不会拿到 undefined）。
 * @param {string} id
 * @returns {ProviderMeta}
 */
export function getProvider(id) {
  const meta = PROVIDERS_META[id];
  if (meta) return meta;
  return Object.assign({}, PROVIDERS_META.custom);
}

/**
 * 默认参数预设（契约 3.10）。params 字段与 settings.params 完全同构。
 * @type {Array<{ id: string, name: string, params: { temperature: number, topP: number, maxTokens: number, presencePenalty: number, frequencyPenalty: number } }>}
 */
export const DEFAULT_PRESETS = [
  {
    id: 'balanced',
    name: '均衡',
    params: { temperature: 0.85, topP: 1, maxTokens: 1024, presencePenalty: 0, frequencyPenalty: 0 }
  },
  {
    id: 'creative',
    name: '创意发散',
    params: { temperature: 1.15, topP: 0.95, maxTokens: 1536, presencePenalty: 0.6, frequencyPenalty: 0.3 }
  },
  {
    id: 'strict',
    name: '严谨助手',
    params: { temperature: 0.3, topP: 0.8, maxTokens: 1024, presencePenalty: 0, frequencyPenalty: 0.2 }
  },
  {
    id: 'roleplay',
    name: '角色扮演',
    params: { temperature: 1, topP: 1, maxTokens: 1280, presencePenalty: 0.5, frequencyPenalty: 0.4 }
  },
  {
    id: 'short',
    name: '短回复',
    params: { temperature: 0.8, topP: 0.9, maxTokens: 256, presencePenalty: 0.1, frequencyPenalty: 0.5 }
  },
  {
    id: 'story',
    name: '长文叙事',
    params: { temperature: 0.95, topP: 1, maxTokens: 2048, presencePenalty: 0.3, frequencyPenalty: 0.1 }
  },
  {
    id: 'reasoning',
    name: '冷静推理',
    params: { temperature: 0.15, topP: 0.7, maxTokens: 2048, presencePenalty: 0, frequencyPenalty: 0 }
  }
];

/**
 * 参数滑块的展示元数据（供 ui/settings.js 生成滑块）。
 * @type {Record<string, { label: string, min: number, max: number, step: number, desc: string }>}
 */
export const PARAM_HINTS = {
  temperature: {
    label: '温度',
    min: 0,
    max: 2,
    step: 0.01,
    desc: '越高回复越发散随机，越低越稳定保守。闲聊建议 0.7~1.1。'
  },
  topP: {
    label: '核采样',
    min: 0.1,
    max: 1,
    step: 0.01,
    desc: '从累计概率前 P 的词中取样，通常保持 1；与温度二选一调整即可。'
  },
  maxTokens: {
    label: '最大回复长度',
    min: 64,
    max: 8192,
    step: 64,
    desc: '单条回复的 token 上限（约等于汉字数），越长越贵也越慢。'
  },
  presencePenalty: {
    label: '话题新鲜度',
    min: -2,
    max: 2,
    step: 0.01,
    desc: '正值鼓励模型谈新话题，负值会让它反复围绕已有内容。'
  },
  frequencyPenalty: {
    label: '重复抑制',
    min: -2,
    max: 2,
    step: 0.01,
    desc: '正值降低重复用词的概率，可缓解复读机现象。'
  }
};

/**
 * 「思考模式」的三态选项（契约 3.10，见 ARCHITECTURE 5.19）。
 *
 * 为什么不只是一个开关：DeepSeek 的请求级字段本身只有开/关两态，但**默认值由模型自己决定**
 * （实测 `deepseek-flash` 默认就是"思考开"，见 5.17），所以界面必须留出"不干预"这一态——
 * 否则"关掉开关"到底等于"关思考"还是"回到默认"就说不清了。
 *
 * 注意：这里只放**数据与映射**，不放任何 DOM（`ui/settings.js` 负责渲染，`core/llm.js`
 * 只认 `params.thinking` 的布尔值）。三态的判据收在下面两个函数里，别在界面里另写一套 `if`。
 * @type {Array<{ value: string, label: string, desc: string }>}
 */
export const THINKING_CHOICES = [
  {
    value: 'default',
    label: '跟随模型默认',
    desc: '不下发 thinking 字段，完全按模型自己的默认行为跑（DeepSeek 实测默认是"思考开"）。'
  },
  {
    value: 'off',
    label: '关闭思考',
    desc: '下发 thinking=disabled：更快、更省，且思考不会跟正文抢 max_tokens 预算（推荐用于角色扮演式短回复）。'
  },
  {
    value: 'on',
    label: '开启思考',
    desc: '下发 thinking=enabled：模型先想再答，质量更稳但更慢更贵；思考与正文共享同一个 max_tokens 预算，回复容易被从中间截断。'
  }
];

/**
 * 从 `params` 反推三态选项（未设置 / 非布尔值一律视为"跟随模型默认"）。
 * @param {object} [params]
 * @returns {'default'|'off'|'on'}
 */
export function thinkingChoiceOf(params) {
  const v = params && params.thinking;
  if (v === true) return 'on';
  if (v === false) return 'off';
  return 'default';
}

/**
 * 三态选项 → `params.thinking`。`'default'` 返回 `null`（= 不下发该字段）。
 * @param {string} choice
 * @returns {boolean|null}
 */
export function thinkingParamOf(choice) {
  if (choice === 'on') return true;
  if (choice === 'off') return false;
  return null;
}

/**
 * 模型价格表（契约 3.10）：元 / 百万 token。
 * 键为模型名（OpenRouter 使用其带斜杠的完整 id）。
 * 未知模型由 core/llm.js 的 estimateCost() 返回 0。
 * @type {Record<string, { in: number, out: number }>}
 */
export const MODEL_PRICING = {
  // ---- DeepSeek ----
  // 按官方峰值价折算为人民币（缓存未命中输入 / 输出）；旧名保留以便历史用量估价。
  'deepseek-flash': { in: 2.16, out: 8.64 },
  'deepseek-v4-pro': { in: 9.504, out: 28.512 },
  'deepseek-chat': { in: 2, out: 8 },
  'deepseek-reasoner': { in: 4, out: 16 },

  // ---- OpenAI（美元 × 7.2）----
  'gpt-5': { in: 9, out: 72 },
  'gpt-5-mini': { in: 1.8, out: 14.4 },
  'gpt-5-nano': { in: 0.36, out: 2.88 },
  'gpt-4.1': { in: 14.4, out: 57.6 },
  'gpt-4.1-mini': { in: 2.88, out: 11.52 },
  'gpt-4.1-nano': { in: 0.72, out: 2.88 },
  'gpt-4o': { in: 18, out: 72 },
  'gpt-4o-mini': { in: 1.08, out: 4.32 },
  o3: { in: 14.4, out: 57.6 },
  'o4-mini': { in: 7.92, out: 31.68 },

  // ---- Moonshot / Kimi ----
  'kimi-k2-0905-preview': { in: 4, out: 16 },
  'kimi-k2-turbo-preview': { in: 8, out: 32 },
  'kimi-latest': { in: 12, out: 12 },
  'moonshot-v1-128k': { in: 60, out: 60 },
  'moonshot-v1-32k': { in: 24, out: 24 },
  'moonshot-v1-8k': { in: 12, out: 12 },

  // ---- 智谱 GLM ----
  'glm-4.6': { in: 4, out: 16 },
  'glm-4.5': { in: 4, out: 16 },
  'glm-4.5-air': { in: 0.8, out: 6 },
  'glm-4-plus': { in: 50, out: 50 },
  'glm-4-flashx': { in: 0.1, out: 0.1 },
  'glm-4-flash': { in: 0, out: 0 },

  // ---- 通义千问 ----
  'qwen3-max': { in: 2.5, out: 10 },
  'qwen-max': { in: 2.4, out: 9.6 },
  'qwen-plus': { in: 0.8, out: 2 },
  'qwen-turbo': { in: 0.3, out: 0.6 },
  'qwen3-235b-a22b': { in: 2.5, out: 10 },
  'qwen-long': { in: 0.5, out: 2 },
  'qwen-vl-plus': { in: 1.5, out: 4.5 },

  // ---- 硅基流动 ----
  'deepseek-ai/DeepSeek-V3': { in: 2, out: 8 },
  'deepseek-ai/DeepSeek-R1': { in: 4, out: 16 },
  'Qwen/Qwen3-235B-A22B-Instruct-2507': { in: 2.5, out: 10 },
  'Qwen/Qwen3-8B': { in: 0, out: 0 },
  'moonshotai/Kimi-K2-Instruct': { in: 4, out: 16 },
  'zai-org/GLM-4.5-Air': { in: 0.8, out: 6 },
  'THUDM/glm-4-9b-chat': { in: 0.1, out: 0.1 },

  // ---- OpenRouter（其模型 id 自带组织前缀）----
  'openai/gpt-4o-mini': { in: 1.08, out: 4.32 },
  'openai/gpt-4.1-mini': { in: 2.88, out: 11.52 },
  'anthropic/claude-sonnet-4.5': { in: 21.6, out: 108 },
  'anthropic/claude-haiku-4.5': { in: 7.2, out: 36 },
  'google/gemini-2.5-flash': { in: 2.16, out: 18 },
  'deepseek/deepseek-chat': { in: 2, out: 8 },
  'qwen/qwen3-235b-a22b': { in: 2.5, out: 10 },
  'meta-llama/llama-3.3-70b-instruct': { in: 0.9, out: 0.9 },

  // ---- Anthropic（美元 × 7.2）----
  'claude-sonnet-4-5': { in: 21.6, out: 108 },
  'claude-opus-4-1': { in: 108, out: 540 },
  'claude-haiku-4-5': { in: 7.2, out: 36 },
  'claude-3-7-sonnet-latest': { in: 21.6, out: 108 },
  'claude-3-5-haiku-latest': { in: 5.76, out: 28.8 },

  // ---- Gemini（美元 × 7.2）----
  'gemini-2.5-pro': { in: 9, out: 72 },
  'gemini-2.5-flash': { in: 2.16, out: 18 },
  'gemini-2.5-flash-lite': { in: 0.72, out: 2.88 },
  'gemini-2.0-flash': { in: 0.72, out: 2.88 },

  // ---- 本地模型（免费）----
  qwen3: { in: 0, out: 0 },
  'qwen2.5': { in: 0, out: 0 },
  'llama3.2': { in: 0, out: 0 },
  'deepseek-r1': { in: 0, out: 0 },
  gemma3: { in: 0, out: 0 },
  mistral: { in: 0, out: 0 },
  'local-model': { in: 0, out: 0 }
};
