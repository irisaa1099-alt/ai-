# 记忆机制真实模型评测

本工具使用合成资料与独立无头浏览器，调用项目真实的记忆提取、来源校验、纠正/撤回、近期经历与提示词装配。不会启动正式服务器，不会调用真实聊天数据库的写入接口；真实数据库仅用于前后指纹校验，`--from-site`额外只取网站设置中的模型连接字段。

## 运行

要求 Node.js 22+，安装本机 Chrome/Edge/Chromium。无 npm 依赖。

在 `app/` 下执行：

```sh
# 查看固定40个实例及六组定义
node tools/memory-eval.mjs --list

# 先验证完整管线：本地假模型，无外部调用，不能用于报告真实模型质量
node tools/memory-eval.mjs --dry-run --full

# 沿用网站当前模型配置：5个场景 × 两组，通常15次请求，上限24次
node tools/memory-eval.mjs --live --pilot --from-site

# 全部40场景 × 六组，通常282次请求（含两次重建）
node tools/memory-eval.mjs --live --full --from-site --max-calls 300

# 单独的连接配置；密钥只从指定环境变量中读取
node tools/memory-eval.mjs --live --pilot --config tools/memory-eval/config.local.json

# 评分与汇总逻辑测试
node --test tools/memory-eval/check.test.mjs

# 在完整模拟轮次上验证实际提示词与消融处理
node tools/memory-eval/check-run.mjs /绝对路径/某次pipeline输出目录

# 已完成真实运行后，离线补算费用，不重新请求模型
node tools/memory-eval/reprice.mjs /绝对路径/某次live输出目录 tools/memory-eval/pricing.deepseek-flash.2026-10-24.json
```

`config.example.json`可复制为`config.local.json`；后者已忽略提交。请勿把密钥写进配置或命令行参数；通过本地环境变量`MEMORY_EVAL_API_KEY`提供。`--from-site`不扫描`.env`，服务端密钥模式需要该环境变量。当前桥接支持项目现有的OpenAI兼容供应商，不支持Anthropic/Gemini协议。自定义供应商填`custom`。

默认输出到工作区的`artifacts/memory-eval/<UTC时间>-live/`，也可以`--out 新目录`指定。输出目录必须尚不存在；不自动续跑或拼接不同配置的数据。`--ids`按逗号选固定场景，`--variants`按逗号选组，`--temperature`统一修改回答温度。模型错误后停止继续付费，不自动重试；每完成一个回答即保存。`--max-calls`限制请求次数，不是金额预算。中断轮次必须按未完成披露。

## 场景与对照设计

五类各8例：跨场景回忆（含9天前、超出7天近期窗口的事实）、听众边界（他人私聊/新成员/空听众/群内公开后的正例）、人工纠正/撤回/重建、原文删除/编辑、长上下文（含正常对照与大人设的4000/8000预算）。这是受控模板的40个实例，不是40种独立用户任务。默认试跑每类选第一个实例，不包括全部边界。

六组：

| 组 | 处理 |
|---|---|
| `no_memory` | 仅当前会话最近消息，不注入长期记忆和跨场景近期经历 |
| `shared_history` | 把跨会话原文混合为上下文，无听众隔离；保留用户的管理操作说明；属于故意不安全的诊断对照 |
| `current` | 当前实际实现 |
| `no_recent` | 关闭跨场景近期经历 |
| `no_correction` | 仅在纠正类恢复管理操作前的记忆，其他类别与当前相同 |
| `no_source_check` | 仅在原文变化类使用变化前记忆，其他类别与当前相同 |

每场景用同一真实模型提取一次记忆，六组共享其结果，组顺序按场景循环轮换。真实提取失败或漏掉事实时，不用标准答案补造。回答模型与参数固定，默认temperature=0、maxTokens=256，其他参数继承网站；提取沿用项目自己的temperature=0.3、maxTokens=1100。没有伪造“全管线temperature=0”。每格只答一次；正式评测可独立重复运行，不能挑选最好的一轮。

评分是明确专名的严格匹配：正确新值出现、旧值不出现；未知场景接受冻结的未知短语。接口错误、截断单列，旧值被否定的回答仍需人工复核。隐藏值显式复现率只是可观测指标，不代表所有语义泄露。`review.csv`包含所有回答的人工复核空栏，机器结果不会被人工修改覆盖。改动评分规则必须升级协议版本并重算所有组。

## 结果与费用

每轮生成：`report.md`、`summary.json`、`results.csv`、`review.csv`、`results.json`、`calls.jsonl`、`scenarios.json`、`protocol.json`、`source-manifest.json`、`source/`与`isolation.json`。源码快照不含真实聊天或设置。请求日志只含合成提示词、标准模型响应与用量，不记录认证头。

报告区分已知事实回忆、未知时保留、显式越界、旧值复现，给出共同场景配对胜负、分类型结果、失败原回答、提取和回答耗时。API用量缺失时记为未知，不用字符估算器代替；费用不采用应用内旧价格表。需要估算时，在独立配置中加入已核实的价格：

```json
{
  "pricing": {
    "inputPerMillion": 0,
    "outputPerMillion": 0,
    "cachedInputPerMillion": 0,
    "currency": "CNY",
    "source": "填写官方价格页面URL，不要直接使用这里的0",
    "checkedAt": "填写实际核价日期"
  }
}
```

价格不填写就不出金额结论。附带的DeepSeek价格参考已按2026-10-24官方页面核价，仅供该日运行离线补算，未来必须重新核价。保留原始缓存命中用量，费用为单价估算，不是最终账单。各记忆组共享提取的费用需分别归属分析，不能重复相加；实际总调用量另计。一次试跑只能证明这些样本的观察结果；工程检查通过数与模拟模型分数均不能充当记忆质量证据。
