# lv24-opencode-consilium

[English](../README.md) · [Русский](README.ru.md) · **中文**

面向 [OpenCode](https://opencode.ai) 的 AI 专家委员会：多个角色在**不同模型上并行**回答同一个任务，最后由主席模型综合成最终方案。内置免费模型自动挑选、CLI、库 API，以及可在任意宿主中使用的 **MCP 服务器**（Claude Desktop、Codex、Cursor、VS Code、自有 Agent）。

> 完整文档以英文和俄文为准：[README.md](../README.md) · [README.ru.md](README.ru.md)

## 快速开始

```bash
npm install -g lv24-opencode-consilium

consilium doctor          # 检查 OpenCode、配置、Agent、模型
consilium init --free     # 自动挑选并验证最强的免费模型，写入配置
consilium "为公共 API 设计限流方案"
```

`init --free` 会：

1. 读取 `models.dev/api.json` 与 `openrouter.ai/api/v1/models`；
2. 只保留免费（`cost = 0`）、可用、支持 tools、上下文 >= 32K 的聊天模型；
3. 排序并用一次极短的真实请求验证候选模型（`--no-verify` 可跳过）；
4. 把胜出的模型写入 `opencode.json`（Agent：`arch`、`ux`、`ba`、`sec`、`consilium`）和 `consilium.config.json`；
5. 默认不覆盖你已有的 Agent 模型，除非加 `--force`。

只看方案不写文件：`consilium init --free --dry-run`。

写入原生 V2 格式（`agents` + `system`）：`consilium init --free --native-v2`。

## OpenCode V1 / V2 兼容

包同时支持 OpenCode V1 与 V2，并自动识别配置格式：

| 项目 | V1 | V2 |
| --- | --- | --- |
| `opencode.json` Agent | `agent` + `prompt` | `agents` + `system` |
| MCP 服务器 | `mcp.<name>` + `enabled` | `mcp.servers.<name>` + `disabled` |
| `run --agent` 的模型 | 从配置应用 | **被忽略**，必须显式 `--model` |

- 默认写入 V1 格式：两版都能读取，无需迁移。
- 原生 V2 只在 `--native-v2` 或文件已使用 V2 键时写入。
- 模型始终通过 `--model` 传递，V2 不会退回根模型。
- 自动读取 `agent` 与 `agents`、`.opencode/opencode.json(c)` 及父目录。
- `RATE_LIMITED`（429/免费额度）不再无意义重试，并显示下次可重试时间。
- `consilium doctor` 新增 `opencode-v2-compat` 检查。

MCP 一键注册（格式随已安装的 OpenCode 版本）：

```bash
consilium mcp --install            # ./opencode.json
consilium mcp --install --global   # 全局 OpenCode 配置
```

## 免费模型

```bash
consilium models                 # 前 20 名
consilium models --available     # 仅你可用的提供商
consilium models --verify        # 真实请求验证
consilium models --refresh       # 忽略 12 小时缓存
consilium models --json
```

来源：`models.dev` + OpenRouter + 内置精选回退。缓存路径 `%TEMP%/lv24-opencode-consilium/models-cache.json`（或 `CONSILIUM_MODELS_CACHE`）。

当前推荐组合（2026-11-08 目录）：`arch → opencode/flint-40b-free`、`ux → opencode/inkling-2-small-free`、`ba → opencode/deepseek-v4.1-flash-free`、`sec → opencode/iceman-free`、`chair → opencode/beam-free`。免费模型会轮换，`consilium init --free` 会重新验证并替换 stealth/alpha 模型。

## MCP 服务器（任意宿主）

```bash
consilium mcp
# 或
consilium-mcp
```

OpenCode V1/V2（自动选择格式）：

```bash
consilium mcp --install
```

Claude Desktop / 任意 MCP 客户端：

```json
{
  "mcpServers": {
    "consilium": {
      "command": "npx",
      "args": ["-y", "lv24-opencode-consilium", "mcp"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "lv24-opencode-consilium", "mcp"]
```

工具：`consilium_run`、`consilium_list_agents`、`consilium_free_models`、`consilium_doctor`、`consilium_init_free`。日志只写 stderr，stdout 仅承载协议。

## 主要 CLI 选项

| 选项 | 说明 |
| --- | --- |
| `-e, --experts a,b` | 选择专家 |
| `--chair <agent>` | 主席 Agent |
| `--preset fast\|deep\|security\|review\|free` | 预设 |
| `-f json` | stdout 输出纯 JSON |
| `--diff [--staged] [--base ref]` | 把 git diff 加入任务 |
| `--task-file <file>` / `-` | 从文件或 stdin 读取任务 |
| `--verify` / `--no-verify` | 是否真实验证模型 |
| `--native-v2` | 写入原生 V2 配置 |
| `--install` / `--global` | 在项目或全局配置中注册 MCP |
| `-o <file>` / `--no-save` | 保存 / 不保存结果 |
| `--report <html\|pr\|markdown>` / `--report-file <file>` | 运行后报告（`.html` → html，`.md` → pr；无文件则 stdout，`-f json` 除外） |
| `--variant <name>` | 全员模型 variant（`provider/model#high`），非法则退出 2 |
| `watch [--debounce <ms>]` | 监听变化并重跑（400 ms 防抖，直到 Ctrl+C） |
| `hooks install\|uninstall` | 安装/删除 git pre-commit hook（`git commit` 前评审 staged） |

示例：`git diff | consilium - "审查这些改动"`。

## 报告、watch 与 git hooks（1.4.0）

```bash
consilium --report html --report-file report.html "审查当前改动"  # 自包含 HTML
consilium --report pr "审查当前改动"                              # GitHub 评论 markdown（<!-- consilium:report --> + <details>）
consilium --report-file notes.md "..."                           # .html → html，.md → pr；无文件则输出到 stdout（-f json 除外）
consilium --variant high "..."                                   # 所有模型加 #high，非法的 variant 退出码 2
consilium watch [--debounce <ms>] "审查当前改动"                 # 监听项目变化（忽略 .git/node_modules/dist/.consilium/coverage/*.tmp/*.log），400 ms 防抖，附带 git diff，直到 Ctrl+C
consilium hooks install    # 每次 git commit 前评审 staged 改动，失败则阻止提交
consilium hooks uninstall  # 仅删除托管块，不动 hook 其余内容
```

## OpenCode V2 插件（1.4.0，仅 V2，V1 不可用）

在 TUI 内部直接运行委员会，无需 MCP 与外部 CLI：

```json
{
  "plugins": [{ "package": "lv24-opencode-consilium" }]
}
```

包导出 `./server` → `dist/plugin.js`，提供 `consilium.run` 工具（参数：`task`、`experts`、`chair`、`timeout_ms`、`consensus`、`smart_experts`、`max_cost`、`fallback_models`、`session`、`artifacts`、`preset`）。插件无运行时依赖（`@opencode/plugin` 仅用于类型）。TUI 内用插件，外部宿主用 MCP，终端/脚本/CI 用 CLI。

新增配置键：`report`、`reportFile`、`variant`、`debounceMs`。`--replay <id>` 现在还会恢复主席 agent/模型、专家模型以及产物的 consensus/smartExperts/fallbackModels/session 标志。测试 224 个。

## 1.4.1

- npm 包已更名为 **`lv24-opencode-consilium`**（npm 不支持原地改名；旧的 `opencode-consilium@1.0.2` 仍留在注册表并标记 deprecated）。
- npm 页面现在显示英文 `README.md`；俄语和中文版本移到 `docs/README.ru.md` 与 `docs/README.zh.md`。
- 相比 1.4.0 无功能变化。

## 分析、产物与成本（1.3.0）

- `--consensus` / `--no-consensus`：专家一致性的**词法**分析（关键词交集，Jaccard，中俄英停用词），不是 LLM 评分。简版注入主席提示词，完整报告写入结果与 `metadata.consensus`。
- `--smart-experts`：按任务/ diff 启发式挑选 2–3 个相关角色（默认 2，最多 3，被丢弃的角色会打日志），存于 `metadata.smartExperts`。
- `--max-cost <usd>`：累计成本上限；主席启动前超限则跳过主席，返回带专家意见与共识的部分结果（`errorCode: COST_LIMIT`），明细在 `metadata.cost`。
- `--fallback-models a,b`：遇到 `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` 时，同一专家在备用模型上重试（每专家最多换 2 次），用量累加。
- `--session <id>`：会话基 id，每个 Agent 独占 `ses_<base>-<agent>`（OpenCode 要求 `ses_` 前缀）；未知 Agent 自动用默认 Agent/默认会话运行。该标志**不会**把会话从列表中隐藏。
- `--artifacts` / `--artifacts-dir <path>` / `--no-artifacts`：把运行保存为普通文件 `.consilium/runs/<id>/`（`run.json`、`report.md`、`experts/<agent>.md`）；`consilium --replay <id>` 重跑（恢复专家/主席模型），`consilium --diff-runs <a> <b>` 输出两轮运行的 markdown 对比。
- MCP `consilium_run` 新增参数 `consensus`、`smart_experts`、`max_cost`、`fallback_models`、`session`、`artifacts`；返回含 `cost`、共识摘要与 `**Artifacts:**` 行。
- 配置新增键：`artifacts`（bool|string）、`consensus`（bool）、`smartExperts`（bool）、`maxCost`（number ≥ 0）、`fallbackModels`（string[]）、`session`（string）。

## 配置

配置查找顺序：`consilium.config.json`、`consilium.json`、`.consiliumrc`、`.consiliumrc.json`。完整 JSON Schema：[`schema/config.schema.json`](../schema/config.schema.json)。

```json
{
  "experts": [
    { "name": "arch", "model": "opencode/flint-40b-free" },
    { "name": "sec",  "model": "opencode/iceman-free" }
  ],
  "chair": { "agent": "consilium", "model": "opencode/beam-free" },
  "retry": { "maxConcurrency": 3 }
}
```

关键点：`standalone` 默认 `true`（避免与已运行的 OpenCode 端口冲突）；`autoApprove` 默认 `false`；任务文本通过 **stdin** 传递，不经过 shell。密钥始终由 OpenCode 管理，Consilium 不读取、不打印。

## 开发

```bash
npm install
npm run build
npm test
npm run typecheck
```

许可证：MIT
