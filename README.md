# 趣聊：角色私聊、多人群聊与狼人杀

这是 R2 中性参赛分发，包含六名虚构角色、MIT自有代码及第三方许可，不含正式人物库、私人聊天、设置或密钥。

在 `app` 目录运行 `node server.mjs --no-open`，打开 http://127.0.0.1:5180 并配置自己的模型服务。添加至少五名角色，建群后可开六人狼人杀。

- [启动与复现](app/docs/CONTEST-REPRODUCE.md)
- [核心功能补强与限制](app/docs/CORE-EXPERIENCE-2026-10-25.md)
- [最小复用示例](app/examples/README.md)
- [新场景与合理基线](app/tools/core-eval/README.md)
- [报告、视频与完整证据](https://github.com/irisaa1099-alt/ai-/releases/tag/aic-20261025-r2)

正式新场景18×3×2共108条真实回答；AI语义复核及Codex校对当前35/36、独立摘要35/36，不能宣称优于该基线。历史六组240条已全组复核。未开展用户试用或独立人工评审。

连续改期仍有旧时间复现；同义记忆需逐条纠正。完整开发失败与正式数据分开保留。
