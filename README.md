# 趣聊 · 角色私聊、多人群聊与狼人杀

一个本地优先的 AI 角色聊天项目，支持角色私聊、多人群聊和群内狼人杀；来源记忆、纠正与撤回支持持续互动。另有角色卡、世界书与可选语音。

## 下载与运行

**直接使用请下载 [最新 Release](https://github.com/irisaa1099-alt/ai-chat/releases/latest) 中的完整便携版。** Windows 和 macOS 便携版均已包含 Node.js、Ollama 与 Qwen3 4B 模型权重，无需单独安装运行环境、执行 `npm install` 或配置 API Key。

GitHub 的单个附件大小有限，当前便携版采用分卷发布。所有分卷需要先合并成一个 ZIP，再完整解压运行。仓库首页的 **Code → Download ZIP**，以及 Release 底部的 **Source code (zip / tar.gz)**，只提供源码，不包含模型权重或运行库。

### Windows：从下载到启动

适用于 Intel / AMD 的 **Windows x64**，要求 Windows 10 22H2 或更新版本；不提供 Windows ARM64 原生包。

1. 打开 [最新 Release](https://github.com/irisaa1099-alt/ai-chat/releases/latest)，展开页面下方的 **Assets**，下载以下 **4 个文件**：

   ```text
   Quliao-Windows-x64.zip.001
   Quliao-Windows-x64.zip.002
   Quliao-Windows-x64.zip.003
   Reassemble-Windows.bat
   ```

2. 将这 4 个文件放在同一个文件夹，保持原文件名；等待全部下载完成。不要单独解压 `.001`、`.002` 或 `.003`。
3. 双击 `Reassemble-Windows.bat`。脚本会合并分卷并自动检查 SHA-256。看到 `SHA-256 OK` 和 `Ready: Quliao-Windows-x64.zip` 后，合并完成。
4. 将生成的 `Quliao-Windows-x64.zip` **完整解压**到新的、可写的本地文件夹，例如 `D:\Quliao`。不要在压缩包内运行，也不要只复制启动文件。
5. 双击解压目录中的 `Start-Windows.bat`，也可以使用 `启动趣聊-Windows.bat`。保持启动窗口打开，等待本地模型和网站启动。
6. 浏览器通常会自动打开；若没有，手动访问 <http://127.0.0.1:5180>。进入「设置 → 模型 → 测试连接」，获得真实回复后即可创建角色并开始聊天。
7. 结束使用时，在启动窗口按 **Ctrl+C**。仅关闭浏览器页面不会停止服务。

更多运行条件和故障说明见 [Windows 使用说明](app/docs/WINDOWS.md)。

### macOS：从下载到启动

当前完整便携包适用于 **macOS 14 Sonoma 或更新版本**，包含 Apple Silicon（M 系列）和 Intel 两种运行环境。

1. 打开 [最新 Release](https://github.com/irisaa1099-alt/ai-chat/releases/latest)，展开 **Assets**，下载以下 **3 个文件**：

   ```text
   Quliao-macOS.zip.001
   Quliao-macOS.zip.002
   Reassemble-macOS.command
   ```

2. 将这 3 个文件放在同一个文件夹，保持原文件名；等待全部下载完成。不要单独解压分卷。
3. 打开 macOS「终端」，输入 `cd `（末尾有一个空格），把存放这 3 个文件的文件夹拖入终端，按回车。然后运行：

   ```bash
   bash Reassemble-macOS.command
   ```

4. 脚本会合并分卷并自动检查 SHA-256。看到 `Quliao-macOS.zip.partial: OK` 和 `Ready: Quliao-macOS.zip` 后，使用 Finder 完整解压生成的 `Quliao-macOS.zip`。
5. 将整个解压文件夹放在可写的位置，例如「文稿」，双击其中的 `Start-macOS.command`，保持终端窗口打开，等待本地模型和网站启动。
6. 首次运行时，如果 macOS 阻止打开，请按包内 `README-macOS.txt` 的说明操作；对于确认来自本仓库 Release 的文件，可按系统提示在「系统设置 → 隐私与安全性」中允许本次打开。启动脚本尚未经过 Apple 开发者签名或公证，无需关闭系统安全保护。
7. 浏览器通常会自动打开；若没有，手动访问 <http://127.0.0.1:5180>。进入「设置 → 模型 → 测试连接」，获得真实回复后即可开始聊天。
8. 结束使用时，在启动终端按 **Control+C**。仅关闭浏览器页面不会停止服务。

若提示 `Start-macOS.command` 没有执行权限，在终端切换到解压后的项目根目录，执行 `chmod +x Start-macOS.command`，然后重试。完整说明也随包保存在 `README-macOS.txt` 中。

### 首次使用与常见问题

- **运行环境与模型：**完整便携包已附带运行环境和模型，首次启动会准备项目模型配置。无需商业 API Key；基础模型文件缺失时，启动器才会尝试联网补齐。
- **下载不完整或校验失败：**确认所有分卷来自同一个 Release，文件名没有被浏览器加上 `(1)` 等后缀。删除合并失败产生的 ZIP / `.partial` 文件，重新下载缺失或损坏的分卷，再运行合并脚本；校验通过后再解压。
- **磁盘与内存：**建议 16GB 内存。下载分卷、合并 ZIP 和解压目录会同时占用空间，请预留足够磁盘空间。
- **窗口显示端口占用：**先在另一份趣聊的启动窗口按 Ctrl+C，再重试。网站使用本机 `5180` 端口，项目模型使用 `11435` 端口。
- **启动后页面打不开或模型没有回复：**保持启动窗口打开，查看其中的报错；确认完整解压、文件夹可写，并检查内存和系统版本。
- **验证范围：**Windows 和 Intel Mac 尚未完成本次实机验收；实际麦克风和扬声器也仍需验证。详细记录见 Release 附件 `VALIDATION.json`。

### 聊天数据与升级

角色修改、设置和聊天记录在运行后保存在解压目录的 `app/data/db/`。升级前请使用应用内的备份导出功能，并备份旧数据；将新版本完整解压到新目录后再迁移。分享已经使用过的整个目录前，请检查其中新产生的个人数据。

## 从源码运行（开发者）

通过 `git clone`、**Code → Download ZIP** 或 **Source code** 获得的源码不包含模型权重和平台运行库。请先安装 [Node.js 22 或更新版本](https://nodejs.org/en/download) 与 [Ollama](https://ollama.com/download)，确认终端可以运行 `node --version` 和 `ollama --version`。

在终端切换到源码项目根目录，再执行：

```bash
cd app
node local-start.mjs
```

启动器会启动项目专用的 Ollama 服务，在模型缺失时下载约 2.5GB 的 Qwen3 4B 权重到项目 `models/ollama/`，再启动网站；第一次准备模型需要联网。浏览器访问 <http://127.0.0.1:5180>。使用期间保留终端，结束时按 Ctrl+C。

项目使用原生 ES Module，无需安装 npm 依赖或执行构建。本版本仅使用固定的本地模型，所有角色与旧配置统一使用该模型，不提供商业供应商或自定义远程接口。[本地模型说明与来源](app/docs/LOCAL-MODEL.md)。

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
