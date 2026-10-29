# 趣聊 · 角色私聊、多人群聊与狼人杀

一个本地优先的 AI 角色聊天项目，支持角色私聊、多人群聊和群内狼人杀；来源记忆、纠正与撤回支持持续互动。另有角色卡、世界书与可选语音。

## 快速开始

本项目仅使用本地模型。当前 Mac 版已包含 Qwen3 权重和 Ollama 运行程序，安装 Node.js 22 或更新版本后，在本仓库目录运行：

```bash
cd app
node local-start.mjs
```

启动项目内的 Qwen3 4B 开源模型（权重约 2.5GB），浏览器打开 <http://127.0.0.1:5180>，无需商业 API Key。所有角色与旧配置自动使用项目内模型，不提供商业供应商或自定义远程接口。项目使用原生 ES Module，无需安装 npm 依赖或执行构建。[本地模型说明与来源](app/docs/LOCAL-MODEL.md)。

## Windows 便携版

Windows x64 完整包包含 Node.js、Ollama 与模型权重，解压后双击 `启动趣聊-Windows.bat`。[使用说明与验证范围](app/docs/WINDOWS.md)。Windows 实机验收尚未完成。

## 项目文档

- [完整功能与使用说明](app/README.md)
- [项目架构](app/docs/ARCHITECTURE.md)
- [核心体验补强记录](app/docs/CORE-EXPERIENCE-2026-10-25.md)
- [记忆效果评测：固定场景、基线与消融](app/tools/memory-eval/README.md)
- [交付说明](AI聊天网站-交付说明.md)

源码位于 `app/`，检查工具位于 `app/tools/`，早期语音原型位于 `demo/`。

本仓库不包含本地聊天数据库、用户设置、备份或 API 密钥。需要服务器代理配置时，可参考 [环境变量示例](app/.env.example)。

## 参赛复现

核心贡献是让角色按实际经历使用跨场景记忆，并提供来源与纠错。参赛运行、验证、复用与限制见 [复现说明](app/docs/CONTEST-REPRODUCE.md)，本轮变更见 [稳定性修订](app/docs/BUGFIX-2026-10-25.md)，第三方边界见 [来源说明](NOTICE.md)。

构建中性模板副本：`node app/tools/build-contest-release.mjs /绝对路径/新的输出目录`。不会复制用户数据库或凭据，不改变正式人物库。

## 许可

自有代码采用 [MIT](LICENSE)；第三方与原人物模板的排除范围见 [NOTICE](NOTICE.md)。

新版参赛材料围绕私聊→群聊→狼人杀→局后聊天展开。[新场景与合理摘要基线](app/tools/core-eval/README.md) · [最小复用示例](app/examples/README.md)。

R3修订：连续改期淘汰明确旧安排，一次纠正关联同义记忆并保留独立信息。见 [实现与边界](app/docs/MEMORY-REVISION-2026-10-25.md)。
