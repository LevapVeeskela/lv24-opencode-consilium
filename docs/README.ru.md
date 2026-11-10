![Consilium — a council of AI experts for OpenCode](https://raw.githubusercontent.com/LevapVeeskela/lv24-opencode-consilium/master/.github/assets/banner.jpg)

# lv24-opencode-consilium

[![npm](https://img.shields.io/npm/v/lv24-opencode-consilium?label=npm&color=cb3837&logo=npm)](https://www.npmjs.com/package/lv24-opencode-consilium)
[![downloads](https://img.shields.io/npm/dm/lv24-opencode-consilium?color=cb3837)](https://www.npmjs.com/package/lv24-opencode-consilium)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Flevapveeskela%2Flv24--opencode--consilium-2496ED?logo=docker&logoColor=white)](https://github.com/LevapVeeskela/lv24-opencode-consilium/pkgs/container/lv24-opencode-consilium)
[![license](https://img.shields.io/badge/license-MIT-2ea44f)](../LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](../package.json)
[![OpenCode](https://img.shields.io/badge/OpenCode-V1%20%7C%20V2-6C5CE7)](https://opencode.ai)

**Языки:** [English](../README.md) · Русский · [中文](README.zh.md)

**Четыре эксперта. Четыре модели. Один план.** Consilium запускает `arch`, `ux`, `ba` и `sec` параллельно на разных моделях, а модель-председатель сводит их ответы в единый план действий. Работает внутри OpenCode, Claude Desktop, Codex, Cursor, VS Code, CI и ваших собственных агентов. Установка: `npm install -g lv24-opencode-consilium`, затем `consilium doctor` и `consilium "ваша задача"`.

| 🚀 Старт | 🧠 Использование | 🛠 Разработка |
| --- | --- | --- |
| [Установка](#установка) · [Быстрый старт](#быстрый-старт) · [Бесплатные модели](#бесплатные-модели-автоматически) | [MCP-сервер](#использование-из-любого-харнесса-mcp) · [Для ИИ-агентов](#для-ии-агентов) · [CLI](#справочник-cli) · [Отчёты и хуки](#артефакты-отчёты-watch-и-git-хуки) | [Плагин V2](#плагин-opencode-v2) · [Пресеты](#пресеты) · [Конфиг](#конфигурация) · [API библиотеки](#библиотечный-api) · [Безопасность](#безопасность) · [Диагностика](#диагностика) |

## Посмотрите в деле

```bash
$ consilium "Оцени дизайн аутентификации"

  arch  → flint-40b-free            архитектура, компромиссы
  ux    → inkling-2-small-free      потоки, состояния ошибок
  ba    → deepseek-v4.1-flash-free  объём задачи, крайние случаи
  sec   → iceman-free               угрозы, authz, злоупотребления

  chair → beam-free                 ← синтезирует единый план
  ✓ 4 эксперта параллельно · бесплатные модели · без счёта за API
```

Председатель не пересказывает — он разрешает разногласия, отбрасывает слабые места и возвращает один план с явными компромиссами. Каждый эксперт работает на своей модели, поэтому слепые зоны не совпадают.

## Зачем нужен consilium

- **Разные модели — разные слепые зоны.** Одна модель пропускает то, что ловит другая; председатель делает конфликт явным, а не усредняет его.
- **Ноль стоимости по умолчанию.** Находит бесплатные модели с поддержкой tools в публичных каталогах, ранжирует их, проверяет, что они реально отвечают в вашем регионе, и прописывает в конфиг.
- **Работает с тем, что уже есть.** Авторизация, провайдеры и агенты — на стороне OpenCode CLI: никакого второго стека провайдеров и лишних ключей.
- **Один движок везде.** Терминал, MCP-сервер для любого харнесса, нативный плагин V2, API библиотеки.

## Что вы получаете

| | Возможность | Что делает |
| --- | --- | --- |
| 🧠 | **Параллельный совет** | Свой `agent` + `model` у каждого эксперта, ограниченная конкурентность, изолированные сессии |
| 🪑 | **Синтез председателем** | Настраиваемый шаблон промпта, лимиты текста по экспертам, учёт usage и стоимости |
| 🆓 | **Bootstrap бесплатных моделей** | `models.dev` + OpenRouter + офлайн-набор, кэш 12 ч, опциональная живая проверка |
| 🩺 | **`doctor` как preflight** | Версия CLI, формат конфига, агенты, модели, форма MCP, подводные камни V1/V2 |
| 🧾 | **Артефакты запусков** | `run.json`, `report.md`, `experts/*.md`; `--replay` и `--diff-runs` |
| 📊 | **Отчёты** | Самодостаточный HTML, markdown для PR в GitHub, SARIF 2.1.0, тикеты Jira/Linear |
| 🔁 | **Watch-режим** | Перезапуск при изменениях файлов с debounce, текущий git diff прикладывается |
| 🪝 | **Git pre-commit hook** | Ревью staged-изменений и блокировка коммита при ошибке |
| 🔌 | **MCP-сервер** | stdio JSON-RPC для Claude Desktop, Codex, Cursor, VS Code, своих агентов |
| 🧩 | **Плагин V2** | Инструмент `consilium.run` прямо в TUI OpenCode V2 |
| 🛡 | **Безопасное ревью** | `--read-only` запрещает запись, shell и MCP-инструменты; `--isolate` даёт каждому агенту свой worktree |
| 🔒 | **Безопасный раннер** | Промпт через stdin (без shell-инъекций и лимита 8 КБ Windows), `--standalone`, повторы, таймауты, лимит стоимости |
| 📦 | **Маленький и строгий** | Ноль runtime-зависимостей, строгий TypeScript, Node >= 18 |

## Знакомьтесь: совет

| Роль | Имя агента | На что смотрит | Типичные вопросы |
| --- | --- | --- | --- |
| 🏛 | `arch` | Архитектура и компромиссы | Что сломается при 10× нагрузке? Какая граница проведена неверно? |
| 🎨 | `ux` | Потоки, эргономика API, состояния ошибок | Что увидит пользователь при сбое? Это очевидно? |
| 📋 | `ba` | Требования и объём | Что вне объёма? Какой крайний случай ни за кем не закреплён? |
| 🛡 | `sec` | Угрозы, authz, злоупотребления | Кто может это вызвать? Что утечёт? Как ограничен rate limit? |
| ⚖️ | `consilium` | Председатель | Сводит ответы, разрешает конфликты, возвращает один план |

Нужно меньше голосов? `-e arch,sec`, `--smart-experts` (эвристический выбор ролей) или пресет.

## Установка

```bash
npm install -g lv24-opencode-consilium

# или запуск без установки
npx -y lv24-opencode-consilium --help

# или тонкий Python-лаунчер из PyPI (Node.js + OpenCode всё равно нужны)
pip install lv24-opencode-consilium
```

`pip` устанавливает консольный скрипт `consilium`, который делегирует npm-пакету через `npx`; npm остаётся канонической дистрибуцией. По-прежнему нужны Node.js >= 18 с npm/npx и OpenCode CLI; для лаунчера — Python 3.9+. Подробности: [`pypi.md`](pypi.md).

**Требования**

| Что нужно | Детали |
| --- | --- |
| Node.js | **>= 18** |
| OpenCode CLI | `npm install -g opencode-ai`, авторизован, **V1 или V2** |
| Опционально | `OPENROUTER_API_KEY` для бесплатных моделей OpenRouter |

### Образ контейнера (GHCR)

Самодостаточный образ (Node.js, OpenCode CLI, `git`) для `linux/amd64` и `linux/arm64`:

```bash
docker pull ghcr.io/levapveeskela/lv24-opencode-consilium:1.11.0   # или :latest
docker run --rm ghcr.io/levapveeskela/lv24-opencode-consilium:latest --version
# consilium v1.11.0
```

Запуск на проекте — смонтируйте доступы и конфиг, каталог проекта оставьте на запись, потому что `--diff`, артефакты и отчёты пишутся в него:

```bash
docker run --rm -it \
  -v "$PWD:/workspace" \
  -v "$HOME/.local/share/opencode:/home/node/.local/share/opencode" \
  -v "$HOME/.config/opencode:/home/node/.config/opencode:ro" \
  -u "$(id -u):$(id -g)" \
  ghcr.io/levapveeskela/lv24-opencode-consilium:latest \
  "Спроектируй rate limiter для публичного API"
```

Точка входа — `consilium`, поэтому работают все флаги (`doctor`, `init --free`, `models`, `mcp`). Для MCP-сервера используйте `--entrypoint consilium-mcp`. Внутри образа `HOME=/home/node`; конфиг монтируется в `/home/node/.config/opencode`, доступы — в `/home/node/.local/share/opencode`. Без смонтированных доступов модели не вызовутся — `consilium doctor` покажет отсутствующий конфиг OpenCode. Флаг `-u "$(id -u):$(id -g)"` сохраняет владельца созданных файлов (Linux/macOS). В Windows уберите `-u`, а в `-v` используйте `%CD%` / `%USERPROFILE%`.

## Быстрый старт

```bash
# 1. Проверить окружение: CLI, конфиг, агенты, модели
consilium doctor

# 2. Подобрать сильнейшие рабочие бесплатные модели и записать конфиг
consilium init --free

# 3. Запустить совет
consilium "Спроектируй rate limiter для публичного API"
```

`init --free`:

1. скачивает `https://models.dev/api.json` и `https://openrouter.ai/api/v1/models`;
2. оставляет только бесплатные (`cost = 0`), активные чат-модели с tool calling и контекстом >= 32K;
3. ранжирует их и проверяет топ-кандидатов крошечным реальным запросом (если не указан `--no-verify`);
4. записывает победителей в `opencode.json` (агенты `arch`, `ux`, `ba`, `sec`, `consilium`) и `consilium.config.json`;
5. никогда не перезаписывает существующие модели агентов без `--force`.

```bash
consilium init --free --dry-run      # только посмотреть, ничего не писать
consilium init --free --native-v2    # нативные V2-агенты (agents + system)
```

## Работает на OpenCode V1 и V2

Поддерживаются обе ветки, формат конфигурации определяется автоматически.

| Что | OpenCode V1 | OpenCode V2 |
| --- | --- | --- |
| Агенты в `opencode.json` | `agent` + `prompt` | `agents` + `system` |
| MCP-серверы | `mcp.<name>` + `enabled` | `mcp.servers.<name>` + `disabled` |
| Команды | `command` + `subtask` | `commands` + `subagent` |
| Модель агента при `run --agent` | применяется из конфига | **игнорируется**, нужен `--model` |

- **Формат V1 — безопасный дефолт**: его читают обе версии, поэтому `init --free` пишет именно его. Конвертировать ничего не нужно.
- **Нативные V2-агенты** (`agents` + `system`) — только с `--native-v2` или если файл уже использует V2-ключи. MCP-сервер ставится отдельно: `consilium mcp --install`.
- **Модели всегда передаются через `--model`**, поэтому V2 не может молча откатиться на корневую модель.
- **Агенты читаются из обеих секций**, включая `.opencode/opencode.json(c)` и родительские каталоги; слияние идёт в том же порядке, что и в OpenCode (`.opencode` приоритетнее).
- `RATE_LIMITED` пережидает короткие лимиты (до 30 с) и быстро падает с задержкой повтора для длинных.
- `doctor` сообщает мажорную версию CLI, формат конфига, дубли `agent`/`agents`, мёртвые в V2 поля (`theme`, `autoupdate`) и плоские MCP-записи.

Регистрация MCP-сервера одной командой (формат выбирается по установленной версии OpenCode):

```bash
consilium mcp --install            # ./opencode.json
consilium mcp --install --global   # ~/.config/opencode/opencode.json
opencode mcp list                  # проверка
```

## Context pack (`--context auto`)

Эксперты обычно видят только задачу и diff. `--context auto` добавляет изменённые файлы, правила проекта (ближайший `AGENTS.md`), связанные тесты и недавние коммиты:

```bash
consilium --context auto --diff "Сделай ревью текущих изменений"
```

Приоритет и бюджет: правила → изменённые файлы → связанные тесты → коммиты; 48k символов всего, 12k на файл, 20 файлов. Бинарные, lock- и сгенерированные файлы пропускаются; каждая секция обёрнута в маркеры `<untrusted-*>`, чтобы текст репозитория не мог выдать себя за инструкции. `--context off` (по умолчанию) сохраняет прежнее поведение.

## Бесплатные модели автоматически

```bash
consilium models                 # топ-20 по рейтингу
consilium models --available     # только провайдеры, которые вам доступны
consilium models --verify        # проверить показанные модели реальным запросом
consilium models --refresh       # игнорировать 12-часовой кэш
consilium models --json          # машинный формат
```

| Источник | Что даёт |
| --- | --- |
| `https://models.dev/api.json` | Полный каталог, цены/лимиты/возможности, связи с платными аналогами |
| `https://openrouter.ai/api/v1/models` | `:free`-варианты, контекст, поддержка `tools`, срок действия |
| Встроенный проверенный набор | Известные рабочие бесплатные модели OpenCode, если каталог их ротировал |

Кэш: `%TEMP%/lv24-opencode-consilium/models-cache.json` (или `CONSILIUM_MODELS_CACHE`), TTL 12 ч.

Провайдер `opencode-go` не исключается целиком: его бесплатные модели (`*-free`, `iceman-contributor-free`, …) участвуют в рейтинге. Платные модели вроде `opencode-go/muse-spark-1.3-contributor` в `--free` не попадают — задайте их вручную в `experts[].model` или `chair.model`.

Текущий рекомендуемый состав (каталог на 2026-11-08):

| Роль | Модель | Почему |
| --- | --- | --- |
| arch | `opencode/flint-40b-free` | coding-агент, structured output, 262k |
| ux | `opencode/inkling-2-small-free` | 1M контекста, мультимодальность, быстрая |
| ba | `opencode/deepseek-v4.1-flash-free` | reasoning + agentic coding, 200k |
| sec | `opencode/iceman-free` | новейшая reasoning-модель, 262k (stealth) |
| chair | `opencode/beam-free` | лучший рейтинг, 1M, structured, coding/agentic |

Бесплатные модели ротируются: `init --free` заново проверяет каталог и реальные ответы. Stealth/alpha-модели (`iceman`, `crouton`) могут исчезнуть — `--refresh` подберёт замену.

Рейтинг (0–1.2) детерминирован: контекстное окно 30%, tool calling 20%, structured output 10%, reasoning 10%, свежесть 10%, лимит вывода 10%, приор семейства 10%, «теневая цена» платного аналога 15% плюс штрафы за alpha/preview/stealth.

Исходы вызовов запоминаются в `.consilium/reliability.json` (успехи, rate limits, таймауты, латентность по каждой модели). `consilium models --reliability` печатает таблицу; рейтинг принимает опциональный бонус за надёжность, когда у модели набралось хотя бы 3 попытки. Файл локальный, его можно безопасно удалить.

## Локальный режим и приватность

Запуск только на локальных провайдерах (Ollama, LM Studio, llama.cpp, vLLM):

```bash
consilium models --local              # только локальные модели в рейтинге
consilium models --probe-local        # запущены ли Ollama / LM Studio?
consilium init --local                # проверить провайдеров и записать localOnly-конфиг
consilium init --local --dry-run      # показать назначение моделей, ничего не записывая
consilium --local-only "Сделай ревью изменений"
```

`init --local` опрашивает Ollama (`/api/tags`) и LM Studio (`/v1/models`) о списках моделей, назначает модели по кругу (round-robin) ролям `arch`, `ux`, `ba`, `sec` и председателю и записывает `consilium.config.json` с `localOnly: true` (существующий файл не перезаписывается без `--force`). Поддерживаются `--dry-run` и `--json`.

`--local-only` — жёсткая гарантия: у каждого эксперта и председателя должна быть явная модель, провайдер которой локальный, иначе запуск отклоняется до старта (выход 2, ошибка MCP-инструмента или ошибка библиотеки). Отсутствующая модель — это ошибка, а не неявный откат в облако. `doctor` добавляет проверку `local-providers`, которая падает, когда `localOnly` включён и ни один локальный провайдер недоступен.

## Использование из любого харнесса (MCP)

```bash
consilium mcp          # stdio-сервер
consilium-mcp          # то же, но напрямую бинарником
```

**Claude Desktop** (`claude_desktop_config.json`):

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

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "lv24-opencode-consilium", "mcp"]
```

Подойдёт любой MCP-клиент с stdio JSON-RPC 2.0. Логи идут в **stderr**; в stdout только протокол.

| Инструмент | Аргументы | Результат |
| --- | --- | --- |
| `consilium_run` | `task` (обязателен), `experts`, `chair`, `timeout_ms`, `deadline_ms`, `local_only`, `read_only`, `isolate`, `rounds`, `format`, `preset`, `output_file`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`, `findings` | Синтез от председателя + мнения экспертов + JSON-метаданные (время, usage, стоимость, модели, находки, safety, дедлайн, дебаты) |
| `consilium_list_agents` | — | Настроенные эксперты, модели, председатель, пресеты, путь конфига |
| `consilium_free_models` | `limit`, `available_only`, `refresh`, `local_only`, `probe_local` | Таблица рейтинга бесплатных моделей + проверка локальных провайдеров |
| `consilium_doctor` | — | Диагностика окружения и конфига |
| `consilium_init_free` | `apply`, `force`, `confirm`, `verify` | План (по умолчанию) или запись `opencode.json` + `consilium.config.json` |
| `consilium_list_runs` | `limit` (1–100, по умолчанию 10) | Сохранённые запуски от новых к старым: id, время, задача, успех, число находок |
| `consilium_get_run` | `run` (id или `latest`, по умолчанию `latest`) | Полный `run.json` как JSON |
| `consilium_sarif` | `run` (id или `latest`), опционально `output_file` | SARIF 2.1.0 JSON или атомарный файл внутри workspace |
| `consilium_diff_runs` | `left`, `right` (id или `latest`) | Markdown-сравнение двух сохранённых запусков |

`consilium_init_free` по умолчанию работает как dry-run — передайте `"apply": true`, чтобы записать файлы; `force: true` дополнительно требует `"confirm": true` и создаёт `.bak`-копии. `consilium_run` показывает прогресс в реальном времени, если клиент прислал `progressToken`, а его ответ содержит `cost`, сводку консенсуса и строку `**Artifacts:**`, когда артефакты включены. Четыре инструмента артефактов только читают, никогда не вызывают модель и ограничены `.consilium/runs` и workspace.

## Для ИИ-агентов

Если вы агент, вот стабильные контракты. Предпочитайте их разбору человеческого текста.

```json
{
  "package": "lv24-opencode-consilium",
  "version": "1.11.0",
  "bins": ["consilium", "consilium-mcp", "lv24-opencode-consilium"],
  "mcp": { "command": "npx", "args": ["-y", "lv24-opencode-consilium", "mcp"] },
  "json_mode": "consilium -f json \"<task>\"",
  "findings": "consilium --findings -f json \"<task>\" -> metadata.findings",
  "safety": { "read_only": "--read-only", "isolate": "--isolate", "metadata": "metadata.safety" },
  "report_formats": ["html", "pr", "markdown", "sarif", "jira", "linear"],
  "artifact_tools": ["consilium_list_runs", "consilium_get_run", "consilium_sarif", "consilium_diff_runs"],
  "models_json": "consilium models --json",
  "config_files": ["consilium.config.json", "consilium.json", ".consiliumrc", ".consiliumrc.json"],
  "config_schema": "schema/config.schema.json",
  "exit_codes": { "0": "success", "1": "run failed", "2": "usage error", "3": "провал policy gate" },
  "docs_index": "llms.txt"
}
```

Правила, которые важны при управлении из агента:

1. **stdout — для данных, stderr — для прогресса.** `-f json` печатает один JSON-документ в stdout; логи и прогресс остаются в stderr.
2. **Не парсите человеческий текст.** Используйте `-f json` (результат + `metadata`), `consilium models --json` или MCP-инструменты.
3. **Ошибки типизированы.** `errorCode` — одно из `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `EMPTY_RESPONSE`, `AGENT_NOT_FOUND`, `COST_LIMIT`, `TIMEOUT`, …; коды выхода — `0/1/2/3` (`3` = policy gate).
4. **Состояние — это файлы, а не демон.** Артефакты лежат в `.consilium/runs/<id>/` (`run.json`, `report.md`, `experts/<agent>.md`); `--replay <id>` восстанавливает запуск.
5. **Никаких интерактивных запросов.** Каждая команда неинтерактивна; `autoApprove` (флаг OpenCode `--auto`) выключен по умолчанию и включается осознанно в доверенном конфиге.
6. **Сначала дешёвое.** `consilium doctor` → `consilium models --json` → `consilium -f json "..."`; добавьте `--max-cost` для жёсткого бюджета.

Готовый промпт для агента:

```text
Запусти консилиум на эту задачу с жёстким лимитом стоимости:
  npx -y lv24-opencode-consilium --max-cost 0.50 -f json "<task>"
Читай stdout как JSON. Если errorCode = COST_LIMIT, покажи частичные мнения
экспертов и metadata.cost; не повторяй запуск. Если RATE_LIMITED, прочитай
metadata.retryAfterMs перед повтором. Для воспроизведения запуска используй --replay <id>.
```

Полный машинный индекс: [`llms.txt`](../llms.txt). Глубокие внутренности (сессии, API плагина): [`session-and-plugin.md`](session-and-plugin.md).

## Справочник CLI

```text
consilium [options] <task>
consilium <task> -                  # задача из stdin
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
consilium sarif [--run <id|latest>] [--output <file>]
```

**Ядро**

| Флаг | Значение |
| --- | --- |
| `-c, --config <file>` | Файл конфигурации (иначе автоопределение) |
| `-e, --experts a,b` | Подмножество экспертов |
| `--chair <agent>` | Имя агента-председателя |
| `--preset <name>` | `fast`, `deep`, `security`, `review`, `free` или свой пресет из конфига |
| `--deadline <ms>` | Бюджет времени фазы экспертов; отставшие отменяются, председатель синтезирует частичные результаты (максимум 24 ч) |
| `--rounds <1\|2>` | `2` добавляет раунд анонимизированного peer-review; применяется к run/watch/eval и удваивает вызовы моделей (по умолчанию 1) |
| `--compare-rounds` | `eval`: прогнать каждую фикстуру с одним и двумя раундами и напечатать таблицу дельт |
| `--local-only` | Требовать явную локальную модель для каждого агента; отклонять нелокальных провайдеров до запуска |
| `--read-only` | Эксперты и председатель могут только read/glob/grep; write/edit/patch/shell/webfetch/subagent/question/MCP-инструменты запрещены |
| `--allow-write` | Отказ от read-only (взаимоисключающе с `--read-only`); `audit` по умолчанию работает в read-only |
| `--isolate` | Запускать каждого агента в отдельном git worktree под управлением OpenCode (`--worktree`) |
| `--expert-timeout`, `--chair-timeout` | Таймауты в мс (на попытку) |
| `-r, --retries <n>` | Число повторов (0 = одна попытка) |
| `-o, --output <file>` | Сохранить результат (text/markdown/json по `-f`) |
| `--no-save` | Никогда не писать файл |
| `-f, --format <fmt>` | `text`, `markdown`, `json` (чистый JSON в stdout) |
| `--task-file <file>` | Задача из файла (`-` = stdin) |
| `-s, --silent` | Только итоговый результат |
| `-V, --verbose` | Сырые события прогресса |
| `-v, --version`, `-h, --help` | Версия / справка |

**Анализ и бюджет**

| Флаг | Значение |
| --- | --- |
| `--consensus` / `--no-consensus` | Лексический анализ согласия экспертов (пересечение терминов, Jaccard); сводка идёт в промпт председателя, полный отчёт — в результат |
| `--smart-experts` | Эвристический выбор 2–3 релевантных ролей по задаче/диффу (лексиконы `arch`/`ux`/`ba`/`sec`, RU+EN; отброшенные роли логируются) |
| `--max-cost <usd>` | Лимит стоимости; при превышении до председателя он пропускается (`COST_LIMIT`, частичный результат с консенсусом) |
| `--fallback-models a,b` | При `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` тот же эксперт повторяется на следующей модели (цепочка не длиннее 2) |
| `--session <id>` | Базовый id сессии OpenCode; каждый агент получает `ses_<base>-<agent>` (параллельные агенты никогда не делят сессию) |
| `--variant <name>` | Вариант модели для всех агентов (`provider/model` → `provider/model#variant`); некорректный вариант — выход 2 |
| `--verify` / `--no-verify` | Проверять модели перед выбором (`models` / `init --free`) |

**Артефакты, отчёты, автоматизация**

| Флаг | Значение |
| --- | --- |
| `--artifacts` / `--no-artifacts` | Сохранять / не сохранять артефакты запуска (по умолчанию выключено) |
| `--artifacts-dir <path>` | Свой каталог артефактов (вместо `.consilium/runs/<id>/`) |
| `--replay <id>` | Повторить сохранённый запуск (восстанавливает модели председателя/экспертов и флаги consensus/smartExperts/fallbackModels/session) |
| `--diff-runs <a> <b>` | Напечатать markdown-сравнение двух сохранённых запусков |
| `--report <format>` | Отчёт после запуска: `html`, `pr`, `markdown`, `sarif`, `jira`, `linear` (`markdown` — тот же PR-вариант) |
| `--report-file <file>` | Записать отчёт в файл (`.html` → html, `.md` → pr, `.sarif` → sarif, `.jira` → jira, `.linear` → linear; без файла отчёт идёт в stdout, кроме `-f json`) |
| `--diff [--staged] [--base <ref>]` | Приложить текущий git diff к задаче |
| `--debounce <ms>` | Задержка watch-режима (по умолчанию 400) |
| `watch [--debounce <ms>] [task]` | Следить за проектом и перезапускать при изменениях (до Ctrl+C) |
| `hooks install\|uninstall` | Установить/удалить git pre-commit hook (ревью staged перед коммитом) |
| `--native-v2` | Писать нативный V2-конфиг (`agents`/`system`) |
| `--install`, `--global` | Зарегистрировать MCP-сервер в проектном или глобальном конфиге |
| `--findings` / `--no-findings` | Структурированный блок находок в ответах экспертов и председателя (по умолчанию выключено) |
| `--fail-on <severity>` | Выход `3`, когда новые находки достигают порога: `critical`, `high`, `medium`, `low`, `info`, `none` |
| `baseline accept\|prune` | Управление `.consilium/baseline.json` (принятые отпечатки находок) |
| `--context <off\|auto>` | Добавлять в задачу изменённые файлы, правила, связанные тесты и коммиты (`auto`; по умолчанию выключено) |
| `eval [--fixtures <dir>]` | Запустить набор оценочных фикстур с посаженными багами (по умолчанию `eval/fixtures`) |
| `--fail-under <pct>` | Гейт `eval`: выход `3` ниже процента catch rate |
| `--reliability` | `models`: печатать успешность и латентность по моделям из `.consilium/reliability.json` |
| `history [--limit N]` | Последние запуски из `.consilium/runs` |
| `stats [--html <file>]` | Агрегированные успешность, задержка, стоимость, находки и ошибки по моделям |
| `presets [--json]` | Список встроенных и своих пресетов |
| `models --local` / `--probe-local` | Рейтинг только локальных моделей и проверка Ollama/LM Studio |
| `init --local` | Опрос Ollama/LM Studio, модели по кругу всем ролям и председателю, `consilium.config.json` с `localOnly: true`; `--dry-run` без записи, `--json` для машин |
| `audit --since <ref>` | Ревью `<ref>...HEAD` целиком; `--dry-run` строит diff без вызова моделей |

Коды выхода: `0` успех, `1` запуск неуспешен, `2` ошибка использования, `3` провал policy gate.

```bash
consilium -e arch,sec "Смоделируй угрозы для эндпоинта загрузки файлов"
consilium --preset deep "Спроектируй план миграции"
git diff --staged | consilium - --diff "Сделай ревью этих изменений"
consilium -f json "..." > council.json
consilium --smart-experts --consensus "Спроектируй схему БД для подписок"
consilium --artifacts --max-cost 0.5 "Спроектируй план миграции"
consilium --replay 2026-11-08-abc123
consilium --diff-runs 2026-11-08-abc123 2026-11-08-def456
consilium --report pr --report-file review.md "Сделай ревью текущих изменений"
consilium --variant high "Спроектируй схему БД для подписок"
consilium watch --debounce 500 "Сделай ревью текущих изменений"
consilium hooks install
```

## Артефакты, отчёты, watch и git-хуки

```bash
# HTML-отчёт в файл / PR-markdown в stdout
consilium --report html --report-file report.html "Сделай ревью текущих изменений"
consilium --report pr "Сделай ревью текущих изменений"

# --report-file сам определяет формат: .html → html, .md → pr, .sarif → sarif,
# .jira → jira, .linear → linear
consilium --report-file notes.md "Спроектируй схему БД для подписок"

# Перезапуск при изменениях файлов (игнорирует .git/node_modules/dist/.consilium/coverage/*.tmp/*.log,
# пауза 400 мс, текущий git diff прикладывается к задаче)
consilium watch "Сделай ревью текущих изменений"
consilium watch --debounce 800

# Pre-commit hook: ревью staged-изменений и блокировка коммита при ошибке
consilium hooks install
consilium hooks uninstall   # убирает только управляемый блок
```

- **Артефакты** — обычные файлы, без базы данных: `run.json` (задача, ответы экспертов, модели, usage, консенсус), `report.md`, `experts/<agent>.md` в `.consilium/runs/<id>/`; id и каталог видны в `metadata.artifacts: { id, dir }`.
- **PR-отчёт** — markdown для комментария GitHub с маркером `<!-- consilium:report -->` и сворачиваемыми блоками `<details>`; HTML-отчёт самодостаточен, текст экранирован.
- **Хук** пишет только свой блок (`# >>> consilium >>>` … `# <<< consilium <<<`) в каталог git-хуков (`.git/hooks`, `core.hooksPath`, worktrees) и сохраняет остальное; при ненулевом коде выхода коммит блокируется.

Как ведут себя флаги анализа:

- `--consensus` считает лексическое согласие (Jaccard по значимым терминам, стоп-слова RU+EN): оценки по парам, среднее и уровень `agreement` (`high`/`medium`/`low`). Это детерминированный подсчёт, а не оценка LLM. Сводка → в промпт председателя; полный отчёт → в результат и `metadata.consensus` (`agreement`, `averageSimilarity`, `pairs`, `sharedTerms`, `uniqueTerms`).
- `--smart-experts` выбирает 2–3 роли эвристикой (лексиконы ролей по задаче и диффу); выбор попадает в `metadata.smartExperts`, отброшенные роли логируются.
- `--max-cost` считает расходы экспертов и председателя. Превышение до председателя → председатель пропущен, частичный результат с `errorCode: COST_LIMIT` и `metadata.cost` (`limit`/`spent`/`exceeded`/`byAgent`); при превышении добавляется `metadata.costExceeded`.
- `--fallback-models` повторяет того же эксперта на следующей модели (максимум 2 подмены), суммируя usage в `metadata.fallbackModels`.
- `--session` даёт председателю базовую сессию, а каждому эксперту `ses_<base>-<agent>` (префикс `ses_` требует OpenCode); неизвестные агенты идут на default-агенте с `ses_<base>-default-<agent>`, поэтому чужая сессия не засоряется. Сессии намеренно не скрываются из `opencode session list`.

## Находки и policy gate

Ревью-запуски могут возвращать структурированные находки, а не только текст — включите `--findings`:

```bash
consilium --findings --artifacts -f json "Сделай ревью текущих изменений" > run.json
consilium --findings --fail-on high --diff "Сделай ревью текущих изменений"
```

Каждый эксперт (и председатель) завершает ответ одним fenced-блоком `json`:

````markdown
```json
{
  "findings": [
    {
      "severity": "high",
      "category": "security",
      "file": "src/auth.ts",
      "line": 42,
      "claim": "Удаление проекта не проверяет владельца",
      "evidence": "обработчик вызывает remove() без authorize()",
      "confidence": 0.9
    }
  ],
  "rejected": [
    { "claim": "Владение проверяется в middleware", "reason": "middleware не подключён к этому маршруту" }
  ]
}
```
````

- `severity`: `critical` | `high` | `medium` | `low` | `info`; `claim` обязателен, остальное опционально.
- Эксперты сообщают находки; председатель объединяет их и перечисляет отклонённые позиции в `rejected`.
- Находки дедуплицируются по стабильному отпечатку (категория + файл + нормализованный `claim`, строка исключена), поэтому одна проблема сопоставляется с одной записью между запусками; берётся максимальная серьёзность, а отклонённые председателем находки помечаются `contested`.
- `metadata.findings` = `{ items, counts, rejected, parseErrors }`; HTML- и PR-отчёты рисуют таблицу и сворачиваемый реестр разногласий (dissent ledger).
- Отсутствующий или битый JSON никогда не валит запуск: текст сохраняется, а проблема попадает в `parseErrors`.

Baseline и гейт:

```bash
consilium baseline accept latest           # принять находки последнего запуска
consilium baseline accept <runId> --dry-run
consilium baseline prune --older-than 90    # или --all --yes
consilium --findings --fail-on high --diff "Сделай ревью текущих изменений"
```

`--fail-on` гейтит по **новым** находкам: отпечатки из `.consilium/baseline.json` игнорируются. Код выхода `3` означает, что гейт не пройден. `--fail-on` без `--findings` — ошибка использования. Baseline-файл проектный, и его можно коммитить, чтобы делить принятые находки с командой.

## SARIF и code scanning

```bash
consilium --findings --report sarif --report-file consilium.sarif "Сделай ревью текущих изменений"
```

`--report sarif` пишет SARIF 2.1.0 для GitHub code scanning и других SARIF-просмотрщиков: один результат на находку, `critical`/`high` → `error`, `medium` → `warning`, `low`/`info` → `note`, локации файл/строка, стабильные отпечатки и одно правило на категорию. `--report-file` определяет формат по `.sarif`/`.sarif.json`. Загружайте файл через `github/codeql-action/upload-sarif` в CI; находки, уже принятые в baseline, всё равно попадают в файл, если их не отфильтровать.

Уже есть артефакты? Экспортируйте последний или указанный сохранённый запуск без повторного запуска совета:

```bash
consilium sarif --run latest --output consilium.sarif
consilium sarif --run 2026-01-15T10-00-00-000Z   # JSON на stdout
```

Несуществующий запуск — ошибка использования (выход 2); запуск без находок даёт валидный пустой SARIF.

## Read-only и изоляция

Ревью-задачи не должны иметь возможности менять репозиторий. `--read-only` ограничивает каждого эксперта и председателя инструментами `read`, `glob` и `grep`; `write`, `edit`, `patch`, `shell`, `webfetch`, `websearch`, `subagent`, `question`, MCP-инструменты и доступ к внешним каталогам запрещены. Файлы `.env` остаются нечитаемыми (`.env.example` разрешён). `--allow-write` явно отменяет read-only; флаги взаимоисключающие. `audit` по умолчанию работает в read-only.

```bash
consilium --read-only "Review the authentication design"
consilium audit --since origin/main --fail-on high   # audit по умолчанию read-only
consilium audit --since origin/main --allow-write   # явный отказ от read-only
consilium --isolate --read-only "Review the migration"
```

Ограничение применяется через временный слой `.opencode/opencode.json`, который OpenCode загружает после прямого проектного конфига. Consilium берёт блокировку, делает резервную копию существующего слоя, сливает V2 `agents.<name>.permissions` и V1 `agent.<name>.tools` и восстанавливает исходные байты в `finally` (включая отмену). Устаревшая блокировка восстанавливается при следующем запуске; нечитаемый слой или существующий `.opencode/opencode.jsonc` приводят к fail-closed, а не к тихому запуску без ограничений. Пока read-only-запуск активен, другие интерактивные сессии OpenCode в этом же проекте видят временные ограничения.

`--isolate` добавляет `--worktree` в каждый `opencode run`, поэтому каждый агент получает свой git worktree. Жизненным циклом worktree управляет OpenCode: read-only действует на основной проект, а запись внутри одноразового worktree не может затронуть основное дерево.

Оба флага записываются в `metadata.safety` (`readOnly`, `isolate`) и в артефакты запуска. GitHub Action включает `read-only` по умолчанию и позволяет отключить его через `read-only: false`.

## Отчёты для Jira и Linear

```bash
consilium --report jira --report-file ticket.jira "Review the current changes"
consilium --report linear --report-file ticket.md "Review the current changes"
```

`jira` выдаёт разметку Jira wiki (`h2.`, таблицы `||...||`, блоки `{code}`), а `linear` — чистый Markdown. Оба содержат вердикт, модели, стоимость, длительность, таблицу находок (серьёзность, категория, файл:строка, `claim`, доказательство, спорность), отклонённые позиции и ошибки разбора; запуск без находок даёт валидный отчёт «находок нет». `--report-file` определяет `.jira` и `.linear` автоматически; явный `--report` работает с любым именем файла.

## Дедлайны и частичный синтез

Долгие запуски на бесплатных моделях не должны подвешивать CI или pre-commit hook:

```bash
consilium --deadline 180000 --diff "Сделай ревью текущих изменений"
```

`--deadline <ms>` ограничивает фазу экспертов (максимум 24 ч; `deadlineMs` в конфиге). Когда он срабатывает, работающие эксперты отменяются, завершённые ответы сохраняются, а председатель синтезирует их с явной пометкой: сколько экспертов успело и каких ролей не хватает. `metadata.deadline` = `{ limitMs, hit, completed, missing }`. Если не завершился ни один эксперт, председатель пропускается, а запуск падает с `errorCode: DEADLINE` (выход 1); частичный запуск хотя бы с одним экспертом считается успешным.

## Раунды дебатов

`--rounds 2` добавляет второй раунд экспертов: каждый эксперт видит анонимизированные ответы коллег (A/B/C), критикует ошибки и пропуски и формулирует итоговую позицию. Председатель получает итоговые позиции и пометку о том, какие эксперты изменили позицию; `metadata.debate = { rounds, participants, changed }`.

```bash
consilium --rounds 2 --preset deep "Спроектируй план миграции"
```

Второй раунд удваивает число вызовов моделей, поэтому он опционален и пропускается, если успешно ответили меньше двух экспертов, если сработал дедлайн или если `--max-cost` уже превышен. Второй раунд продолжает сессию каждого эксперта, а находки собираются из итоговых ответов. Ответ первого раунда включается в промпт второго раунда для самого эксперта; ответы коллег анонимизированы и помечены как данные.

## Eval-харнесс (`consilium eval`)

Докажите, что совет ловит больше, чем одна модель, — детерминированно:

```bash
consilium eval --fixtures eval/fixtures --json
consilium eval --fail-under 70        # выход 3 ниже 70% catch rate
consilium eval --max-cost 0.50        # остановиться при исчерпании бюджета
```

Каждая фикстура — это задача, небольшой diff с посаженным багом и `expected.json` (`mustFind` / `mustNotFind` — подстроки `claim`, опционально `file`, `category`, `minSeverity`). Сопоставление — нормализованная проверка подстроки `claim`, без LLM-судьи, поэтому результаты воспроизводимы. Отчёт показывает по каждой фикстуре caught/missed/false positives, агрегированные catch и FP rates, p50-латентность и стоимость. **Двадцать две (22) стартовых фикстуры** лежат в [`eval/fixtures`](../eval/fixtures) и покрывают инъекции, авторизацию, конкурентность, надёжность, SSRF/path traversal, целостность данных, пагинацию/кэширование и prompt injection; свои можно добавлять рядом.

Корпус — production; числа бенчмарка должны приходить из реального запуска модели (в CI нет доступов к моделям). В [`eval/README.md`](../eval/README.md#results) описаны точные команды и намеренно нет выдуманной таблицы; [`eval-results.md`](eval-results.md) — шаблон отчёта для измеренного запуска.

Сравните одиночный проход с раундами дебатов на тех же фикстурах:

```bash
consilium eval --compare-rounds
consilium eval --rounds 2 --json
```

`--compare-rounds` прогоняет каждую фикстуру дважды (один и два раунда) и печатает таблицу дельт по catch rate, FP rate, p50-латентности и суммарной стоимости с вердиктом. `--fail-under` гейтит catch rate дебатов; `--max-cost` покрывает оба прогона.

## История и статистика

```bash
consilium history --limit 10       # последние запуски: успех, стоимость, находки, согласие
consilium stats                    # успешность, p50/p95, стоимость, ошибки по моделям
consilium stats --html stats.html  # самодостаточный статический отчёт
```

- `consilium history [--limit N] [--json]` — последние запуски из `.consilium/runs/<id>/run.json`: успех, стоимость, находки и согласие; битые запуски пропускаются с предупреждением.
- `consilium stats [--json] [--html <file>]` — успешность, задержка p50/p95, суммарная стоимость, находки по серьёзности и `contested`, попытки/ошибки по моделям и топ-коды ошибок.
- `stats --html` пишет экранированную статическую страницу без скриптов.
- Обе команды только читают данные из `.consilium/` и не требуют демона.

## Аудит диапазона коммитов

```bash
consilium audit --since v1.7.0 --fail-on high
consilium audit --since HEAD~5 --dry-run
```

`audit` строит недоверенный diff для `<ref>...HEAD`, запускает на нём совет и переиспользует отчёты, артефакты и policy gate. `--dry-run` печатает ref, число файлов и флаг усечения, не вызывая модели; `--since` обязателен и валидируется (без shell-метасимволов). Запускайте по расписанию из cron, Task Scheduler или CI — встроенного демона нет.

## Запуск по расписанию

В [`scheduling.md`](scheduling.md) есть готовые рецепты для cron, Windows Task Scheduler, launchd и GitHub Actions — с `consilium audit --since <ref>`, `--deadline` и `--max-cost`. Запускаемые обёртки лежат в [`examples/consilium-audit.sh`](../examples/consilium-audit.sh), [`examples/consilium-audit.ps1`](../examples/consilium-audit.ps1) и [`examples/consilium-audit-nightly.yml`](../examples/consilium-audit-nightly.yml). Пример workflow намеренно находится вне `.github/workflows/`, поэтому в этом репозитории ничего не запускается автоматически.

## Плагин OpenCode V2

Нативный плагин запускает совет **внутри TUI OpenCode V2**, без MCP и внешнего CLI — через инструмент `consilium.run`. В V1 он не работает (API плагинов V1 несовместим).

```json
{
  "plugins": [{ "package": "lv24-opencode-consilium" }]
}
```

Серверная часть публикуется как `./server` (`dist/plugin.js`); runtime-зависимостей нет (`@opencode/plugin` нужен только для типов). Инструмент принимает `task`, `experts`, `chair`, `timeout_ms`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`, `preset`.

| Способ | Когда |
| --- | --- |
| Плагин (`consilium.run`) | Внутри TUI OpenCode V2, совет нужен прямо в диалоге |
| MCP-сервер | Внешние харнессы (Claude Desktop, Codex, Cursor, VS Code, свои агенты) |
| CLI | Терминал, скрипты, CI, хуки, watch |

### Слэш-команда (OpenCode V2)

В репозитории есть `.opencode/commands/council.md`: команда `/council <задача>` просит текущего агента запустить консилиум. Она вызывает инструмент плагина `consilium.run`, а если плагин не загружен — MCP-инструмент `consilium_run`.

- **Проект:** `.opencode/commands/council.md` (уже в репозитории).
- **Глобально:** скопируйте файл в `~/.config/opencode/commands/council.md`.
- **Использование:** `/council Оцени дизайн аутентификации`.
- **Требуется:** зарегистрированный [плагин V2](#плагин-opencode-v2) **или** [MCP-сервер](#использование-из-любого-харнесса-mcp). Без них агент сообщит, чего не хватает, и не будет запускать консилиум.

Для V1: каталог команд — сингулярный `command/` (`.opencode/command/`, `~/.config/opencode/command/`), а API плагинов V2 недоступен. Скопируйте файл туда и используйте MCP-сервер или CLI.

## GitHub Action

Композитный action ревьюит diff пул-реквеста, публикует или обновляет ровно один комментарий с маркером `<!-- consilium:report -->` и по умолчанию загружает находки в GitHub code scanning как SARIF:

```yaml
permissions:
  contents: read
  pull-requests: write
  security-events: write   # нужно для загрузки SARIF

- uses: LevapVeeskela/lv24-opencode-consilium/.github/actions/consilium@v1.11.0
  with:
    fail-on: high
    github-token: ${{ github.token }}
    read-only: true          # по умолчанию; false передаёт --allow-write
    sarif: true             # по умолчанию; false отключает SARIF
```

Он запускает `consilium --diff --base origin/<base> --artifacts --read-only --report pr --report-file consilium-review.md --fail-on <level>`, комментирует один раз, экспортирует находки через `consilium sarif --run latest` и загружает их с помощью `github/codeql-action/upload-sarif`, а затем передаёт код выхода гейта (`3`). Сбои SARIF и загрузки никогда не маскируют гейт (эти шаги помечены `continue-on-error`). Для загрузки должны быть включены code scanning и разрешение `security-events: write`; путь к файлу задаёт `sarif-file`, а `category` отличает отчёт от других SARIF-загрузок репозитория. `sarif: false` пропускает оба шага. PR из форков по умолчанию пропускаются, потому что секреты недоступны; версию npm можно закрепить входом `version`. Action выполняется на вашем runner — без хостингового приложения и платного сервиса. Полное руководство: [`github-action.md`](github-action.md).

## Пресеты

| Пресет | Эксперты | Поведение |
| --- | --- | --- |
| `fast` | arch, sec | таймаут эксперта 3 мин, без повторов |
| `deep` | все четыре | удвоенные таймауты, повторы включены |
| `security` | sec, arch, ba | ревью с фокусом на безопасность |
| `review` | arch, sec, ux | ревью кода |
| `free` | все четыре | под bootstrap бесплатных моделей |

Свои пресеты задаются в `consilium.config.json` и сливаются поверх встроенных:

```json
{
  "presets": {
    "docs": { "description": "Ревью документации", "experts": ["arch", "ba"] }
  }
}
```

`consilium presets` перечисляет объединённый набор (`--json` для скриптов); `--preset docs` работает в CLI, MCP `consilium_run` и плагине V2. Свой пресет может переопределить встроенное имя — его поля заменяют встроенные.

## Конфигурация

Поиск конфигурации в текущем каталоге: `consilium.config.json`, `consilium.json`, `.consiliumrc`, `.consiliumrc.json`. Явный путь — `-c`. Конфигурация OpenCode ищется в `opencode.json`/`opencode.jsonc`, `.opencode/opencode.json(c)`, родительских каталогах и `~/.config/opencode`; комментарии JSONC допустимы в `opencode.json`/`opencode.jsonc`.

```json
{
  "experts": [
    { "name": "arch", "model": "opencode/flint-40b-free" },
    { "name": "sec",  "model": "opencode/iceman-free" }
  ],
  "chair": {
    "agent": "consilium",
    "model": "opencode/beam-free"
  },
  "retry": { "maxConcurrency": 3 }
}
```

| Ключ | По умолчанию | Примечание |
| --- | --- | --- |
| `experts[].model` | — | `provider/model`; передаётся как `--model`, переопределяет модель агента |
| `chair.model` | — | Переопределение модели председателя |
| `timeouts.expert` / `.chair` | 300000 / 600000 | На попытку, мс |
| `retry.expertRetries` / `.chairRetries` | 1 | `0` = одна попытка |
| `retry.jitter` | `false` | Случайный разброс задержки повтора (50–100%), чтобы эксперты не упирались в лимит одновременно |
| `retry.maxConcurrency` | 3 | 1–8 параллельных агентов |
| `output.file` | `false` | `false` отключает сохранение; строка включает |
| `standalone` | `true` | Приватный сервер; не конфликтует с уже запущенным OpenCode |
| `autoApprove` | `false` | Только через конфиг; авто-подтверждает разрешения. Игнорируется из проектного конфига без `-c` |
| `autoDiscoverAgents` | `true` | Переиспользовать агентов из `opencode.json` |
| `artifacts` | `false` | `true` → `.consilium/runs/<id>/`; строка задаёт свой каталог |
| `consensus` | `false` | Лексический анализ согласия экспертов |
| `smartExperts` | `false` | Эвристический выбор 2–3 ролей |
| `maxCost` | — | Лимит стоимости в USD (число >= 0); без значения — без лимита |
| `fallbackModels` | — | Массив строк `provider/model` для повторов при ошибках модели |
| `session` | — | Базовый id сессии OpenCode |
| `report` | — | Формат отчёта: `html`, `pr`, `markdown`, `sarif`, `jira`, `linear` |
| `reportFile` | — | Путь к файлу отчёта (`.html`/`.md`/`.sarif`/`.jira`/`.linear` выбирает формат) |
| `variant` | — | Вариант модели для моделей без `#variant` (явный вариант приоритетнее) |
| `debounceMs` | 400 | Задержка watch-режима, мс |
| `findings` | `false` | Структурированный блок находок в ответах экспертов и председателя |
| `context` | `off` | `auto` добавляет изменённые файлы, правила проекта, связанные тесты и коммиты в задачу |
| `deadlineMs` | — | Бюджет фазы экспертов в мс (максимум 24 ч); частичный синтез по таймауту |
| `rounds` | `1` | `2` = раунд анонимизированного peer-review; удваивает вызовы моделей |
| `localOnly` | `false` | Требовать явную локальную модель для каждого агента |
| `readOnly` | `false` | Только read/glob/grep для экспертов и председателя; `audit` включает принудительно без `--allow-write` |
| `isolate` | `false` | Каждый агент в отдельном worktree OpenCode (`--worktree`) |
| `presets` | — | Свои пресеты, сливаются поверх встроенных |
| `opencodePath` | `opencode` | Свой путь к CLI (игнорируется из проектного конфига без `-c`) |
| `cwd` | текущая | Рабочая директория для OpenCode (игнорируется из проектного конфига без `-c`) |

Полная схема: [`schema/config.schema.json`](../schema/config.schema.json) · пример: [`consilium.config.example.json`](../consilium.config.example.json).

## Библиотечный API

```ts
import { Consilium, runConsilium, fetchFreeModels, selectCouncilModels } from 'lv24-opencode-consilium';

const council = new Consilium();
council.onProgress(event => console.error(event.type, event.agent ?? ''));

const result = await council.run('Спроектируй стратегию инвалидации кэша');
console.log(result.text);           // синтез председателя
console.log(result.usage?.cost);    // суммарная стоимость (0 для бесплатных моделей)

// one-shot
const oneShot = await runConsilium('...'); // возвращает ConsiliumResult
console.log(oneShot.text);

// найти и выбрать модели
const { models } = await fetchFreeModels({ includeUnavailable: true });
const top = selectCouncilModels(models, 5);
```

Экземпляры `Consilium` переиспользуемы: `run()` можно вызывать снова после завершённого, упавшего или отменённого запуска. `cancel()` останавливает все дочерние процессы текущего запуска.

## Как это работает

Для каждого эксперта и председателя Consilium запускает:

```text
opencode run --standalone --format json [--auto] [--agent=NAME] [--model=provider/model]
```

Промпт уходит в **stdin** дочернего процесса (UTF-8), поэтому произвольный текст задачи безопасен и не упирается в лимиты shell или командной строки. NDJSON-события декодируются потоково (`text`, `step_finish` с usage/cost, `error` с `type`/`status`/`retryAfterMs`). Модель всегда передаётся как `--model`, поэтому поведение одинаково в V1 и V2, где `--agent` не применяет модель из конфигурации. Коды выхода, хвосты stderr и структурированные ошибки превращаются в типизированные `errorCode` (`RATE_LIMITED`, `MODEL_UNAVAILABLE`, `AGENT_NOT_FOUND`, …). Если имя агента отсутствует, вызов повторяется один раз с той же моделью на default-агенте — запуск продолжает работать без persona-агентов.

## Безопасность

- Текст задачи никогда не подставляется в shell-команду — он передаётся через stdin.
- Имена агентов и id моделей валидируются перед использованием.
- **Конфиг проекта недоверенный по умолчанию.** `consilium.config.json` в репозитории может задавать модели, экспертов, промпты и пресеты, но process/path-ключи — `opencodePath`, `opencodeArgs`, `autoApprove`, `cwd`, `opencodeConfigPath`, строковый `output.file`, `reportFile`, строковый `artifacts` — игнорируются с предупреждением. Чтобы доверять им, передайте файл явно через `-c`.
- **Read-only-запуски** пишут временный слой `.opencode/opencode.json` с deny-разрешениями, держат `.consilium/read-only.lock` и восстанавливают исходные байты при успехе, ошибке, отмене и `process.exit`. Битый JSON, существующий `.opencode/opencode.jsonc` или слой-симлинк приводят к fail-closed. Другие интерактивные сессии в этом же проекте видят временные ограничения, пока запуск активен.
- **`--isolate`** использует worktree под управлением OpenCode; основной проект остаётся нетронутым, но worktree могут сохраняться по жизненному циклу самого OpenCode.
- **Windows:** `.cmd`/`.bat`-шимы запускаются через `cmd.exe` только после строгой проверки каждого аргумента (без кавычек, `%`, `!`, `^`, `&`, `|`, `<`, `>`, пробелов); `.exe` и POSIX-бинарники запускаются напрямую.
- **MCP:** `tools/call` требует `id`, очередь ограничена 16, `output_file` и пути артефактов удерживаются внутри workspace, а `consilium_init_free` делает `.bak` и требует `confirm: true` вместе с `force`.
- `autoApprove` (авто-подтверждение разрешений) **выключен** по умолчанию; не включайте его для недоверенных промптов и инструментов.
- `--standalone` изолирует дочерний сервер; порт не захватывается.
- Артефакты редактируют частые паттерны токенов, а `.consilium/.gitignore` создаётся автоматически, чтобы запуски не коммитились случайно.
- Consilium никогда не печатает и не записывает ключи API; `doctor` проверяет только наличие ожидаемых переменных окружения, авторизацией занимается OpenCode.
- `doctor` предупреждает об отсутствующих ключах и рискованной конфигурации.

## Диагностика

| Симптом | Решение |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` или задайте `opencodePath` |
| `Model unavailable` | Модель ротирована или заблокирована в регионе; запустите `consilium models --verify --refresh` |
| `Agent not found` | Нет persona-агента; Consilium откатывается на default-агент + вашу модель. Добавьте агентов через `consilium init --free` |
| Таймауты | Бесплатные модели бывают медленными; увеличьте `--expert-timeout` или используйте `--preset fast` |
| `RATE_LIMITED` / 429 | Квота бесплатной модели исчерпана; в ошибке указана задержка повтора. Смените модель или провайдера |
| Модель агента игнорируется в V2 | Consilium уже передаёт `--model`; запустите `consilium doctor` (проверка `opencode-v2-compat`) |
| `COST_LIMIT` | Председатель пропущен намеренно; мнения экспертов и консенсус — в частичном результате, расходы — в `metadata.cost.byAgent` |
| Фолбэки всё равно ловят 429 | Запасные модели часто делят те же бесплатные квоты; смените провайдера или дождитесь задержки повтора |
| Сессии плодятся в `session list` | Так задумано: у каждого агента своя сессия; чистите через `opencode session delete <id>` |
| `replay` не находит id | Id ищутся в `.consilium/runs/`; проверьте каталог или передайте `--artifacts-dir` того запуска |
| MCP-сервер не виден в V2 | Плоский `mcp.<name>` игнорируется; запустите `consilium mcp --install --force` |
| `Managed service port ... in use` | Оставьте `standalone: true` (по умолчанию) |
| Пустой результат | `consilium doctor`, затем повторный запуск с `-V` |

## История изменений

**1.11.0** — read-only- и изолированные запуски, MCP-инструменты артефактов, отчёты для тикетов и расширенный eval-корпус. `--read-only` ограничивает экспертов и председателя инструментами read/glob/grep через временный слой `.opencode/opencode.json` с блокировкой, резервной копией и побайтовым восстановлением; `audit` и GitHub Action по умолчанию работают в read-only, а `--allow-write` отменяет ограничение. `--isolate` запускает каждого агента в worktree OpenCode. В MCP добавлены `consilium_list_runs`, `consilium_get_run`, `consilium_sarif` и `consilium_diff_runs`; `--report jira|linear` рендерит Jira wiki/Linear Markdown. V1 `tools`/`permission` теперь мигрируют в упорядоченные правила V2. Eval-корпус вырос до 22 фикстур; числа бенчмарка получаются реальным запуском моделей и не коммитятся. 561 тест JavaScript + 9 тестов Python.

**1.10.0** — дистрибуция PyPI и загрузка SARIF в GitHub Action. `pip install lv24-opencode-consilium` устанавливает тонкий лаунчер `consilium` без зависимостей, который делегирует npm CLI через `npx` (Node.js >= 18 и OpenCode остаются обязательными; npm остаётся каноническим). Публикация в PyPI использует Trusted Publishing (OIDC) из `.github/workflows/pypi-publish.yml`, поэтому GitHub-релиз публикует npm и PyPI без токенов и OTP. `consilium sarif --run <id|latest> [--output <file>]` экспортирует SARIF из сохранённых артефактов без повторного запуска совета; композитный action теперь передаёт `--artifacts`, экспортирует SARIF и загружает его через `github/codeql-action/upload-sarif` (входы `sarif`, `sarif-file`, `category`; требуется `security-events: write`), а сбои SARIF никогда не маскируют гейт. 522 теста JavaScript + 5 тестов Python.

**1.9.0** — экспорт SARIF, оценка дебатов и рецепты планировщика. `--report sarif` выдаёт SARIF 2.1.0 (маппинг серьёзности, локации файл/строка, стабильные отпечатки, id правил по категориям) для GitHub code scanning и других SARIF-просмотрщиков; расширения `.sarif`/`.sarif.json` определяются автоматически. `eval --compare-rounds` прогоняет каждую фикстуру с одним и двумя раундами и печатает дельты catch/FP/p50/cost; `eval --rounds 2` запускает набор в режиме дебатов. `docs/scheduling.md` плюс примеры для cron, Task Scheduler, launchd и GitHub Actions позволяют планировать аудит диапазона коммитов без демона. 515 тестов.

**1.8.0** — раунды дебатов, локальный bootstrap и аудит диапазона коммитов. `--rounds 2` добавляет раунд анонимизированного peer-review: каждый эксперт критикует коллег и формулирует итоговую позицию; председатель видит итоговые позиции и то, кто изменил мнение, а `metadata.debate` фиксирует участников и изменения. `consilium init --local` опрашивает Ollama/LM Studio, назначает локальные модели по кругу всем ролям и председателю и пишет конфиг с `localOnly`. `consilium audit --since <ref>` ревьюит диапазон коммитов целиком, переиспользуя отчёты, артефакты и `--fail-on`; `--dry-run` печатает запрос без вызова моделей. 491 тест.

**1.7.0** — дедлайны и приватность. `--deadline <ms>` ограничивает фазу экспертов: отставшие отменяются, председатель синтезирует завершённых экспертов с пометкой о недостающих ролях, а запуск без единого завершённого эксперта падает с `DEADLINE`. `--local-only` требует явную локальную модель (Ollama, LM Studio, llama.cpp, vLLM) для каждого агента; `models --local` фильтрует каталог, `models --probe-local` сообщает, запущены ли локальные провайдеры; `doctor` добавляет проверку `local-providers`. Свои пресеты в `consilium.config.json` сливаются поверх встроенных и работают в CLI, MCP и плагине (`consilium presets` перечисляет их). Маркер доверенного конфига теперь переживает spread-объекты. 446 тестов.

**1.6.0** — eval-харнесс, context pack, память надёжности и GitHub Action. `consilium eval` прогоняет фикстуры с посаженными багами и детерминированным сопоставлением `claim`, показывая catch/FP/p50 latency/cost (`--fail-under` завершается кодом `3`). `--context auto` добавляет изменённые файлы, ближайший `AGENTS.md`, связанные тесты и недавние коммиты в пределах лимита символов. Исходы и латентность моделей сохраняются в `.consilium/reliability.json` (`models --reliability`). Композитный GitHub Action делает ревью diff PR и публикует или обновляет один комментарий. Нечёткое слияние по `claim` дедуплицирует перефразированные находки. `consilium history` и `consilium stats` сводят данные о запусках, задержке и надёжности. 381 тест.

**1.5.0** — структурированные находки и policy gate. `--findings` заставляет экспертов и председателя возвращать провалидированный JSON-блок `findings[]` (`severity`, `category`, `file`, `line`, `claim`, `evidence`, `confidence`); находки дедуплицируются по стабильному отпечатку, сливаются по ролям, помечаются `contested`, если председатель их отклонил, и попадают в `metadata.findings`. HTML- и PR-отчёты рисуют таблицу находок и реестр разногласий. `--fail-on <severity>` гейтит по **новым** находкам с кодом выхода `3`; `consilium baseline accept|prune` управляет `.consilium/baseline.json`. Также: исправления корректности P1 (приоритет конфигов V1/V2, предупреждения о битом конфиге, fallback/`minContext`/дедупликация кэша моделей, телеметрия стоимости, эскалация SIGKILL, префикс сессий `ses_`, разбор `argv[0]` в CLI, перезапуск/сигналы watch, крайние случаи preset/consensus/smart-experts) и слэш-команда `/council`. 317 тестов.

**1.4.3** — усиление безопасности. Конфиг проекта недоверенный по умолчанию: `opencodePath`, `opencodeArgs`, `autoApprove`, `cwd`, `opencodeConfigPath` и строковые пути записи игнорируются, если файл не передан через `-c`. На Windows `.cmd` запускается только с проверенными аргументами, `.exe` — напрямую. MCP отклоняет `tools/call` без `id`, ограничивает очередь, удерживает output/артефакты внутри workspace, а `init_free` делает `.bak` и требует подтверждения для `force`. Динамические fence для diff и экранирование отчётов блокируют инъекции; артефакты редактируют токены и получают `.gitignore`. 246 тестов.

**1.4.2** — внутренний рефакторинг по слоям (`shared`, `domain`, `application`, `infrastructure`, `interfaces`) с баррелями на срезах. API и поведение не менялись: публичная поверхность экспортов идентична 1.4.1 по всем 22 subpath. Новый продуктовый README, [`llms.txt`](../llms.txt) и [`docs/architecture.md`](architecture.md); переводы ru/zh синхронизированы; `dist` очищается перед каждой сборкой. 224 теста.

**1.4.1** — npm-пакет переименован в `lv24-opencode-consilium` (npm не умеет переименовывать на месте; `opencode-consilium@1.0.2` остаётся deprecated). На странице npm показывается этот README; переводы перенесены в `docs/`. Образ контейнера опубликован в GHCR. Функциональных изменений нет.

**1.4.0** — `--report html|pr|markdown` и `--report-file`; `--variant high`; `consilium watch`; `consilium hooks install|uninstall`; нативный плагин OpenCode V2 (`consilium.run`); `--replay` восстанавливает модели председателя/экспертов и флаги запуска; новые ключи конфига `report`, `reportFile`, `variant`, `debounceMs`; 224 теста.

**1.3.0** — артефакты запусков + `--replay`/`--diff-runs`; `--consensus`; `--smart-experts`; `--max-cost`; `--fallback-models`; `--session`; MCP-аргументы для всего перечисленного.

**1.2.0** — поддержка OpenCode V2 при сохранении V1: двойные секции конфига, слияние `.opencode/` и родительских каталогов, `--model` передаётся всегда, установка `mcp.servers`, `--native-v2`, политика повторов `RATE_LIMITED`, проверки V2 в `doctor`. `opencodeConfigPath` больше не задаётся по умолчанию: путь определяется автоматически, а несуществующий даёт предупреждение и откат к поиску. Агенты с V1-ограничениями (`tools`, `permission`, `temperature`) не мигрируют автоматически в `--native-v2`, чтобы не потерять ограничения.

## Планы

| Идея | Ценность | Размер |
| --- | --- | --- |
| Опубликовать измеренные результаты eval на 22 фикстурах | Доказательство catch/FP/p50/cost на реальном провайдере | M |
| Read-only внутри изолированных worktree + очистка worktree | Глубина защиты для `--isolate` | M |
| MCP replay/streaming | Запуск или стрим совета из удалённого харнесса | M |

Slash-команда `/council` и экспорт в Jira/Linear из прошлых планов вышли в 1.11.0.

## Разработка

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (561 тест)
npm run typecheck   # tsc --noEmit
python -m unittest discover -s python/tests   # 9 тестов лаунчера
```

## Лицензия

MIT
