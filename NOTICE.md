# 来源与开放边界

趣聊是原生 JavaScript、HTML、CSS 和 Node.js 应用。经项目权利人于2026年10月25日确认，自有代码以根目录 LICENSE 的 MIT 许可开放。该许可不覆盖第三方图标、原人物模板、外部模型服务、用户数据或其他第三方资源；这些内容按本说明的各自范围与许可处理。

界面图标使用 Lucide 0.468.0，固定提交 f12b0de177fbc2a6795e99be065887e72b237123，完整许可见 app/licenses/LUCIDE-LICENSE.txt，逐图来源见 app/licenses/lucide-sources.json。仅调整外层显示尺寸与线宽，保留适用 ISC 和 Feather 衍生部分的 MIT 声明。

app/icon.svg 为2026年10月25日本轮 AI 辅助直接编写的几何图形，没有外部嵌入素材。app/data/contest-templates.js 为AI辅助编写的虚构角色和场景。原 app/data/templates.js 的人物与世界内容不纳入参赛分发和自有代码许可主张；参赛构建将其替换，不修改用户正式模板。

浏览器作为运行宿主，不随包分发；Node.js 在 Windows 便携版中随包提供，普通源码包不包含它。默认文本模型现为 Qwen3-4B-Instruct-2507（Apache-2.0），由 Ollama（MIT）在本机运行；量化版本、来源及复现配置见 app/docs/LOCAL-MODEL.md 与 app/models/Modelfile。本机完整项目包含模型权重与 macOS arm64 / Windows x64 Ollama 运行程序，位于 models/ollama 和 runtime/ollama；许可证见 app/licenses/QWEN3-LICENSE.txt 与 OLLAMA-LICENSE.txt。普通源码构建默认不包含这些大型文件。模型配置别名不代表训练或微调成果。

此前参赛评测真实调用的是外部 DeepSeek API，不能用原分数代表本地 Qwen 效果，也不能以模型开源许可替代 API 服务条款。当前版本移除了商业供应商与云端语音入口；系统语音能力依赖操作系统。

AI工具参与本轮代码修订、自动化检查、合成场景、录屏编排与材料撰写；不代表团队成员已完成独立人工审核。团队需如实补全成员贡献与共同权利人授权。

Windows 便携版附带 Node.js 24.22.2，其 MIT 及第三方许可保存在 runtime/node/win32-x64/LICENSE。Ollama Windows 官方压缩包内的第三方许可随运行库完整保留。模型权重采用自身许可，原人物模板的权利边界仍按上文说明处理。
