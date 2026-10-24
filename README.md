# AI 好友 · AI 聊天网站

一个本地优先的 AI 角色聊天项目，支持角色卡、私聊、群聊、长期记忆、世界书与语音交互。

## 快速开始

安装 Node.js 18 或更新版本，在本仓库目录运行：

```bash
cd app
node server.mjs
```

浏览器打开 <http://127.0.0.1:5180>，在设置中配置模型供应商与自己的 API Key。项目使用原生 ES Module，无需安装 npm 依赖或执行构建。

## 项目文档

- [完整功能与使用说明](app/README.md)
- [项目架构](app/docs/ARCHITECTURE.md)
- [最新修改记录](app/docs/BUGFIX-2026-10-24.md)
- [记忆效果评测：固定场景、基线与消融](app/tools/memory-eval/README.md)
- [交付说明](AI聊天网站-交付说明.md)

源码位于 `app/`，检查工具位于 `app/tools/`，早期语音原型位于 `demo/`。

本仓库不包含本地聊天数据库、用户设置、备份或 API 密钥。需要服务器代理配置时，可参考 [环境变量示例](app/.env.example)。
