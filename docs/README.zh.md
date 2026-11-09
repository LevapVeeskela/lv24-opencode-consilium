![Consilium — a council of AI experts for OpenCode](https://raw.githubusercontent.com/LevapVeeskela/lv24-opencode-consilium/master/.github/assets/banner.jpg)

# lv24-opencode-consilium

**语言：** [English](../README.md) · [Русский](README.ru.md) · 中文

> **四位专家，四个模型，一份方案。** 面向 [OpenCode](https://opencode.ai)：`arch`、`ux`、`ba`、`sec` 在不同模型上并行作答，主席把答案合并成一份可执行方案。

> 精简中文版；完整文档：[README.md](../README.md) · [README.ru.md](README.ru.md)。
## 30 秒演示
```bash
$ consilium "Review the authentication design"

  arch  → flint-40b-free          architecture, trade-offs
  ux    → inkling-2-small-free    flows, error states
  ba    → deepseek-v4.1-flash-free  scope, edge cases
  sec   → iceman-free             threats, authz, abuse

  chair → beam-free               ← synthesizes one plan
  ✓ 4 experts in parallel · free models · no API bill
```

主席不做摘要：它解决分歧、丢弃薄弱论点，输出带明确取舍的方案；专家跑在不同模型上，盲点不重叠。
## 为什么选择 consilium
- **不同模型 = 不同盲点。** 一个模型漏掉的，另一个能发现；主席把冲突摆明，而不是取平均。
- **默认零成本。** 自动发现免费、支持 tool 的模型，排序、实测后写入配置。
- **复用现有环境。** 认证、provider、agent 都交给 OpenCode CLI，无需额外密钥。
- **同一引擎。** 终端、MCP、原生 V2 插件、库 API 共用一套实现。
## 能力一览
并行议会、主席综合、免费模型引导、`doctor` 预检、运行产物（`--replay`/`--diff-runs`）、HTML/PR 报告、watch、git hooks、MCP、V2 插件、stdin 安全执行器；零运行时依赖，Node >= 18。
## 议会角色
| 角色 | Agent | 关注点 | 典型问题 |
| --- | --- | --- | --- |
| 🏛 | `arch` | 架构与取舍 | 10 倍负载下什么先崩？ |
| 🎨 | `ux` | 流程、API 易用性、错误态 | 失败时用户看到什么？ |
| 📋 | `ba` | 需求与范围 | 什么不在范围内？ |
| 🛡 | `sec` | 威胁、授权、滥用 | 谁能调用？会泄露什么？ |
| ⚖️ | `consilium` | 主席 | 合并答案、解决冲突 |

想少几个声音：`-e arch,sec`、`--smart-experts` 或预设。
## 安装
```bash
npm install -g lv24-opencode-consilium
npx -y lv24-opencode-consilium --help   # 不安装直接运行
```

要求：Node.js **>= 18**、已认证的 OpenCode CLI（`npm install -g opencode-ai`，**V1 或 V2**）；可选 `OPENROUTER_API_KEY`。
### 容器镜像（GHCR）
自包含镜像（Node.js、OpenCode CLI、`git`）支持 `linux/amd64` 与 `linux/arm64`；`docker pull ghcr.io/levapveeskela/lv24-opencode-consilium:1.9.0`（或 `:latest`），用 `docker run --rm ghcr.io/levapveeskela/lv24-opencode-consilium:latest --version` 验证（`consilium v1.9.0`）。镜像页：[GHCR](https://github.com/LevapVeeskela/lv24-opencode-consilium/pkgs/container/lv24-opencode-consilium)。

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.local/share/opencode:/home/node/.local/share/opencode" \
  -v "$HOME/.config/opencode:/home/node/.config/opencode:ro" \
  -u "$(id -u):$(id -g)" \
  ghcr.io/levapveeskela/lv24-opencode-consilium:latest \
  "Design a rate limiter for a public API"
```

入口是 `consilium`（所有参数可用），MCP 用 `--entrypoint consilium-mcp`；镜像内 `HOME=/home/node`，配置在 `/home/node/.config/opencode`，凭据在 `/home/node/.local/share/opencode`。Windows 去掉 `-u`，用 `%CD%` / `%USERPROFILE%`。
## 快速开始
```bash
consilium doctor                    # 检查 CLI、配置、Agent、模型
consilium init --free               # 挑选并验证免费模型，写入配置
consilium "Design a rate limiter for a public API"
```

`init --free` 从 `https://models.dev/api.json` 与 `https://openrouter.ai/api/v1/models` 只保留免费（`cost = 0`）、活跃、支持 tool calling、上下文 >= 32K 的模型，排序并做一次真实请求探测（`--no-verify` 跳过），把胜出者写入 `opencode.json`（`arch`、`ux`、`ba`、`sec`、`consilium`）和 `consilium.config.json`；默认不覆盖已有模型，除非 `--force`。另有两个开关：`--dry-run`（只预览）、`--native-v2`（原生 V2 的 `agents` + `system`）。
## OpenCode V1 / V2 兼容
两个分支都支持，配置形态自动识别。

| 项目 | OpenCode V1 | OpenCode V2 |
| --- | --- | --- |
| `opencode.json` Agent | `agent` + `prompt` | `agents` + `system` |
| MCP 服务器 | `mcp.<name>` + `enabled` | `mcp.servers.<name>` + `disabled` |
| 命令 | `command` + `subtask` | `commands` + `subagent` |
| `run --agent` 的模型 | 从配置应用 | **被忽略**，必须显式 `--model` |

默认写 V1 格式（两版都能读），原生 V2 仅在 `--native-v2` 或文件已用 V2 键时写入；模型始终以 `--model` 传递；Agent 从 `agent`/`agents`、`.opencode/opencode.json(c)` 及父目录读取。`RATE_LIMITED` 短时限（<= 30 秒）自动重试，长时限立即失败并给出延迟；`doctor` 报告 CLI 版本、配置格式与 V2 兼容问题。一键注册 MCP：`consilium mcp --install`（项目）、`consilium mcp --install --global`（全局），再用 `opencode mcp list` 验证。
## 上下文包（`--context auto`）
专家默认只看到任务和 diff。`--context auto` 会补充改动文件、最近的 `AGENTS.md`、相关测试和近期提交：

```bash
consilium --context auto --diff "Review the current changes"
```

优先级与预算：规则 → 改动文件 → 相关测试 → 提交；总计 48k 字符、单文件 12k、最多 20 个文件。二进制、锁文件和生成文件会跳过；每段都包在 `<untrusted-*>` 标记里，仓库文本无法冒充指令。`--context off`（默认）保持旧行为。
## 免费模型自动挑选
`consilium models`（前 20）、`--available`（仅可用提供商）、`--verify`（真实请求）、`--refresh`（忽略 12 小时缓存）、`--json`。来源：`models.dev`、OpenRouter 的 `:free` 变体和内置精选清单；缓存 `%TEMP%/lv24-opencode-consilium/models-cache.json`（或 `CONSILIUM_MODELS_CACHE`）。

当前推荐：`arch → opencode/flint-40b-free`、`ux → opencode/inkling-2-small-free`、`ba → opencode/deepseek-v4.1-flash-free`、`sec → opencode/iceman-free`、`chair → opencode/beam-free`。`opencode-go` 的免费模型（`*-free` 等）也参与排序，但 `opencode-go/muse-spark-1.3-contributor` 这类付费模型不会被 `--free` 选中，需在 `experts[].model` 或 `chair.model` 指定。免费模型会轮换，`init --free` 复核目录与真实响应，`--refresh` 挑选替代者；排序（0–1.2）按上下文、tool calling、结构化输出、推理、新旧、输出上限、家族先验和付费同级“影子价格”加权。

调用结果记录在 `.consilium/reliability.json`（每个模型的成功、限流、超时、延迟）。`consilium models --reliability` 打印表格；模型累计至少 3 次尝试后，排序会接受可选的可信度加分。该文件仅本地保存，可安全删除。
## 本地与隐私模式
只在本机提供商上运行（Ollama、LM Studio、llama.cpp、vLLM）：

```bash
consilium models --local              # 排名目录中只保留本地模型
consilium models --probe-local        # Ollama / LM Studio 是否在运行？
consilium init --local                # 探测并写入 localOnly 配置
consilium init --local --dry-run      # 只预览模型分配，不写文件
consilium --local-only "Review the changes"
```

`init --local` 向 Ollama（`/api/tags`）和 LM Studio（`/v1/models`）查询模型列表，将模型轮流（round-robin）分配给 `arch`、`ux`、`ba`、`sec` 和主席，并写入含 `localOnly: true` 的 `consilium.config.json`（不加 `--force` 不覆盖现有文件）。支持 `--dry-run` 与 `--json`。

`--local-only` 是硬性保证：每位专家和主席都必须有明确的本地提供商模型，否则在启动前直接拒绝运行（退出码 2、MCP 工具错误或库错误）。缺少模型就是错误，不会隐式回退到云端。`doctor` 新增 `local-providers` 检查：当 `localOnly` 开启且没有任何本地提供商可达时，该检查失败。
## 在任意宿主中使用（MCP）
`consilium mcp` 或直接二进制 `consilium-mcp` 启动 stdio 服务器。**Claude Desktop**（`claude_desktop_config.json`）示例：

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

Codex 在 `~/.codex/config.toml` 里用同一组 `command`/`args`（`[mcp_servers.consilium]`），任何 stdio JSON-RPC 2.0 客户端都可用；日志只写 **stderr**，stdout 仅承载协议。

| 工具 | 参数 / 结果 |
| --- | --- |
| `consilium_run` | `task`（必填）、`experts`、`chair`、`timeout_ms`、`deadline_ms`、`local_only`、`rounds`、`format`、`preset`、`output_file`、`consensus`、`smart_experts`、`max_cost`、`fallback_models`、`session`、`artifacts`、`findings` → 方案 + 意见 + 元数据（含截止时间与辩论信息） |
| `consilium_list_agents` | 专家、模型、主席、预设、配置路径 |
| `consilium_free_models` | `limit`、`available_only`、`refresh`、`local_only`、`probe_local` |
| `consilium_doctor` | 环境/配置诊断 |
| `consilium_init_free` | `apply`、`force`、`confirm`、`verify`；默认只给方案 |

`consilium_run` 支持 `progressToken`，响应含 `cost`、共识摘要和 `**Artifacts:**` 行；`force` 需要同时传 `confirm: true`，写入前会生成 `.bak`。
## 面向 AI 代理
```json
{
  "package": "lv24-opencode-consilium",
  "version": "1.9.0",
  "bins": ["consilium", "consilium-mcp", "lv24-opencode-consilium"],
  "mcp": { "command": "npx", "args": ["-y", "lv24-opencode-consilium", "mcp"] },
  "json_mode": "consilium -f json \"<task>\"",
  "findings": "consilium --findings -f json \"<task>\" -> metadata.findings",
  "models_json": "consilium models --json",
  "config_files": ["consilium.config.json", "consilium.json", ".consiliumrc", ".consiliumrc.json"],
  "config_schema": "schema/config.schema.json",
  "exit_codes": { "0": "success", "1": "run failed", "2": "usage error", "3": "策略门禁失败" },
  "docs_index": "llms.txt"
}
```

- **stdout 放数据，stderr 放进度。** 用 `-f json`、`consilium models --json` 或 MCP，不要解析人类文本。
- **错误类型化。** `errorCode` 为 `RATE_LIMITED`、`MODEL_UNAVAILABLE`、`EMPTY_RESPONSE`、`AGENT_NOT_FOUND`、`COST_LIMIT`、`TIMEOUT` 等，退出码 `0/1/2/3`（`3` = 策略门禁）。
- **状态是文件。** 产物在 `.consilium/runs/<id>/`，`--replay <id>` 复原；`--auto` 默认关闭。

机器索引：[`llms.txt`](../llms.txt)；内部实现：[`session-and-plugin.md`](session-and-plugin.md)。
## CLI 参考
```text
consilium [options] <task>
consilium <task> -                  # read the task from stdin
consilium init [--free|--local] [--dry-run] [--force] [--no-verify] [--native-v2]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp [--install] [--global]
consilium watch [--debounce <ms>] [task]
consilium hooks install|uninstall
consilium baseline accept <id|latest> [--dry-run]
consilium baseline prune [--older-than <days>] [--all --yes]
consilium eval [--fixtures <dir>] [--json] [--rounds <1|2>] [--compare-rounds] [--fail-under <pct>] [--max-cost <usd>]
consilium history [--limit N] [--json]
consilium stats [--json] [--html <file>]
consilium presets [--json]
consilium audit --since <ref> [--dry-run] [--fail-on <severity>] [--json]
```

| 选项 | 说明 |
| --- | --- |
| `-c, --config <file>` / `-e, --experts a,b` / `--chair <agent>` | 配置文件 / 专家子集 / 主席 |
| `--preset <name>` | `fast`、`deep`、`security`、`review`、`free` 或配置中的自定义预设 |
| `--deadline <ms>` / `--local-only` | 专家阶段时限（最多 24 小时，超时后部分综合）/ 每个 Agent 必须显式使用本地模型，启动前拒绝非本地提供商 |
| `--rounds <1\|2>` | `2` 增加匿名化同伴评审轮次，适用于 run/watch/eval，模型调用翻倍（默认 1） |
| `--compare-rounds` | `eval`：以一轮和两轮分别运行每个 fixture，并打印差值表 |
| `--expert-timeout`、`--chair-timeout`、`-r, --retries <n>` | 每次尝试超时（ms）、重试（0 = 一次） |
| `-o, --output <file>` / `--no-save` / `-f, --format <fmt>` | 保存 / 不保存 / `text`、`markdown`、`json` |
| `--task-file <file>` / `-s, --silent` / `-V, --verbose` / `-v, --version` / `-h, --help` | 文件或 stdin 读任务 / 只出结果 / 原始事件 / 版本 / 帮助 |
| `--consensus` / `--no-consensus` / `--smart-experts` | 词法一致性 / 启发式选 2–3 个角色 |
| `--max-cost <usd>` / `--fallback-models a,b` | 成本上限（`COST_LIMIT`）/ 换模型重试（最多 2 次） |
| `--session <id>` / `--variant <name>` | 会话基 id（`ses_<base>-<agent>`）/ variant，非法退出 2 |
| `--artifacts`、`--no-artifacts`、`--artifacts-dir <path>`、`--replay <id>`、`--diff-runs <a> <b>` | 产物 / 目录 / 重跑 / 对比 |
| `--report <html\|pr\|markdown\|sarif>`、`--report-file <file>`、`--diff [--staged] [--base <ref>]`、`--debounce <ms>` | 报告（SARIF 2.1.0）/ 写文件（`.sarif`/`.sarif.json` 推断为 SARIF）/ git diff / watch 防抖 |
| `watch` / `hooks install\|uninstall` / `--native-v2` / `--install`、`--global` | 监听重跑 / pre-commit hook / 原生 V2 配置 / 注册 MCP |
| `--findings` / `--no-findings` / `--fail-on <severity>` / `baseline accept\|prune` | 结构化发现开关 / 新发现达到阈值时退出 `3`（`critical`…`none`）/ 管理 `.consilium/baseline.json` |
| `--context <off\|auto>` / `eval [--fixtures <dir>]` / `--fail-under <pct>` / `--reliability` | 上下文包（`auto`，默认 `off`）/ 运行评估 fixture（默认 `eval/fixtures`）/ eval 门禁：低于 catch 百分比退出 `3` / `models` 打印 `.consilium/reliability.json` 的成功率与延迟 |
| `history [--limit N]` | 最近运行：成功、成本、发现、一致性（`.consilium/runs`；`--json` 可用） |
| `stats [--html <file>]` | 成功率、p50/p95 延迟、成本、发现与按模型错误（`--json`；`--html` 写静态报告） |
| `presets [--json]` / `models --local` / `--probe-local` | 列出内置与自定义预设 / 仅本地模型排名 / 探测 Ollama、LM Studio |
| `init --local` | 探测 Ollama/LM Studio，将本地模型轮流分配给各角色与主席，写入 `localOnly: true` 配置；`--dry-run` 不写文件，`--json` 输出机器可读结果 |
| `audit --since <ref>` | 端到端评审 `<ref>...HEAD`；`--dry-run` 只构建 diff，不调用模型 |

退出码：`0` 成功，`1` 运行失败，`2` 用法错误，`3` 策略门禁失败。示例：`consilium -e arch,sec "Threat-model the upload endpoint"`、`git diff --staged | consilium - --diff "Review these changes"`、`consilium -f json "..." > council.json`。
## 运行产物/报告/watch/git hooks
```bash
consilium --report html --report-file report.html "Review the current changes"
consilium --report pr "Review the current changes"
consilium --report-file notes.md "..."      # .html → html，.md → pr，.sarif → sarif
consilium watch --debounce 500 "Review the current changes"
consilium hooks install                     # 提交前评审 staged，失败则阻止提交
consilium hooks uninstall                   # 只删托管块
```

产物是普通文件：`.consilium/runs/<id>/` 下的 `run.json`、`report.md`、`experts/<agent>.md`。PR 报告带 `<!-- consilium:report -->` 和 `<details>`；HTML 自包含；hook 只写 `# >>> consilium >>>` … `# <<< consilium <<<` 块。
## 结构化发现与策略门禁
用 `--findings` 让评审返回结构化发现；每个专家（和主席）在回答末尾附一个 `json` 代码块：

```json
{"findings":[{"severity":"high","category":"security","file":"src/auth.ts","line":42,"claim":"删除项目未校验归属","evidence":"handler 调用 remove() 前没有 authorize()","confidence":0.9}],"rejected":[{"claim":"middleware 已校验归属","reason":"该路由未挂载 middleware"}]}
```

- `severity`：`critical`/`high`/`medium`/`low`/`info`；`claim` 必填，其余可选。
- 按稳定指纹去重（category + file + 规范化 claim，忽略行号），严重性取最高值；主席拒绝的条目标记 `contested` 并列入 `rejected`。
- `metadata.findings` = `{ items, counts, rejected, parseErrors }`；HTML/PR 报告渲染表格与异议账本（dissent ledger）。
- JSON 缺失或损坏不会让运行失败：保留正文，问题记入 `parseErrors`。

```bash
consilium baseline accept latest            # 接受最近一次运行的发现
consilium baseline prune --older-than 90    # 或 --all --yes
consilium --findings --fail-on high --diff "Review the current changes"
```

- `consilium baseline accept <id|latest> [--dry-run]` / `prune [--older-than <days>] [--all --yes]` 管理 `.consilium/baseline.json`；`--fail-on <severity>` 只针对**新**发现并在命中时退出 `3`；不带 `--findings` 的 `--fail-on` 是用法错误。baseline 文件可提交，与团队共享已接受的发现。

## SARIF 与代码扫描
```bash
consilium --findings --report sarif --report-file consilium.sarif "Review the current changes"
```

`--report sarif` 输出 SARIF 2.1.0，可用于 GitHub code scanning 及其他 SARIF 查看器：每个发现一条结果，`critical`/`high` → `error`，`medium` → `warning`，`low`/`info` → `note`，包含文件/行号位置、稳定指纹和每个类别一条规则。`--report-file` 根据 `.sarif`/`.sarif.json` 推断格式。在 CI 中用 `github/codeql-action/upload-sarif` 上传；已加入 baseline 的发现仍会出现在文件中，除非将其过滤掉。

## 截止时间与部分综合
长时间运行的免费模型不应拖住 CI 或 pre-commit hook：

```bash
consilium --deadline 180000 --diff "Review the current changes"
```

`--deadline <ms>` 限制专家阶段（最多 24 小时；配置中为 `deadlineMs`）。触发时，仍在运行的专家会被取消，已完成的回答保留，主席据此综合，并明确注明有多少专家完成、哪些角色缺失。`metadata.deadline` = `{ limitMs, hit, completed, missing }`。若没有任何专家完成，主席被跳过，运行以 `errorCode: DEADLINE` 失败（退出码 1）；只要至少有一位专家完成，部分运行即为成功。

## 辩论轮次
`--rounds 2` 增加第二轮：每位专家看到匿名化的同伴回答（A/B/C），指出错误与遗漏并给出最终立场；主席收到最终立场以及哪些专家改变了立场，`metadata.debate = { rounds, participants, changed }`。

```bash
consilium --rounds 2 --preset deep "Design the migration plan"
```

第二轮使模型调用翻倍，因此为可选项：成功专家少于两位、触发截止时间或已超过 `--max-cost` 时跳过。第二轮延续每位专家的会话，发现从最终回答中收集；第一轮回答会包含在该专家自己的第二轮提示中，同伴回答匿名化并标记为数据。

## 评估工具（`consilium eval`）
确定性地证明议会比单个模型发现更多：

```bash
consilium eval --fixtures eval/fixtures --json
consilium eval --fail-under 70        # 低于 70% catch rate 时退出 3
consilium eval --max-cost 0.50        # 预算耗尽时停止
```

每个 fixture 是一段任务、一个埋入 bug 的小 diff 和 `expected.json`（`mustFind` / `mustNotFind` 为 claim 子串，可选 `file`、`category`、`minSeverity`）。匹配是规范化后的 claim 子串检查——不用 LLM 裁判——因此结果可复现。报告给出每个 fixture 的 caught/missed/false positives、总体 catch 与 FP 率、p50 延迟和成本。内置十个种子 fixture：[`eval/fixtures`](../eval/fixtures)，可在旁边添加自己的。

在同一批 fixture 上比较单轮与辩论轮次：

```bash
consilium eval --compare-rounds
consilium eval --rounds 2 --json
```

`--compare-rounds` 对每个 fixture 运行两次（一轮和两轮），打印 catch rate、FP rate、p50 延迟和总成本的差值表，并给出结论。`--fail-under` 以辩论的 catch rate 作为门禁；`--max-cost` 覆盖两次运行。

## 历史与统计

```bash
consilium history --limit 10       # 最近运行：成功、成本、发现、一致性
consilium stats                    # 成功率、p50/p95、成本、按模型错误
consilium stats --html stats.html  # 自包含静态报告
```

- `consilium history [--limit N] [--json]` — 从 `.consilium/runs/<id>/run.json` 读取最近运行：成功、成本、发现与一致性；损坏的运行会跳过并给出警告。
- `consilium stats [--json] [--html <file>]` — 成功率、p50/p95 延迟、总成本、按严重性统计的发现与 `contested` 数量、按模型的尝试/错误次数以及最常见的失败代码。
- `stats --html` 写出经过转义、无脚本的静态页面。
- 两个命令都只读数据，不需要守护进程。

## 审计提交范围
```bash
consilium audit --since v1.7.0 --fail-on high
consilium audit --since HEAD~5 --dry-run
```

`audit` 为 `<ref>...HEAD` 构建不可信 diff，运行议会，并复用报告、产物与策略门禁。`--dry-run` 只打印 ref、文件数和截断标记，不调用模型；`--since` 为必填项并会校验（不允许 shell 元字符）。用 cron、任务计划程序或 CI 定期调度——没有内置守护进程。

## 定时运行
[`scheduling.md`](scheduling.md) 提供 cron、Windows 任务计划程序、launchd 和 GitHub Actions 的现成方案，使用 `consilium audit --since <ref>` 配合 `--deadline` 与 `--max-cost`。可直接运行的包装脚本位于 [`examples/consilium-audit.sh`](../examples/consilium-audit.sh)、[`examples/consilium-audit.ps1`](../examples/consilium-audit.ps1) 和 [`examples/consilium-audit-nightly.yml`](../examples/consilium-audit-nightly.yml)。示例 workflow 特意放在 `.github/workflows/` 之外，因此本仓库不会自动运行任何内容。

## OpenCode V2 插件
在 OpenCode V2 TUI 内运行议会，无需 MCP 或外部 CLI（V1 插件 API 不兼容）。

配置 `{ "plugins": [{ "package": "lv24-opencode-consilium" }] }`。导出 `./server`（`dist/plugin.js`），无运行时依赖；`consilium.run` 接受 `task`、`experts`、`chair`、`timeout_ms`、`consensus`、`smart_experts`、`max_cost`、`fallback_models`、`session`、`artifacts`、`preset`。

斜杠命令：`.opencode/commands/council.md`（或全局 `~/.config/opencode/commands/`），用法 `/council <task>`；需要先注册 V2 插件或 MCP 服务器。

## GitHub Action
复合 Action 会评审 PR diff，并发布或更新恰好一条带 `<!-- consilium:report -->` 标记的评论：

```yaml
- uses: LevapVeeskela/lv24-opencode-consilium/.github/actions/consilium@v1.9.0
  with:
    fail-on: high
    github-token: ${{ github.token }}
```

它运行 `consilium --diff --base origin/<base> --report pr --report-file consilium-review.md --fail-on <level>`，只评论一次，然后传递门禁退出码（`3`）。Fork PR 默认跳过（没有 secrets）；用 `version` 输入固定 npm 版本。它在你自己的 runner 上运行——无托管应用、无付费服务。完整指南：[`github-action.md`](github-action.md)。

## 预设
| 预设 | 专家 | 行为 |
| --- | --- | --- |
| `fast` | arch, sec | 专家 3 分钟超时，不重试 |
| `deep` | 全部四个 | 超时翻倍，启用重试 |
| `security` | sec, arch, ba | 安全评审 |
| `review` | arch, sec, ux | 代码评审 |
| `free` | 全部四个 | 免费模型引导 |

自定义预设放在 `consilium.config.json` 中，并合并覆盖内置预设：

```json
{
  "presets": {
    "docs": { "description": "Documentation review", "experts": ["arch", "ba"] }
  }
}
```

`consilium presets` 列出合并后的集合（脚本可用 `--json`）；`--preset docs` 在 CLI、MCP `consilium_run` 和 V2 插件中都可用。自定义预设可以覆盖内置名称，其字段会替换内置字段。
## 配置
当前目录查找 `consilium.config.json`、`consilium.json`、`.consiliumrc`、`.consiliumrc.json`，或用 `-c` 指定；`opencode.json(c)` 允许 JSONC 注释。

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

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `experts[].model` / `chair.model` | — | `provider/model`，以 `--model` 传入并覆盖 Agent 模型 |
| `timeouts.expert` / `.chair`；`retry.expertRetries` / `.chairRetries` | 300000 / 600000；1 | 每次尝试 ms；重试次数（0 = 一次） |
| `retry.jitter` / `retry.maxConcurrency` / `output.file` | `false` / 3 / `false` | 随机延迟（50–100%）/ 并行 1–8 / 关闭保存 |
| `standalone` / `autoApprove` / `autoDiscoverAgents` | `true` / `false` / `true` | 私有服务器 / 仅配置，自动批准权限（项目配置中除非 `-c` 否则忽略）/ 复用 Agent |
| `artifacts` / `consensus` / `smartExperts` / `findings` | `false` | `true` → `.consilium/runs/<id>/`；词法一致性；启发式选角色；结构化发现 |
| `context` | `off` | `auto` 将改动文件、项目规则、相关测试和提交加入任务 |
| `deadlineMs` / `rounds` / `localOnly` / `presets` | — / `1` / `false` / — | 专家阶段时限（ms，最多 24 小时，超时后部分综合）/ `2` 为匿名化同伴评审轮次，模型调用翻倍 / 每个 Agent 必须显式使用本地模型 / 自定义预设合并覆盖内置预设 |
| `maxCost` / `fallbackModels` / `session` / `report` / `reportFile` / `variant` / `debounceMs` | 多为 —；`debounceMs` 400 | USD 上限 / 备用模型 / 会话基 id / 报告格式 / 报告文件 / variant / watch 防抖 |
| `opencodePath` / `cwd` | `opencode` / 当前目录 | CLI 路径 / 工作目录；项目配置中除非用 `-c` 否则忽略 |

完整 Schema：[`../schema/config.schema.json`](../schema/config.schema.json)。
## 库 API
```ts
import { Consilium, runConsilium, fetchFreeModels, selectCouncilModels } from 'lv24-opencode-consilium';

const council = new Consilium();
council.onProgress(event => console.error(event.type, event.agent ?? ''));
const result = await council.run('Design a cache invalidation strategy');
console.log(result.text, result.usage?.cost);   // chair synthesis, total cost
const oneShot = await runConsilium('...');      // ConsiliumResult
const { models } = await fetchFreeModels({ includeUnavailable: true });
const top = selectCouncilModels(models, 5);
```

`Consilium` 实例可复用（完成、失败或取消后仍可 `run()`），`cancel()` 停止当前运行的所有子进程。
## 工作原理
每个专家和主席都通过 `opencode run --standalone --format json [--auto] [--agent=NAME] [--model=provider/model]` 启动；提示词经子进程 **stdin**（UTF-8）传入，任意文本都安全。NDJSON 事件增量解析（`text`、`step_finish` 的用量/成本、带 `type`/`status`/`retryAfterMs` 的 `error`）；模型始终以 `--model` 传递，Agent 缺失时用默认 Agent 加同一模型重试一次。
## 安全
- 任务文本从不拼进 shell，一律经 stdin；Agent 名和模型 ID 使用前校验；`--standalone` 隔离端口。
- **项目配置默认不可信**：仓库里的 `consilium.config.json` 可定义模型/专家/提示词/预设，但 `opencodePath`、`opencodeArgs`、`autoApprove`、`cwd`、`opencodeConfigPath`、字符串 `output.file`/`reportFile`/`artifacts` 会被忽略并告警；只有用 `-c` 显式传入才信任。
- **Windows**：`.cmd`/`.bat` 仅在每个参数通过严格白名单后才经 `cmd.exe` 启动；`.exe` 与 POSIX 直接启动。
- **MCP**：`tools/call` 必须有 `id`，队列上限 16，`output_file`/产物路径限制在 workspace 内，`init_free` 写 `.bak` 且 `force` 需要 `confirm: true`。
- `autoApprove` 默认**关闭**；产物会脱敏常见 token 并自动生成 `.consilium/.gitignore`。
- 不打印或写入 API 密钥；`doctor` 只检查环境变量并告警，认证由 OpenCode 负责。
## 故障排查
| 症状 | 处理 |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` 或设置 `opencodePath` |
| `Model unavailable` | 模型轮换/区域受限；`consilium models --verify --refresh` |
| `Agent not found` | 角色缺失；自动退回默认 Agent + 你的模型，用 `consilium init --free` 补齐 |
| `RATE_LIMITED` / 429 | 免费额度用尽；按错误延迟重试或换提供商 |
| V2 上模型被忽略 | 已传 `--model`；运行 `consilium doctor`（`opencode-v2-compat`） |
| `COST_LIMIT` | 主席按设计跳过；部分结果含意见与共识，花费见 `metadata.cost.byAgent` |
| V2 上 MCP 缺失 | 平铺 `mcp.<name>` 被忽略；`consilium mcp --install --force` |
## 更新日志
- **1.9.0** — SARIF 导出、辩论评估与调度方案：`--report sarif` 输出 SARIF 2.1.0（严重性映射、文件/行号位置、稳定指纹、按类别划分的规则 id），可用于 GitHub code scanning 及其他 SARIF 查看器，`.sarif`/`.sarif.json` 扩展名自动推断；`eval --compare-rounds` 以一轮和两轮运行每个 fixture 并打印 catch/FP/p50/cost 差值，`eval --rounds 2` 以辩论模式运行整套用例；`docs/scheduling.md` 与 cron、任务计划程序、launchd、GitHub Actions 示例让提交范围审计无需守护进程即可定时执行；515 个测试。
- **1.8.0** — 辩论轮次、本地引导与提交范围审计：`--rounds 2` 增加匿名化同伴评审，每位专家点评他人并给出最终立场，主席看到最终立场及哪些专家改变立场，`metadata.debate` 记录参与者与变化；`consilium init --local` 探测 Ollama/LM Studio，将本地模型轮流分配给各角色和主席，并写入 `localOnly` 配置；`consilium audit --since <ref>` 端到端评审提交范围，复用报告、产物与 `--fail-on`，`--dry-run` 不调用模型即可打印请求；491 个测试。
- **1.7.0** — 截止时间与隐私：`--deadline <ms>` 限制专家阶段，超时后取消落后专家、保留已完成的回答，主席带缺失角色说明进行部分综合；没有任何专家完成时以 `DEADLINE` 失败。`--local-only` 要求每位专家和主席都显式使用本地模型（Ollama、LM Studio、llama.cpp、vLLM）；`models --local` 过滤目录，`models --probe-local` 检查本地提供商是否运行；`doctor` 新增 `local-providers` 检查。`consilium.config.json` 中的自定义预设合并覆盖内置预设，并可在 CLI、MCP 和插件中使用（`consilium presets` 列出）。受信任配置标记现在能跨对象展开保留。446 个测试。
- **1.6.0** — 评估工具、上下文包、可靠性记忆与 GitHub Action：`consilium eval` 用埋入 bug 的 fixture 和确定性 claim 匹配报告 catch/FP/p50 延迟/成本（`--fail-under` 低于阈值退出 `3`）；`--context auto` 在字符预算内补充改动文件、最近的 `AGENTS.md`、相关测试和近期提交；模型结果与延迟写入 `.consilium/reliability.json`（`models --reliability`）；复合 GitHub Action 评审 PR diff 并发布或更新一条评论；模糊 claim 合并去重同义发现；`consilium history` 与 `consilium stats` 汇总运行、延迟与可靠性；381 个测试。
- **1.5.0** — 结构化发现与策略门禁：`--findings` 让专家和主席返回经过校验的 `findings[]` JSON（`severity`、`category`、`file`、`line`、`claim`、`evidence`、`confidence`），按稳定指纹去重合并，主席拒绝的条目记为 `contested`，并写入 `metadata.findings`；HTML/PR 报告渲染发现表与异议账本；`--fail-on <severity>` 只对**新**发现生效并以退出码 `3` 阻断，`consilium baseline accept|prune` 管理 `.consilium/baseline.json`。同时包含 P1 正确性修复（V1/V2 配置优先级、损坏配置告警、模型缓存回退/`minContext`/去重、成本遥测、SIGKILL 升级、`ses_` 会话前缀、CLI `argv[0]` 解析、watch 重跑/信号、preset/consensus/smart-experts 边界情况）以及 `/council` 斜杠命令；317 个测试。
- **1.4.3** — 安全加固：项目配置默认不可信（`opencodePath`、`opencodeArgs`、`autoApprove`、`cwd`、`opencodeConfigPath`、字符串写入路径需用 `-c` 显式信任）；Windows `.cmd` 参数白名单；MCP 拒绝无 `id` 的调用、限制队列、限制产物路径，`init_free` 生成 `.bak` 且 `force` 需确认；diff fence 与报告转义防注入；产物脱敏并生成 `.gitignore`；246 个测试。
- **1.4.2** — 内部分层重构（`shared`、`domain`、`application`、`infrastructure`、`interfaces`）与切片 barrel；API 与行为不变，22 个 subpath 的导出与 1.4.1 完全一致；全新 README、`llms.txt`、`docs/architecture.md`；ru/zh 同步；构建前清理 `dist`；224 个测试。
- **1.4.1** — 包更名 `lv24-opencode-consilium`（`opencode-consilium@1.0.2` 保持 deprecated）；译文移到 `docs/`；GHCR 镜像；无功能变化。
- **1.4.0** — `--report`/`--report-file`、`--variant`、`watch`、`hooks`、V2 插件、`--replay` 恢复模型与标志；新增 `report`、`reportFile`、`variant`、`debounceMs`；224 个测试。
- **1.3.0** — 运行产物、`--replay`/`--diff-runs`、`--consensus`、`--smart-experts`、`--max-cost`、`--fallback-models`、`--session` 及对应 MCP 参数。
- **1.2.0** — 支持 V2 并保留 V1：双配置段、目录合并、始终传 `--model`、`mcp.servers`、`--native-v2`。
## 路线图
- TUI 的 `consilium` slash 命令（S）；报告导出到 Jira/Linear（S）。
## 开发
`npm install` → `npm run build`（tsc）→ `npm test`（build + node:test，515 个测试）→ `npm run typecheck`（`tsc --noEmit`）。
## 许可证
[MIT](../LICENSE)
