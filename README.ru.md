# lv24-opencode-consilium

Консилиум ИИ-экспертов для [OpenCode](https://opencode.ai): несколько ролей-агентов **параллельно отвечают на разных моделях**, затем председатель синтезирует итоговый план. В комплекте — подбор сильнейших бесплатных моделей, CLI, библиотека и **MCP-сервер** для любого харнесса (Claude Desktop, Codex, Cursor, VS Code, свои агенты).

```
consilium "Оцени дизайн аутентификации"
  arch  → flint-40b-free
  ux    → inkling-2-small-free
  ba    → deepseek-v4.1-flash-free
  sec   → iceman-free
  chair → beam-free   ← синтез
```

## Зачем

- **Разные модели — разные слепые зоны.** Одна модель пропускает то, что ловит другая; председатель разрешает расхождения.
- **По умолчанию $0.** Находит бесплатные модели с поддержкой tools в публичных каталогах, ранжирует, проверяет реальным запросом и прописывает в конфиг.
- **Работает с тем, что уже есть.** Использует OpenCode CLI (агенты, авторизация, провайдеры), а не отдельный стек провайдеров.
- **Работает внутри любого харнесса.** Тот же движок доступен как MCP-сервер по stdio.

## Возможности

- Параллельные эксперты с маршрутизацией `agent` + `model` и ограничением конкурентности.
- Синтез председателем: настраиваемый шаблон и лимит текста каждого эксперта.
- Динамический подбор бесплатных моделей: `models.dev` + OpenRouter + офлайн-набор; кэш 12 ч.
- Прозрачный рейтинг (контекст, tools, structured output, reasoning, свежесть, семейство, «теневая цена» платного аналога).
- Реальная проверка: короткий запрос к каждой модели-кандидату, отбрасываются недоступные в регионе.
- Надёжный раннер: промпт через stdin (без shell-инъекций и лимита 8 КБ Windows), изоляция `--standalone`, retry с backoff, таймауты, отмена, учёт токенов и стоимости.
- `doctor`, пресеты, ревью git diff, чистый JSON-вывод.
- MCP-инструменты: запуск консилиума, список агентов, бесплатные модели, диагностика, bootstrap.
- Строгий TypeScript, ноль runtime-зависимостей, Node >= 18.

## Требования

- Node.js **>= 18**
- Установленный и авторизованный [OpenCode CLI](https://opencode.ai) (`npm install -g opencode-ai`), **V1 или V2**
- Опционально: `OPENROUTER_API_KEY` для бесплатных моделей OpenRouter

## Совместимость с OpenCode V1 и V2

Пакет работает с обеими ветками OpenCode и определяет формат конфигурации сам:

| Что | OpenCode V1 | OpenCode V2 |
| --- | --- | --- |
| `opencode.json` формат | `agent` + `prompt` | `agents` + `system` |
| MCP-серверы | `mcp.<name>` + `enabled` | `mcp.servers.<name>` + `disabled` |
| Команды | `command` + `subtask` | `commands` + `subagent` |
| Модель агента при `run --agent` | применяется из конфига | **игнорируется**, нужен `--model` |

Что из этого следует на практике:

- **V1-формат — база.** Его читают обе версии, поэтому `consilium init --free` по умолчанию пишет именно его. Ничего конвертировать не нужно.
- **Нативный V2 для агентов** (`agents` + `system`) пишется только по флагу `consilium init --free --native-v2` или если файл уже ведётся в V2-формате. MCP-сервер ставится отдельно: `consilium mcp --install`.
- **Модели всегда передаются явно.** `consilium` подставляет `--model` из `consilium.config.json` или из `opencode.json`, потому что V2 не применяет модель агента при `--agent`.
- **Агенты читаются из обоих разделов.** V2-проекты с `agents` и V1-проекты с `agent` определяются автоматически; файлы `opencode.json(c)`, `.opencode/opencode.json(c)` и родительских каталогов сливаются в том же порядке, что и в OpenCode (`.opencode` приоритетнее).
- **429 и лимиты бесплатных моделей** распознаются как `RATE_LIMITED`: короткий лимит (до 30 с) пережидается повтором, длинный сразу возвращает ошибку с временем до следующей попытки.
- **`doctor` проверяет совместимость**: версию CLI, формат файла, дубли `agent`/`agents`, мёртвые в V2 поля (`theme`, `autoupdate`) и плоские MCP-записи.

Регистрация MCP-сервера одной командой (формат выбирается по установленной версии OpenCode):

```bash
consilium mcp --install            # ./opencode.json
consilium mcp --install --global   # ~/.config/opencode/opencode.json
opencode mcp list                  # проверка
```

## Установка

```bash
npm install -g lv24-opencode-consilium
# или без установки:
npx -y lv24-opencode-consilium --help
```

## Быстрый старт

```bash
# 1. Проверить окружение (CLI, конфиг, агенты, модели)
consilium doctor

# 2. Подобрать сильнейшие рабочие бесплатные модели и записать конфиг
consilium init --free

# 3. Запустить консилиум
consilium "Спроектируй rate limiter для публичного API"
```

Что делает `init --free`:

1. скачивает `https://models.dev/api.json` и `https://openrouter.ai/api/v1/models`;
2. оставляет только бесплатные (`cost = 0`), активные чат-модели с tools и контекстом >= 32K;
3. ранжирует и проверяет топ-кандидатов коротким запросом (если не указан `--no-verify`);
4. записывает победителей в `opencode.json` (агенты `arch`, `ux`, `ba`, `sec`, `consilium`) и `consilium.config.json`;
5. не перезаписывает ваши существующие модели агентов без `--force`.

Только посмотреть план, без записи:

```bash
consilium init --free --dry-run
```

Записать нативный V2-формат агентов (`agents` + `system`):

```bash
consilium init --free --native-v2
```

## Бесплатные модели

```bash
consilium models                 # топ-20 рейтинга
consilium models --available     # только доступные вам провайдеры
consilium models --verify        # проверить показанные модели реальным запросом
consilium models --refresh       # игнорировать кэш 12 ч
consilium models --json          # машинный формат
```

Источники и резервы:

| Источник | Что даёт |
| --- | --- |
| `https://models.dev/api.json` | Полный каталог, цены/лимиты/возможности, связь с платными аналогами |
| `https://openrouter.ai/api/v1/models` | `:free`-варианты, контекст, поддержка `tools`, срок действия |
| Встроенный набор | Проверенные free-модели OpenCode, если каталог их ротировал |

Кэш: `%TEMP%/lv24-opencode-consilium/models-cache.json` (или `CONSILIUM_MODELS_CACHE`), TTL 12 ч.

Провайдер `opencode-go` больше не исключается целиком: его бесплатные модели (`*-free`, `iceman-contributor-free` и т. п.) участвуют в рейтинге. Платные модели этого провайдера, например `opencode-go/muse-spark-1.3-contributor`, в `--free` не попадают — их можно задать вручную в `experts[].model` или `chair.model`.

Текущий рекомендуемый состав (каталог на 2026-11-08):

| Роль | Модель | Почему |
| --- | --- | --- |
| arch | `opencode/flint-40b-free` | coding-агент, structured output, 262k |
| ux | `opencode/inkling-2-small-free` | 1M контекст, мультимодальность, быстрая |
| ba | `opencode/deepseek-v4.1-flash-free` | reasoning + agentic coding, 200k |
| sec | `opencode/iceman-free` | самая свежая reasoning-модель, 262k (stealth) |
| chair | `opencode/beam-free` | топ рейтинга, 1M, structured, coding/agentic |

Бесплатные модели ротируются: `consilium init --free` заново проверяет каталог и реальные ответы. Stealth/alpha-модели (`iceman`, `crouton`) могут исчезнуть — тогда `--refresh` подберёт замену.

Рейтинг (0–1.2) детерминирован: контекст 30%, tools 20%, structured output 10%, reasoning 10%, свежесть 10%, лимит вывода 10%, приор семейства 10%, «теневая цена» платного аналога 15%; штрафы за alpha/preview/stealth.

## MCP-сервер (любой харнесс)

Запуск по stdio:

```bash
consilium mcp
# или напрямую:
consilium-mcp
```

OpenCode V1/V2 — установка в конфиг (формат выбирается автоматически):

```bash
consilium mcp --install            # ./opencode.json → mcp.servers.consilium или mcp.consilium
consilium mcp --install --global   # глобальный конфиг OpenCode
```

Claude Desktop (`claude_desktop_config.json`):

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

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "lv24-opencode-consilium", "mcp"]
```

Подойдёт любой MCP-клиент с stdio JSON-RPC 2.0. Логи идут в **stderr**; stdout — только протокол.

### MCP-инструменты

| Инструмент | Аргументы | Результат |
| --- | --- | --- |
| `consilium_run` | `task` (обязателен), `experts`, `chair`, `timeout_ms`, `format`, `preset`, `output_file` | Синтез + мнения экспертов + JSON-метаданные (время, расход, модели) |
| `consilium_list_agents` | — | Эксперты, модели, председатель, пресеты, путь конфига |
| `consilium_free_models` | `limit`, `available_only`, `refresh` | Таблица рейтинга бесплатных моделей |
| `consilium_doctor` | — | Диагностика окружения и конфига |
| `consilium_init_free` | `apply`, `force`, `verify` | План (по умолчанию) или запись `opencode.json` + `consilium.config.json` |

`consilium_run` также принимает `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`. Ответ включает `cost` и сводку консенсуса в JSON-метаданных и строку `**Artifacts:**` с путём к сохранённому запуску.

`consilium_init_free` по умолчанию ничего не пишет; передайте `"apply": true`. `consilium_run` шлёт прогресс, если клиент передал `progressToken`.

## Справочник CLI

```
consilium [опции] <задача>
consilium <задача> -               # задача из stdin
consilium init [--free] [--dry-run] [--force] [--no-verify] [--native-v2]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp [--install] [--global]
consilium watch [--debounce <мс>] [задача]
consilium hooks install|uninstall
```

Флаги:

| Флаг | Значение |
| --- | --- |
| `-c, --config <файл>` | Файл конфигурации (иначе автоопределение) |
| `-e, --experts a,b` | Подмножество экспертов |
| `--chair <агент>` | Агент-председатель |
| `--preset <имя>` | `fast`, `deep`, `security`, `review`, `free` |
| `--expert-timeout`, `--chair-timeout` | Таймауты в мс (на попытку) |
| `-r, --retries <n>` | Число повторов (0 = одна попытка) |
| `-o, --output <файл>` | Сохранить результат (формат из `-f`) |
| `--no-save` | Не писать файл |
| `-f, --format <fmt>` | `text` (stdout), `markdown`, `json` (чистый JSON) |
| `--diff [--staged] [--base <ref>]` | Добавить текущий git diff к задаче |
| `--task-file <файл>` | Задача из файла (`-` = stdin) |
| `--verify` / `--no-verify` | Проверять/не проверять модели перед выбором (`models` / `init --free`) |
| `--consensus` / `--no-consensus` | Лексический анализ согласия экспертов (пересечение терминов, Jaccard); компактная сводка — в промпт председателя, полный отчёт — в результат |
| `--smart-experts` | Эвристический выбор 2–3 релевантных ролей по тексту задачи/диффа (остальные отбрасываются и логируются) |
| `--max-cost <usd>` | Лимит стоимости в USD; при превышении до старта председателя он не запускается (`COST_LIMIT`, частичный результат с консенсусом) |
| `--fallback-models a,b` | Запасные модели: при `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` тот же эксперт повторяется на следующей модели (цепочка до 2) |
| `--session <id>` | Базовый id сессии OpenCode; у каждого агента своя `ses_<base>-<агент>` (параллельные агенты не делят сессию) |
| `--artifacts` / `--no-artifacts` | Сохранить / не сохранять артефакты запуска (по умолчанию не сохраняются) |
| `--artifacts-dir <путь>` | Сохранить артефакты в указанный каталог (вместо `.consilium/runs/<id>/`) |
| `--replay <id>` | Повторить сохранённый запуск (восстанавливает агента/модель председателя, модели экспертов, флаги consensus/smartExperts/fallbackModels/session) |
| `--report <формат>` | Отчёт после запуска: `html`, `pr`, `markdown` (`markdown` = PR-вариант) |
| `--report-file <файл>` | Записать отчёт в файл (расширение `.html` → html, `.md` → pr; без файла — в stdout, кроме `-f json`) |
| `--variant <имя>` | Вариант модели для всех агентов (`provider/model` → `provider/model#variant`); некорректный — выход 2 |
| `--debounce <мс>` | Задержка watch-режима (по умолчанию 400) |
| `watch [--debounce <мс>] [задача]` | Следить за проектом и перезапускать консилиум при изменениях (до Ctrl+C) |
| `hooks install\|uninstall` | Установить/удалить git pre-commit hook (ревью staged перед коммитом) |
| `--diff-runs <a> <b>` | Напечатать markdown-сравнение двух сохранённых запусков |
| `--native-v2` | Писать нативный V2-формат (`agents`/`system`) вместо V1 |
| `--install`, `--global` | Зарегистрировать MCP-сервер в проекте или глобальном конфиге |
| `-s, --silent` | Только итоговый результат |
| `-V, --verbose` | Сырые события прогресса |
| `-v, --version`, `-h, --help` | Версия / справка |

Коды выхода: `0` успех, `1` запуск неуспешен, `2` ошибка использования.

Примеры:

```bash
consilium -e arch,sec "Смоделируй угрозы для загрузки файлов"
consilium --preset deep "Составь план миграции"
git diff --staged | consilium - "Сделай ревью изменений"
consilium --diff "Сделай ревью текущих изменений"
consilium -f json "..." > council.json
consilium --smart-experts --consensus "Спроектируй схему БД для подписок"
consilium --artifacts --max-cost 0.5 "Составь план миграции"
consilium --replay 2026-11-08-abc123
consilium --diff-runs 2026-11-08-abc123 2026-11-08-def456
consilium --report pr --report-file review.md "Сделай ревью текущих изменений"
consilium --variant high "Спроектируй схему БД для подписок"
consilium watch --debounce 500 "Ревью текущих изменений"
consilium hooks install
```

## Анализ, артефакты и стоимость

`--consensus` считает лексическое согласие экспертов: пересечение значимых терминов (Jaccard, стоп-слова RU+EN) по каждой паре, средний score и уровень `agreement` (`high`/`medium`/`low`). Это не LLM-оценка, а детерминированный подсчёт по текстам ответов. Компактная сводка подставляется в промпт председателя, полный отчёт дописывается к результату и хранится в `metadata.consensus` (`agreement`, `averageSimilarity`, `pairs`, `sharedTerms`, `uniqueTerms`).

`--smart-experts` подбирает 2–3 релевантные роли эвристикой (лексиконы arch/ux/ba/sec, RU+EN) по задаче и диффу; отброшенные роли логируются в прогресс. Выбор хранится в `metadata.smartExperts`.

`--max-cost <usd>` следит за накопленной стоимостью экспертов и председателя. Если лимит исчерпан до старта председателя, он не запускается: возвращается частичный результат с мнениями экспертов и консенсусом, `errorCode: COST_LIMIT`. Детализация — в `metadata.cost` (`limit`/`spent`/`exceeded`/`byAgent`); при превышении добавляется `metadata.costExceeded`.

`--fallback-models a,b` задаёт запасные модели: при `RATE_LIMITED`, `MODEL_UNAVAILABLE` или `EMPTY_RESPONSE` тот же эксперт повторяется на следующей модели из цепочки (максимум 2 подмены на эксперта), usage суммируется. Список хранится в `metadata.fallbackModels`.

Артефакты — обычные файлы, без базы данных. `--artifacts` сохраняет запуск в `.consilium/runs/<id>/`: `run.json` (задача, ответы экспертов, модели, usage, консенсус), `report.md` (читаемый отчёт) и `experts/<агент>.md` (ответ каждого эксперта). `--artifacts-dir <путь>` меняет каталог, `--no-artifacts` отключает сохранение. Id и каталог видны в `metadata.artifacts: { id, dir }`. `consilium --replay <id>` повторяет сохранённый запуск (восстанавливает агента и модель председателя, модели экспертов, флаги consensus/smartExperts/fallbackModels/session из артефакта), `consilium --diff-runs <a> <b>` печатает markdown-сравнение двух запусков.

`--session <id>` задаёт базовый id сессии OpenCode: председатель продолжает её как есть, а каждый эксперт получает свою `ses_<base>-<агент>` (префикс `ses_` требует OpenCode). Параллельные агенты никогда не делят одну сессию — иначе часть промптов теряется (см. `docs/session-and-plugin.md`). Неизвестные агенты из `opencode.json` определяются автоматически и запускаются на default-агенте с отдельной сессией `ses_<base>-default-<агент>`, не засоряя чужую сессию. Флаг не скрывает сессии из списков: архивные сессии всё равно видны в `opencode session list`.

## Отчёты, watch и git-hooks

```bash
# HTML-отчёт в файл / PR-markdown в stdout
consilium --report html --report-file report.html "Сделай ревью текущих изменений"
consilium --report pr "Сделай ревью текущих изменений"

# Расширение --report-file выбирает формат само: .html → html, .md → pr
# Без --report-file отчёт печатается в stdout, кроме -f json (тогда нужен --report-file)
consilium --report-file notes.md "Спроектируй схему БД"

# Перезапуск при изменениях файлов (игнорирует .git/node_modules/dist/.consilium/coverage/*.tmp/*.log,
# пауза 400 мс между событием и запуском, к задаче прикладывается текущий git diff)
consilium watch "Ревью текущих изменений"
consilium watch --debounce 800

# Pre-commit hook: перед каждым git commit запускает ревью staged-изменений и блокирует коммит при ошибке
consilium hooks install
consilium hooks uninstall   # убрать управляемый блок, чужое содержимое hook'а не трогается
```

PR-отчёт — это markdown для комментария GitHub с маркером `<!-- consilium:report -->` и сворачиваемыми `<details>`-блоками мнений экспертов; HTML-отчёт — самодостаточный файл с экранированным текстом. Hook пишет только свой блок (`# >>> consilium >>>` … `# <<< consilium <<<`) в каталог git-хуков (`git rev-parse --git-path hooks`: `.git/hooks`, `core.hooksPath`, worktrees) и сохраняет остальное содержимое.

## Плагин OpenCode V2

Нативный плагин запускает консилиум **внутри TUI OpenCode V2** без MCP и внешнего CLI — через инструмент `consilium.run`. В OpenCode V1 не работает (API плагинов V1 несовместим).

Регистрация в `opencode.json` (V2):

```json
{
  "plugins": [{ "package": "lv24-opencode-consilium" }]
}
```

Пакет публикует server part как `./server` (`dist/plugin.js`); рантайм-зависимостей у плагина нет (`@opencode/plugin` нужен только для типов при сборке). Инструмент принимает `task`, `experts`, `chair`, `timeout_ms`, `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`, `preset`.

Когда что использовать:

| Способ | Когда |
| --- | --- |
| Плагин (`consilium.run`) | Работа внутри TUI OpenCode V2, совет нужен прямо в диалоге |
| MCP-сервер | Внешние харнессы (Claude Desktop, Codex, Cursor, VS Code, свои агенты) |
| CLI | Терминал, скрипты, CI, hooks, watch |

## Пресеты

| Пресет | Эксперты | Поведение |
| --- | --- | --- |
| `fast` | arch, sec | таймаут 3 мин, без повторов |
| `deep` | все четыре | удвоенные таймауты, повторы |
| `security` | sec, arch, ba | фокус на безопасность |
| `review` | arch, sec, ux | ревью кода |
| `free` | все четыре | под бесплатную конфигурацию |

## Конфигурация

Порядок поиска конфигурации Consilium (cwd): `consilium.config.json`, `consilium.json`, `.consiliumrc`, `.consiliumrc.json`. Явный путь — `-c`. Конфигурация OpenCode ищется в `opencode.json`/`opencode.jsonc`, `.opencode/opencode.json(c)`, затем в родительских каталогах и в `~/.config/opencode`; комментарии JSONC допустимы.

Минимальный пример:

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

Ключевые опции:

| Ключ | По умолчанию | Примечание |
| --- | --- | --- |
| `experts[].model` | — | `provider/model`; передаётся как `--model`, переопределяет модель агента |
| `chair.model` | — | Переопределение модели председателя |
| `timeouts.expert` / `.chair` | 300000 / 600000 | На попытку, мс |
| `retry.expertRetries` / `.chairRetries` | 1 | `0` = одна попытка |
| `retry.jitter` | `false` | Случайный разброс задержки повтора (50–100%), чтобы эксперты не били в лимит одновременно |
| `retry.maxConcurrency` | 3 | 1–8 параллельных агентов |
| `output.file` | `false` | `false` — не сохранять; строка — включить |
| `standalone` | `true` | Приватный сервер `--standalone`; не конфликтует с запущенным OpenCode |
| `autoApprove` | `false` | `--auto`; включайте только если доверяете агентам/инструментам |
| `autoDiscoverAgents` | `true` | Брать агентов из `opencode.json` |
| `artifacts` | `false` | `true` — сохранять в `.consilium/runs/<id>/`; строка — свой каталог |
| `consensus` | `false` | Лексический анализ согласия экспертов |
| `smartExperts` | `false` | Эвристический выбор 2–3 ролей под задачу |
| `maxCost` | — | Лимит стоимости в USD (число >= 0); без значения — без лимита |
| `fallbackModels` | — | Массив строк `provider/model` для повтора при лимитах/ошибках модели |
| `session` | — | Базовый id сессии OpenCode (непустая строка) |
| `report` | — | Формат отчёта: `html`, `pr`, `markdown` |
| `reportFile` | — | Путь к файлу отчёта (расширение `.html`/`.md` выбирает формат) |
| `variant` | - | Вариант модели для моделей без `#variant` (явный вариант приоритетнее) |
| `debounceMs` | 400 | Задержка watch-режима, мс (целое >= 0) |
| `opencodePath` | `opencode` | Свой путь к CLI |
| `cwd` | текущая | Рабочая директория OpenCode |

Полная схема: [`schema/config.schema.json`](schema/config.schema.json); пример: [`consilium.config.example.json`](consilium.config.example.json).

## Библиотека

```ts
import { Consilium, runConsilium, fetchFreeModels, selectCouncilModels } from 'lv24-opencode-consilium';

const council = new Consilium();
council.onProgress(event => console.error(event.type, event.agent ?? ''));

const result = await council.run('Спроектируй стратегию инвалидации кэша');
console.log(result.text);           // синтез председателя
console.log(result.usage?.cost);    // суммарная стоимость (0 для бесплатных)

const oneShot = await runConsilium('...'); // возвращает ConsiliumResult
console.log(oneShot.text);

const { models } = await fetchFreeModels({ includeUnavailable: true });
const top = selectCouncilModels(models, 5);
```

Экземпляр `Consilium` переиспользуемый: `run()` можно вызывать снова после completed/failed/cancelled. `cancel()` останавливает все дочерние процессы текущего запуска.

## Как это работает

Для каждого эксперта и председателя запускается:

```
opencode run --standalone --format json [--auto] [--agent=NAME] [--model=provider/model]
```

Промпт пишется в **stdin** (UTF-8), поэтому произвольный текст задачи безопасен и не упирается в лимиты командной строки. NDJSON-события декодируются потоково (`text`, `step_finish` с usage/cost, `error` с `type`/`status`/`retryAfterMs`). Модель всегда передаётся через `--model`: так поведение одинаково в V1 и V2, где `--agent` не применяет модель из конфигурации. Коды выхода, хвост stderr и структурированные ошибки отдаются типизированными `errorCode` (`RATE_LIMITED`, `MODEL_UNAVAILABLE`, `AGENT_NOT_FOUND`, ...). Если агента нет в конфиге OpenCode, вызов повторяется один раз с той же моделью и default-агентом — консилиум работает даже без persona-агентов.

## Безопасность

- Текст задачи не попадает в shell-команду; только stdin.
- Имена агентов и id моделей валидируются.
- `--auto` (авто-подтверждение разрешений) **выключен** по умолчанию.
- `--standalone` изолирует дочерний сервер.
- Ключи API не печатаются и не пишутся; `doctor` проверяет только наличие переменных окружения, авторизацией занимается OpenCode.
- `doctor` предупреждает об отсутствующих ключах и рискованном конфиге.

## Диагностика

| Симптом | Решение |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` или `opencodePath` |
| `Model unavailable` | Модель ротирована/заблокирована; `consilium models --verify --refresh` |
| `Agent not found` | Нет persona-агента; будет default-агент + ваша модель. Создайте агентов через `consilium init --free` |
| Таймауты | Бесплатные модели бывают медленными; увеличьте `--expert-timeout` или `--preset fast` |
| `RATE_LIMITED` / 429 | Лимит бесплатных моделей исчерпан; в ошибке указано время повтора. Смените модель или провайдера |
| `Model unavailable` | Модель ротирована/заблокирована; `consilium models --verify --refresh` |
| `Agent not found` | Нет persona-агента; будет default-агент + ваша модель. Создайте агентов через `consilium init --free` |
| Модель агента не применяется в V2 | `consilium` уже передаёт `--model`; проверьте `consilium doctor` (проверка `opencode-v2-compat`) |
| `COST_LIMIT` (лимит `--max-cost` исчерпан) | Председатель не запущен намеренно; мнения экспертов и консенсус — в частичном результате, расходы — в `metadata.cost.byAgent`. Поднимите лимит или уберите флаг |
| Фолбэк не спасает от 429 | Запасные модели делят те же бесплатные квоты; смените провайдера или подождите время повтора из ошибки |
| Сессии плодятся в `session list` | Так задумано: у каждого агента своя сессия, `--session` их не скрывает (`--archived` тоже не скрывает). Чистка — `opencode session delete <id>` |
| `replay` не находит id | Id ищется в `.consilium/runs/`; проверьте каталог или передайте `--artifacts-dir` того запуска |
| MCP-сервер не виден в V2 | Плоский `mcp.<name>` игнорируется; `consilium mcp --install --force` |
| `Managed service port ... in use` | Оставьте `standalone: true` (по умолчанию) |
| Пустой результат | `consilium doctor`, затем запуск с `-V` |

## Разработка

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (224 теста)
npm run typecheck   # tsc --noEmit
```

## Изменения 1.2.0

- Совместимость с OpenCode V2 при сохранении поддержки V1: чтение `agent` и `agents`, `.opencode/opencode.json(c)`, родительских каталогов и слияние слоёв в порядке OpenCode.
- Модель агента передаётся через `--model` — V2 больше не теряет модель при `--agent`.
- `consilium mcp --install [--global]` пишет `mcp.servers` для V2 и `mcp.<name>` для V1, сохраняя `environment`/`cwd`/`timeout` существующей записи.
- `init --free --native-v2` пишет нативный V2-формат; дубли `agent`/`agents` обновляются синхронно. Агенты с V1-ограничениями (`tools`, `permission`, `temperature`) не мигрируют автоматически, чтобы не потерять ограничения.
- `opencodeConfigPath` больше не задаётся по умолчанию: автоопределение работает сразу, а несуществующий путь даёт предупреждение и откат к поиску.
- `RATE_LIMITED` и `retryAfterMs` из событий V2: короткий лимит пережидается, длинный сразу возвращает ошибку с временем повтора.
- Джиттер retry (`retry.jitter`), устойчивый декодер (`properties`, delta-текст), диагностика `opencode-v2-compat`.
- 81 тест, включая новый `test/compat.test.mjs` (в 1.3.0 — уже 149).

## Что дальше (идеи фич)

Оставшиеся направления (в 1.3.0 — артефакты, консенсус, smart-experts, фолбэк моделей, `--max-cost` и `--session`; в 1.4.0 — отчёты, варианты моделей, `watch`, git-hooks и нативный V2-плагин):

| Идея | Зачем | Сложность |
| --- | --- | --- |
| Slash-команда `consilium` для TUI | Вызов совета одной командой внутри OpenCode | S |
| Экспорт отчёта в тикет-системы | Готовый артефакт для Jira/Linear | S |

## Изменения 1.4.0

- Отчёты: `--report html|pr|markdown`, `--report-file <путь>` (`.html` → html, `.md` → pr; без файла — в stdout, кроме `-f json`); `renderHtmlReport` (самодостаточный HTML с экранированием), `renderPrMarkdown` (комментарий GitHub с маркером `<!-- consilium:report -->` и `<details>`-блоками), `renderReport`.
- `--variant high`: добавляет `#high` к моделям экспертов и председателя; некорректный вариант — выход 2. Ключ конфига `variant`.
- `consilium watch [--debounce <мс>] [задача]`: следит за проектом (игнорирует `.git`/`node_modules`/`dist`/`.consilium`/`coverage`/`*.tmp`/`*.log`), ждёт паузу 400 мс, прикладывает `git diff`, перезапускает до Ctrl+C.
- `consilium hooks install`: пишет управляемый pre-commit блок (`# >>> consilium >>>` … `# <<< consilium <<<`), запускающий `npx -y lv24-opencode-consilium --staged -s "Ревью staged-изменений" || exit 1` при каждом `git commit`; чужое содержимое hook'а сохраняется; `uninstall` убирает только свой блок.
- Нативный плагин OpenCode V2: server part `./server` → `dist/plugin.js`, регистрация `{"plugins": [{"package": "lv24-opencode-consilium"}]}`, инструмент `consilium.run` (task, experts, chair, timeout_ms, consensus, smart_experts, max_cost, fallback_models, session, artifacts, preset). Рантайм-зависимостей нет: `@opencode/plugin` нужен только для типов. Только V2, в V1 не работает.
- `--replay <id>` восстанавливает агента/модель председателя, модели экспертов и флаги consensus/smartExperts/fallbackModels/session артефакта (раньше — только модели).
- Новые ключи конфига: `report`, `reportFile`, `variant`, `debounceMs` (схема обновлена).
- 224 теста; совместимость с OpenCode V1/V2 без изменений.

## Изменения 1.3.0

- Артефакты запусков: `--artifacts` / `--artifacts-dir <путь>` / `--no-artifacts` сохраняют запуск в `.consilium/runs/<id>/` (`run.json`, `report.md`, `experts/<агент>.md`); `consilium --replay <id>` повторяет сохранённый запуск, `consilium --diff-runs <a> <b>` печатает markdown-сравнение.
- `--consensus` / `--no-consensus`: лексический анализ согласия (Jaccard, RU+EN стоп-слова); сводка — в промпт председателя, полный отчёт — в результат и `metadata.consensus`.
- `--smart-experts`: эвристический выбор 2–3 ролей под задачу/дифф (максимум 3, отброшенные логируются); результат — в `metadata.smartExperts`.
- `--max-cost <usd>`: трекер стоимости; при превышении до старта председатель не запускается (`errorCode: COST_LIMIT`, частичный результат с консенсусом); детали — в `metadata.cost`.
- `--fallback-models a,b`: повтор того же эксперта на запасной модели при `RATE_LIMITED` / `MODEL_UNAVAILABLE` / `EMPTY_RESPONSE` (цепочка до 2, usage суммируется).
- `--session <id>`: председатель продолжает базовую сессию, у каждого эксперта своя `ses_<base>-<агент>`; неизвестные агенты запускаются на default-агенте с `ses_<base>-default-<агент>`.
- MCP `consilium_run`: новые аргументы `consensus`, `smart_experts`, `max_cost`, `fallback_models`, `session`, `artifacts`; в ответе — `cost`, сводка консенсуса и строка `**Artifacts:**`.
- Новые ключи конфига: `artifacts`, `consensus`, `smartExperts`, `maxCost`, `fallbackModels`, `session` (схема обновлена).
- 149 тестов; совместимость с OpenCode V1/V2 без изменений.

## Лицензия

MIT
