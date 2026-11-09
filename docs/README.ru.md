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
| 📊 | **Отчёты** | Самодостаточный HTML или markdown, готовый для PR в GitHub |
| 🔁 | **Watch-режим** | Перезапуск при изменениях файлов с debounce, текущий git diff прикладывается |
| 🪝 | **Git pre-commit hook** | Ревью staged-изменений и блокировка коммита при ошибке |
| 🔌 | **MCP-сервер** | stdio JSON-RPC для Claude Desktop, Codex, Cursor, VS Code, своих агентов |
| 🧩 | **Плагин V2** | Инструмент `consilium.run` прямо в TUI OpenCode V2 |
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
```

**Требования**

| Что нужно | Детали |
| --- | --- |
| Node.js | **>= 18** |
| OpenCode CLI | `npm install -g opencode-ai`, авторизован, **V1 или V2** |
| Опционально | `OPENROUTER_API_KEY` для бесплатных моделей OpenRouter |

### Образ контейнера (GHCR)

Самодостаточный образ (Node.js, OpenCode CLI, `git`) для `linux/amd64` и `linux/arm64`:

```bash
docker pull ghcr.io/levapveeskela/lv24-opencode-consilium:1.4.3   # или :latest
docker run --rm ghcr.io/levapveeskela/lv24-opencode-consilium:latest --version
# consilium v1.4.3
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
| `consilium_run` | `task` (обязателен), `experts`, `chair`, `timeout_ms`, `format`, `preset`, `output_file`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts` | Синтез от председателя + мнения экспертов + JSON-метаданные (время, usage, стоимость, модели) |
| `consilium_list_agents` | — | Настроенные эксперты, модели, председатель, пресеты, путь конфига |
| `consilium_free_models` | `limit`, `available_only`, `refresh` | Таблица рейтинга бесплатных моделей |
| `consilium_doctor` | — | Диагностика окружения и конфига |
| `consilium_init_free` | `apply`, `force`, `confirm`, `verify` | План (по умолчанию) или запись `opencode.json` + `consilium.config.json` |

`consilium_init_free` по умолчанию работает как dry-run — передайте `"apply": true`, чтобы записать файлы; `force: true` дополнительно требует `"confirm": true` и создаёт `.bak`-копии. `consilium_run` показывает прогресс в реальном времени, если клиент прислал `progressToken`, а его ответ содержит `cost`, сводку консенсуса и строку `**Artifacts:**`, когда артефакты включены.

## Для ИИ-агентов

Если вы агент, вот стабильные контракты. Предпочитайте их разбору человеческого текста.

```json
{
  "package": "lv24-opencode-consilium",
  "version": "1.4.3",
  "bins": ["consilium", "consilium-mcp", "lv24-opencode-consilium"],
  "mcp": { "command": "npx", "args": ["-y", "lv24-opencode-consilium", "mcp"] },
  "json_mode": "consilium -f json \"<task>\"",
  "models_json": "consilium models --json",
  "config_files": ["consilium.config.json", "consilium.json", ".consiliumrc", ".consiliumrc.json"],
  "config_schema": "schema/config.schema.json",
  "exit_codes": { "0": "success", "1": "run failed", "2": "usage error" },
  "docs_index": "llms.txt"
}
```

Правила, которые важны при управлении из агента:

1. **stdout — для данных, stderr — для прогресса.** `-f json` печатает один JSON-документ в stdout; логи и прогресс остаются в stderr.
2. **Не парсите человеческий текст.** Используйте `-f json` (результат + `metadata`), `consilium models --json` или MCP-инструменты.
3. **Ошибки типизированы.** `errorCode` — одно из `RATE_LIMITED`, `MODEL_UNAVAILABLE`, `EMPTY_RESPONSE`, `AGENT_NOT_FOUND`, `COST_LIMIT`, `TIMEOUT`, …; коды выхода — `0/1/2`.
4. **Состояние — это файлы, а не демон.** Артефакты лежат в `.consilium/runs/<id>/` (`run.json`, `report.md`, `experts/<agent>.md`); `--replay <id>` восстанавливает запуск.
5. **Никаких интерактивных запросов.** Каждая команда неинтерактивна; `--auto` выключен по умолчанию и включается осознанно.
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
consilium init [--free] [--dry-run] [--force] [--no-verify] [--native-v2]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp [--install] [--global]
consilium watch [--debounce <ms>] [task]
consilium hooks install|uninstall
```

**Ядро**

| Флаг | Значение |
| --- | --- |
| `-c, --config <file>` | Файл конфигурации (иначе автоопределение) |
| `-e, --experts a,b` | Подмножество экспертов |
| `--chair <agent>` | Имя агента-председателя |
| `--preset <name>` | `fast`, `deep`, `security`, `review`, `free` |
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
| `--report <format>` | Отчёт после запуска: `html`, `pr`, `markdown` (`markdown` — тот же PR-вариант) |
| `--report-file <file>` | Записать отчёт в файл (`.html` → html, `.md` → pr; без файла отчёт идёт в stdout, кроме `-f json`) |
| `--diff [--staged] [--base <ref>]` | Приложить текущий git diff к задаче |
| `--debounce <ms>` | Задержка watch-режима (по умолчанию 400) |
| `watch [--debounce <ms>] [task]` | Следить за проектом и перезапускать при изменениях (до Ctrl+C) |
| `hooks install\|uninstall` | Установить/удалить git pre-commit hook (ревью staged перед коммитом) |
| `--native-v2` | Писать нативный V2-конфиг (`agents`/`system`) |
| `--install`, `--global` | Зарегистрировать MCP-сервер в проектном или глобальном конфиге |

Коды выхода: `0` успех, `1` запуск неуспешен, `2` ошибка использования.

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

# --report-file сам определяет формат: .html → html, .md → pr
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

## Пресеты

| Пресет | Эксперты | Поведение |
| --- | --- | --- |
| `fast` | arch, sec | таймаут эксперта 3 мин, без повторов |
| `deep` | все четыре | удвоенные таймауты, повторы включены |
| `security` | sec, arch, ba | ревью с фокусом на безопасность |
| `review` | arch, sec, ux | ревью кода |
| `free` | все четыре | под bootstrap бесплатных моделей |

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
| `autoApprove` | `false` | `--auto`; включайте только если доверяете агентам/инструментам |
| `autoDiscoverAgents` | `true` | Переиспользовать агентов из `opencode.json` |
| `artifacts` | `false` | `true` → `.consilium/runs/<id>/`; строка задаёт свой каталог |
| `consensus` | `false` | Лексический анализ согласия экспертов |
| `smartExperts` | `false` | Эвристический выбор 2–3 ролей |
| `maxCost` | — | Лимит стоимости в USD (число >= 0); без значения — без лимита |
| `fallbackModels` | — | Массив строк `provider/model` для повторов при ошибках модели |
| `session` | — | Базовый id сессии OpenCode |
| `report` | — | Формат отчёта: `html`, `pr`, `markdown` |
| `reportFile` | — | Путь к файлу отчёта (`.html`/`.md` выбирает формат) |
| `variant` | — | Вариант модели для моделей без `#variant` (явный вариант приоритетнее) |
| `debounceMs` | 400 | Задержка watch-режима, мс |
| `opencodePath` | `opencode` | Свой путь к CLI |
| `cwd` | текущая | Рабочая директория для OpenCode |

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

**1.4.3** — усиление безопасности. Конфиг проекта недоверенный по умолчанию: `opencodePath`, `opencodeArgs`, `autoApprove`, `cwd`, `opencodeConfigPath` и строковые пути записи игнорируются, если файл не передан через `-c`. На Windows `.cmd` запускается только с проверенными аргументами, `.exe` — напрямую. MCP отклоняет `tools/call` без `id`, ограничивает очередь, удерживает output/артефакты внутри workspace, а `init_free` делает `.bak` и требует подтверждения для `force`. Динамические fence для diff и экранирование отчётов блокируют инъекции; артефакты редактируют токены и получают `.gitignore`. 246 тестов.

**1.4.2** — внутренний рефакторинг по слоям (`shared`, `domain`, `application`, `infrastructure`, `interfaces`) с баррелями на срезах. API и поведение не менялись: публичная поверхность экспортов идентична 1.4.1 по всем 22 subpath. Новый продуктовый README, [`llms.txt`](../llms.txt) и [`docs/architecture.md`](architecture.md); переводы ru/zh синхронизированы; `dist` очищается перед каждой сборкой. 224 теста.

**1.4.1** — npm-пакет переименован в `lv24-opencode-consilium` (npm не умеет переименовывать на месте; `opencode-consilium@1.0.2` остаётся deprecated). На странице npm показывается этот README; переводы перенесены в `docs/`. Образ контейнера опубликован в GHCR. Функциональных изменений нет.

**1.4.0** — `--report html|pr|markdown` и `--report-file`; `--variant high`; `consilium watch`; `consilium hooks install|uninstall`; нативный плагин OpenCode V2 (`consilium.run`); `--replay` восстанавливает модели председателя/экспертов и флаги запуска; новые ключи конфига `report`, `reportFile`, `variant`, `debounceMs`; 224 теста.

**1.3.0** — артефакты запусков + `--replay`/`--diff-runs`; `--consensus`; `--smart-experts`; `--max-cost`; `--fallback-models`; `--session`; MCP-аргументы для всего перечисленного.

**1.2.0** — поддержка OpenCode V2 при сохранении V1: двойные секции конфига, слияние `.opencode/` и родительских каталогов, `--model` передаётся всегда, установка `mcp.servers`, `--native-v2`, политика повторов `RATE_LIMITED`, проверки V2 в `doctor`. `opencodeConfigPath` больше не задаётся по умолчанию: путь определяется автоматически, а несуществующий даёт предупреждение и откат к поиску. Агенты с V1-ограничениями (`tools`, `permission`, `temperature`) не мигрируют автоматически в `--native-v2`, чтобы не потерять ограничения.

## Планы

| Идея | Ценность | Размер |
| --- | --- | --- |
| Slash-команда `consilium` для TUI | Вызвать совет одной командой внутри OpenCode | S |
| Экспорт отчёта в тикет-системы | Готовый артефакт для Jira/Linear | S |

## Разработка

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (224 теста)
npm run typecheck   # tsc --noEmit
```

## Лицензия

MIT
