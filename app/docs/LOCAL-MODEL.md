# 项目内的本地模型

本版本仅支持本地 Qwen3-4B-Instruct-2507。供应商固定为 Ollama，没有 API Key 输入、商业供应商或自定义远程地址。旧设置、角色独立模型配置和导入备份在调用时统一使用项目模型。私聊、群聊、狼人杀、摘要与记忆整理继续共用原有提示词和来源过滤逻辑。

## 文件位置

相对于项目根目录：

- `models/ollama/`：约 2.5GB 模型权重、元数据与模型清单，是真实文件，非指向用户缓存的链接。
- `models/MODEL_FILES.json`：基础模型文件大小及 SHA-256 校验值。
- `runtime/ollama/darwin-arm64/`：Mac 使用的 Ollama 0.40.13 运行程序与依赖库。
- `runtime/ollama/win32-x64/`、`runtime/node/win32-x64/`：Windows 便携版的推理与 Node.js 运行程序。
- `app/models/Modelfile`：Q4_K_M 模型配置，16,384 tokens 上下文，别名 `quliao-qwen3:4b`。
- `app/licenses/QWEN3-LICENSE.txt`、`OLLAMA-LICENSE.txt`：模型及运行程序的许可证。

权重和运行库仍保存在项目中，只是不加入普通 Git 提交；复制完整项目目录即可一起带走。通过 Git 获取的纯源码不包含这些大型文件，需安装相应平台的 Ollama 并准备模型。现已准备 Apple Silicon Mac 与 Windows x64 运行程序；Windows 使用 `启动趣聊-Windows.bat`。Windows 包尚未完成实机验收，详见 [Windows 使用说明](WINDOWS.md)。

## 启动

需要 Node.js 22+。Mac 可双击项目根目录的 `启动本地模型.command`，或执行：

```sh
cd app
node local-start.mjs
```

浏览器打开 `http://127.0.0.1:5180`，在「设置 → 模型」点击「测试连接」。模型服务仅监听 `127.0.0.1:11435`，脚本设置 `OLLAMA_MODELS` 为本项目 `models/ollama` 的绝对路径，并设置 `OLLAMA_NO_CLOUD=1`。不会复用系统中 11434 端口的其他 Ollama 服务。如果项目专用端口已被占用，脚本会提示先停止已有进程。

启动时优先使用项目自带的运行程序；其次支持 `AICHAT_OLLAMA_BIN` 或系统已安装的 Ollama。权重存在时不重新下载；缺失时从官方仓库下载到项目目录。`--setup-only` 只准备模型；`--no-open` 不自动打开浏览器。关闭启动脚本会停止它启动的模型与网站进程。

后端只接受固定项目模型和本地地址，拒绝商业供应商、云模型名、地址覆盖及上游重定向。前端不直接访问推理程序，全部通过本机网站服务。云端语音接口已停用；系统语音是否离线取决于系统音源。

## 来源与许可

- [Qwen/Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)：Apache-2.0。
- [Ollama 量化发布](https://ollama.com/library/qwen3:4b-instruct-2507-q4_K_M)：Q4_K_M，基础权重摘要见 `MODEL_FILES.json`。
- [Ollama 0.40.13](https://github.com/ollama/ollama/releases/tag/v0.40.13)：MIT。
- [Ollama 模型目录与禁用云端配置说明](https://docs.ollama.com/faq)。

模型别名只是运行配置，没有训练或微调 Qwen。历史 DeepSeek 成绩仍属于原 API 实验，不能用作本地 Qwen 的效果证据。当前短场景检查不代表完整狼人杀质量、长对话记忆评测或跨平台验收。

## 检查

```sh
node tools/providercheck.mjs
node tools/selftest.mjs
```

第一项使用隔离服务器和本机假上游检查本地调用与远程拒绝边界，不读取真实配置或聊天数据库。

## 本地迁移修复（2026-10-29）

- 单聊、群聊、主动消息和狼人杀统一使用项目本地模型，旧角色的商业供应商配置不再影响调用或新的用量记录。
- 输入预算最多约 7000 tokens，输出最多 8192 tokens，为 16K 窗口保留模板与估算余量。输入预算使用应用估算器，不等同于模型 tokenizer 的精确计数；实际长文本仍需验证。
- 模型列表、连接和访问拒绝显示真实错误，不再提示配置商业密钥或把连接失败显示为未安装。
- 所有文本请求（包括游戏和记忆整理）均检查输入估算；超长时明确拒绝，避免推理程序静默截断重要规则。
- 群聊、主动消息与游戏按本地冷启动设置 120 秒无内容等待和 5 分钟总时限；超时或用户停止仍会取消请求。
- 静态资源优先读取当前服务版本，离线时回退缓存。更新后请刷新已有页面。
- 启动器检查模型端口占用；模型进程意外退出时关闭本次网站并报错。

检查命令另含 `node tools/local-startcheck.mjs`、`node tools/local-cachecheck.mjs` 与 `node tools/groupbudgetcheck.mjs`。启动夹具在 Mac 上运行，不代替 Windows 实机验收。
