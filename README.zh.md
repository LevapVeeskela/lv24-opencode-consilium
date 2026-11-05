# opencode-consilium

面向 [OpenCode](https://opencode.ai) 的 AI 专家委员会：多个角色在**不同模型上并行**回答同一个任务，最后由主席模型综合成最终方案。内置免费模型自动挑选、CLI、库 API，以及可在任意宿主中使用的 **MCP 服务器**（Claude Desktop、Codex、Cursor、VS Code、自有 Agent）。

> 完整文档以英文和俄文为准：[README.md](README.md) · [README.ru.md](README.ru.md)

## 快速开始

```bash
npm install -g opencode-consilium

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

## 免费模型

```bash
consilium models                 # 完整排名
consilium models --available     # 仅你可用的提供商
consilium models --verify        # 真实请求验证
consilium models --refresh       # 忽略 12 小时缓存
consilium models --json
```

来源：`models.dev` + OpenRouter + 内置精选回退。缓存路径 `%TEMP%/opencode-consilium/models-cache.json`（或 `CONSILIUM_MODELS_CACHE`）。

## MCP 服务器（任意宿主）

```bash
consilium mcp
# 或
consilium-mcp
```

Claude Desktop / 任意 MCP 客户端：

```json
{
  "mcpServers": {
    "consilium": {
      "command": "npx",
      "args": ["-y", "opencode-consilium", "mcp"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "opencode-consilium", "mcp"]
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
| `-o <file>` / `--no-save` | 保存 / 不保存结果 |

示例：`git diff | consilium - --diff "审查这些改动"`。

## 配置

配置查找顺序：`consilium.config.json`、`consilium.json`、`.consiliumrc`、`.consiliumrc.json`。完整 JSON Schema：[`schema/config.schema.json`](schema/config.schema.json)。

```json
{
  "experts": [
    { "name": "arch", "model": "opencode/glm-5.3-flash-free" },
    { "name": "sec",  "model": "opencode/nemotron-3.5-lightning-free" }
  ],
  "chair": { "agent": "consilium", "model": "opencode/deepseek-v4.1-flash-free" },
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
