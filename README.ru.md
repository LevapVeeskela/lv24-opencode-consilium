# opencode-consilium

Консилиум ИИ-экспертов для [OpenCode](https://opencode.ai): несколько ролей-агентов **параллельно отвечают на разных моделях**, затем председатель синтезирует итоговый план. В комплекте — подбор сильнейших бесплатных моделей, CLI, библиотека и **MCP-сервер** для любого харнесса (Claude Desktop, Codex, Cursor, VS Code, свои агенты).

```
consilium "Оцени дизайн аутентификации"
  arch  → glm-5.3-flash-free
  ux    → mimo-v2.6-flash-free
  ba    → flint-40b-free
  sec   → nemotron-3.5-lightning-free
  chair → deepseek-v4.1-flash-free   ← синтез
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
- Установленный и авторизованный [OpenCode CLI](https://opencode.ai) (`npm install -g opencode-ai`)
- Опционально: `OPENROUTER_API_KEY` для бесплатных моделей OpenRouter

## Установка

```bash
npm install -g opencode-consilium
# или без установки:
npx -y opencode-consilium --help
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

## Бесплатные модели

```bash
consilium models                 # полный рейтинг
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

Кэш: `%TEMP%/opencode-consilium/models-cache.json` (или `CONSILIUM_MODELS_CACHE`), TTL 12 ч.

Рейтинг (0–1.3) детерминирован: контекст 30%, tools 20%, structured output 10%, reasoning 10%, свежесть 10%, лимит вывода 10%, приор семейства 10%, «теневая цена» платного аналога 15%; штрафы за alpha/preview/stealth.

## MCP-сервер (любой харнесс)

Запуск по stdio:

```bash
consilium mcp
# или напрямую:
consilium-mcp
```

Claude Desktop (`claude_desktop_config.json`):

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

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.consilium]
command = "npx"
args = ["-y", "opencode-consilium", "mcp"]
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

`consilium_init_free` по умолчанию ничего не пишет; передайте `"apply": true`. `consilium_run` шлёт прогресс, если клиент передал `progressToken`.

## Справочник CLI

```
consilium [опции] <задача>
consilium <задача> -               # задача из stdin
consilium init [--free] [--dry-run] [--force] [--no-verify]
consilium models [--available] [--verify] [--limit N] [--refresh] [--json]
consilium doctor
consilium mcp
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
| `-s, --silent` | Только итоговый результат |
| `-V, --verbose` | Сырые события прогресса |
| `-v, --version`, `-h, --help` | Версия / справка |

Коды выхода: `0` успех, `1` запуск неуспешен, `2` ошибка использования.

Примеры:

```bash
consilium -e arch,sec "Смоделируй угрозы для загрузки файлов"
consilium --preset deep "Составь план миграции"
git diff --staged | consilium - --diff "Сделай ревью изменений"
consilium -f json "..." > council.json
```

## Пресеты

| Пресет | Эксперты | Поведение |
| --- | --- | --- |
| `fast` | arch, sec | таймаут 3 мин, без повторов |
| `deep` | все четыре | удвоенные таймауты, повторы |
| `security` | sec, arch, ba | фокус на безопасность |
| `review` | arch, sec, ux | ревью кода |
| `free` | все четыре | под бесплатную конфигурацию |

## Конфигурация

Порядок поиска (cwd): `consilium.config.json`, `consilium.json`, `.consiliumrc`, `.consiliumrc.json`. Явный путь — `-c`. В `opencode.json`/`opencode.jsonc` допустимы комментарии JSONC.

Минимальный пример:

```json
{
  "experts": [
    { "name": "arch", "model": "opencode/glm-5.3-flash-free" },
    { "name": "sec",  "model": "opencode/nemotron-3.5-lightning-free" }
  ],
  "chair": {
    "agent": "consilium",
    "model": "opencode/deepseek-v4.1-flash-free"
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
| `retry.maxConcurrency` | 3 | 1–8 параллельных агентов |
| `output.file` | `false` | `false` — не сохранять; строка — включить |
| `standalone` | `true` | Приватный сервер `--standalone`; не конфликтует с запущенным OpenCode |
| `autoApprove` | `false` | `--auto`; включайте только если доверяете агентам/инструментам |
| `autoDiscoverAgents` | `true` | Брать агентов из `opencode.json` |
| `opencodePath` | `opencode` | Свой путь к CLI |
| `cwd` | текущая | Рабочая директория OpenCode |

Полная схема: [`schema/config.schema.json`](schema/config.schema.json); пример: [`consilium.config.example.json`](consilium.config.example.json).

## Библиотека

```ts
import { Consilium, runConsilium, fetchFreeModels, selectCouncilModels } from 'opencode-consilium';

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
opencode run --standalone --format json [--auto] [--agent NAME] --model provider/model
```

Промпт пишется в **stdin** (UTF-8), поэтому произвольный текст задачи безопасен и не упирается в лимиты командной строки. NDJSON-события декодируются потоково (`text`, `step_finish` с usage/cost, `error`). Коды выхода, хвост stderr и ошибки отдаются типизированными `errorCode`. Если агента нет в конфиге OpenCode, вызов повторяется один раз с той же моделью и default-агентом — консилиум работает даже без persona-агентов.

## Безопасность

- Текст задачи не попадает в shell-команду; только stdin.
- Имена агентов и id моделей валидируются.
- `--auto` (авто-подтверждение разрешений) **выключен** по умолчанию.
- `--standalone` изолирует дочерний сервер.
- Ключи API не читаются, не печатаются и не пишутся; авторизацией занимается OpenCode.
- `doctor` предупреждает об отсутствующих ключах и рискованном конфиге.

## Диагностика

| Симптом | Решение |
| --- | --- |
| `OpenCode CLI не найден` | `npm install -g opencode-ai` или `opencodePath` |
| `Model unavailable` | Модель ротирована/заблокирована; `consilium models --verify --refresh` |
| `Agent not found` | Нет persona-агента; будет default-агент + ваша модель. Создайте агентов через `consilium init --free` |
| Таймауты | Бесплатные модели бывают медленными; увеличьте `--expert-timeout` или `--preset fast` |
| 429/лимиты | Уменьшите `retry.maxConcurrency` до 1–2 |
| `Managed service port ... in use` | Оставьте `standalone: true` (по умолчанию) |
| Пустой результат | `consilium doctor`, затем запуск с `-V` |

## Разработка

```bash
npm install
npm run build       # tsc
npm test            # build + node:test (52 тестов)
npm run typecheck   # tsc --noEmit
```

## Лицензия

MIT
