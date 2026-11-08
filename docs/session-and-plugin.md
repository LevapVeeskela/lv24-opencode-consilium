# Сессии `opencode run` и нативный V2-плагин Consilium

> **Статус на 1.4.0:** рекомендации этого документа реализованы в `src/plugin.ts`,
> но с двумя отличиями: `Plugin.define` в `@opencode/plugin@2.2.6` — identity-функция
> на рантайме, поэтому плагин экспортирует типизированный объект `{ id, setup }`
> и импортирует `@opencode/plugin` только как тип; рабочая директория берётся из
> `ctx.location.directory`, а не из `process.cwd()`. Рантайм-зависимостей у пакета
> нет, `@opencode/plugin` остаётся devDependency (не `dependencies`/`peerDependencies`).
> Разделы 5–6 ниже — исходное исследование и чек-лист; актуальная реализация в
> `src/plugin.ts`, `src/tool-run.ts`, `package.json` (`exports["./server"]`).

Рабочий пакет WP5. Только исследование и документация: исходники проекта не менялись.

Окружение проверки:

| Параметр | Значение |
|---|---|
| OpenCode | **v2.2.6** (`opencode --version`) |
| ОС / оболочка | Windows, PowerShell 5.1 |
| Проект | `C:\0project\opencode-consilium` |
| Модель прогонов | `opencode-go/muse-spark-1.3-contributor` (стоимость прогонов `cost: 0`) |
| Документация | `https://opencode.ai/docs/...`, переключатель **V2 (latest)** |
| Хранилище сессий | `C:\Users\<user>\.local\share\opencode\opencode.db` (SQLite, наблюдалось) |

Все идентификаторы сессий ниже сокращены: `ses_e46f6d52…AqTXO`.

---

## 1. `opencode run`: фактическая семантика флагов

`opencode run --help` на v2.2.6 (дословно, значимые строки):

```text
FLAGS
  --continue, -c            Continue the last session
  --session, -s string      Session ID to continue, or to create if it does not exist
  --fork                    Fork the session before continuing
  --worktree, -w [=name]    Start a new session in a new git worktree, optionally with this name
  --format choice           Output format (choices: default, json)
  --title string            Session title
  --archived                Create the session archived so it stays out of session lists (useful for scripted or CI runs)
```

`opencode session --help` на v2.2.6 — подкоманд архивации нет:

```text
SUBCOMMANDS
  list      List top-level sessions in the current project, newest first
  delete    Delete a session and its child sessions
  export    Export session data as JSON
  import    Import session data from a JSON file or URL
```

`opencode session list --help`: `--max-count, -n` (по умолчанию 100), `--format` = `table | json`.
Флага «показать архивные» нет.

### Сводка

| Флаг | Что делает (проверено) |
|---|---|
| `--session <id>` | Продолжает сессию, **если она есть**, и **создаёт с ровно этим id**, если её нет |
| `--format json` | NDJSON-поток событий; `sessionID` есть в каждом событии (и в корне, и в `part`) |
| `--fork` | Создаёт **новую** сессию-копию перед продолжением; заголовок получает суффикс `(fork #N)`, контекст родителя переносится |
| `--archived` | Ставит `time.archived` в записи сессии, **но `opencode session list` её всё равно показывает** |
| `--continue` | «Последняя сессия» — не исполнялось (машинно-зависимо, для автоматизации не рекомендуется) |
| `--worktree` | Не исполнялось: создаёт git worktree (побочный эффект в репозитории) |

---

## 2. Эмпирические прогоны

### T1. Создание сессии обычным запуском

```powershell
opencode run --format json -m opencode-go/muse-spark-1.3-contributor `
  --title 'WP5 probe' 'Reply with exactly: OK'
```

Наблюдаемый вывод (3 строки NDJSON, сокращено):

```text
{"type":"step_start","sessionID":"ses_e46f6d52…AqTXO", ...}
{"type":"text","sessionID":"ses_e46f6d52…AqTXO","part":{"type":"text","text":"OK", ...}}
{"type":"step_finish","sessionID":"ses_e46f6d52…AqTXO","part":{...,"cost":0,
  "tokens":{"input":16226,"output":10,"reasoning":7,"cache":{"read":1521,"write":0}}}}
```

Вывод: `--format json` — поток отдельных JSON-объектов (не один документ); `sessionID` доступен уже в первом событии;
`step_finish.part.tokens` и `part.cost` дают расход по шагу.

### T2. Продолжение той же сессии — контекст сохраняется

```powershell
opencode run --format json -m opencode-go/muse-spark-1.3-contributor `
  --session ses_e46f6d52…AqTXO 'What did I ask you to reply before? One word.'
```

Наблюдаемый вывод:

```text
{"type":"text","sessionID":"ses_e46f6d52…AqTXO","part":{"type":"text","text":"OK", ...}}
{"type":"step_finish","sessionID":"ses_e46f6d52…AqTXO","part":{...,"cost":0,
  "tokens":{"input":134,"output":10,"reasoning":141,"cache":{"read":17649,"write":0}}}}
```

Вывод: модель ответила `OK`, то есть предыдущая инструкция была в контексте. `sessionID` в JSON тот же;
`cache.read = 17649` — провайдер переиспользовал префикс промпта (экономия денег, но **не** контекстного окна).

### T3. Создание сессии с заданным id

```powershell
opencode run --format json -m opencode-go/muse-spark-1.3-contributor `
  --session ses_0000000000000000000000000 --title 'WP5 create-by-id' 'Reply with exactly: NEWID'
```

Наблюдаемый вывод:

```text
{"type":"step_start","sessionID":"ses_0000000000000000000000000", ...}
{"type":"text","sessionID":"ses_0000000000000000000000000","part":{"type":"text","text":"NEWID", ...}}
```

Вывод: id создаётся **ровно таким**, каким передан (`ses_` + цифры принят). Это позволяет Consilium держать
детерминированные id на проект/эксперта, не парся ответ.

### T4. `--fork` — новая сессия, контекст скопирован

```powershell
opencode run --format json -m opencode-go/muse-spark-1.3-contributor `
  --session ses_e46f6d52…AqTXO --fork --title 'WP5 fork probe' `
  'What did I ask you to reply before? One word.'
```

Наблюдаемый вывод:

```text
{"type":"step_start","sessionID":"ses_e46f3f2b…xuU9R", ...}      # НОВЫЙ id
{"type":"text","sessionID":"ses_e46f3f2b…xuU9R","part":{"type":"text","text":"OK", ...}}
```

В `opencode session list`: `ses_e46f3f2b…xuU9R  WP5 probe (fork #1)`.
Вывод: `--fork` не продолжает родителя, а клонирует его в новую сессию (заголовок `(fork #1)`) и уже там отвечает;
контекст родителя перенесён. Исходная сессия не меняется.

### T5. `--archived` — архивность ставится, но из списка не убирает

```powershell
opencode run --format json -m opencode-go/muse-spark-1.3-contributor `
  --archived --title 'WP5 archived probe 2' 'Reply with exactly: A2'
```

`opencode session export <id>` показывает, что флаг сработал:

```json
"time": {
  "created": 1794105937241,
  "updated": 1794105939080,
  "busy": 1794105937306,
  "idle": 1794105939085,
  "archived": 1794105937257
}
```

Но `opencode session list` сразу после создания — и повторно, на второй архивной сессии (`WP5 archived probe`), —
содержит обе архивные сессии, и в `table`, и в `json`:

```text
ses_e46f3f2b…WfK   WP5 archived probe 2        08.11.2026, 05:45:39
ses_e46f6754…Qju   WP5 archived probe          08.11.2026, 05:42:54
```

Вывод: на v2.2.6 `--archived` **не гарантирует** «stays out of session lists» для CLI. Скрывает ли их TUI —
не проверялось. Для чистой истории остаётся `opencode session delete <id>` или детерминированные id.

### T6. Конкурентные запуски на одной сессии — потеря запроса

Два параллельных процесса с **одной** сессией:

```powershell
opencode run ... --session ses_1111111111111111111111111 'Reply with exactly: C1'
opencode run ... --session ses_1111111111111111111111111 'Reply with exactly: C2'
```

Оба процесса вернули **побайтово одинаковый** поток, включая один и тот же `messageID` `msg_1b90d509d…` и текст `C2`:

```text
{"type":"text","sessionID":"ses_1111111111111111111111111","part":{"type":"text","text":"C2", ...}}
{"type":"step_finish",...,"tokens":{"input":17758,"output":11,"reasoning":164,"cache":{"read":0,"write":0}}}
```

Вывод: одна сессия = **один писатель**. Второй процесс примкнул к уже выполняющемуся ходу; промпт `C1` не был
обработан как отдельный ход. Параллельные эксперты Consilium не должны делить сессию.

---

## 3. Рекомендация для Consilium: `--session`

### 3.1. Текущее состояние кода (проверено чтением)

| Место | Факт |
|---|---|
| `src/types.ts:208` | `ConsiliumConfig.session?: string` — «Переиспользовать сессию OpenCode» |
| `src/types.ts:253` | `RunOptions.session?: string` |
| `src/cli.ts:222` | CLI принимает `--session` |
| `src/agents.ts:295-329` | `buildRunArgs` умеет `--session=<id>` с проверкой `SESSION_PATTERN` |
| `src/agents.ts:692-696` | `runAgentProcess` **не передаёт** `session` в `buildRunArgs` |
| `src/stream.ts` | `sessionID` из событий не извлекается |

То есть опция объявлена, но **не подключена**: сейчас `--session` до `opencode run` не доходит.

### 3.2. Точный маппинг флагов

| Опция Consilium | Аргумент CLI | Когда использовать |
|---|---|---|
| `session: <id>` | `--session=<id>` | Явное продолжение существующей сессии |
| `session: 'auto'` (новая политика) | без флага, затем взять `sessionID` из первого события | Значение по умолчанию: новая сессия на запуск |
| `forkSession: true` | `--fork` (вместе с `--session`) | Ветвление уже накопленного контекста |
| `archiveSession: true` | `--archived` | Только как пометка в данных; **не** скрывает из `session list` |
| `standalone: true` (уже дефолт) | `--standalone` (`agents.ts:303-305`) | Обязательно сохранить: плагин работает внутри сервера OpenCode, а дочерние прогоны не должны в него переиспользовать |
| `title: <строка>` | `--title "consilium: <preset>: <короткая задача>"` | Навигация в списке сессий |

Формат id: `ses_` + `[a-z0-9]` (проверено на цифровом id). Не использовать `:` `/` `#` в самостоятельно
сгенерированных id, даже если `SESSION_PATTERN` их допускает: поведение CLI/TUI для них не проверялось.

### 3.3. Политика: новая сессия на запуск, переиспользование — opt-in

**По умолчанию** — новая сессия на каждый `run()`:

* контекст не растёт между запусками (см. 3.4);
* нет конфликтов между параллельными экспертами (T6);
* `sessionID` фиксируется из первого события и пишется в `ConsiliumResult.metadata.sessionID` — этого достаточно,
  чтобы потом явно продолжить (`--session <id>`).

**Opt-in переиспользование** — только **per-expert**, не общая сессия:

```text
ses_consilium_<projectSlug>_<expert>     # у каждого эксперта своя нить
ses_consilium_<projectSlug>_chair        # у председателя своя
```

Почему per-expert: эксперты запускаются параллельно (`callExpertsParallel`), а параллельный запуск на одной сессии
теряет часть промптов (T6). Отдельные id полностью снимают конфликт и дают каждому эксперту собственный
накопленный контекст между раундами.

Продолжение «как было» — через `--fork`, если нужно ответвление без порчи основной нити (T4).

### 3.4. Ловушки

1. **Рост контекста.** Первый ход «Reply with exactly: OK» — `input 16226`; второй ход в той же сессии —
   `input 134 + cache.read 17649`. То есть промпт вырос примерно на 1.5k токенов при ответе в два токена.
   В реальном Consilium каждый ход добавляет промпт эксперта + ответ; при переиспользовании рост линейный и
   упирается в контекстное окно дешёвых моделей. Кэш удешевляет токены, но окно не расширяет.
2. **Архивные сессии не скрываются** из `opencode session list` (T5). Не строить на `--archived` гарантий
   «чистого» списка; для уборки — `opencode session delete`.
3. **Конкурентность.** Одна сессия — один писатель (T6). Никогда не передавать общий `--session` параллельным
   экспертам.
4. **`--continue`** продолжает «последнюю» сессию и в автоматизации опасен: зависит от того, что делал пользователь.
5. **Сессии привязаны к проекту.** `session list` — «in the current project»; в записи есть `directory`
   (наблюдалось `"directory":"C:\\0project\\opencode-consilium"`). При запуске из другого каталога id не найдётся.
6. **Плагин внутри сервера.** Инструмент плагина выполняется в процессе сервера OpenCode. Нельзя использовать
   `sessionID` вызывающей сессии (`ToolContext.sessionID`) для прогонов совета: ответы совета смешаются с ходом
   агента-вызывающего. Только `--standalone` + отдельные id.
7. **`--worktree`** создаёт git worktree — в автоматическом прогоне это побочный эффект в рабочем дереве.

---

## 4. V2 plugin API (по документации)

Источники: `https://opencode.ai/docs/build/plugins`, `.../plugins/server`, `.../plugins/migrate-v1`,
`https://opencode.ai/docs/mcp-servers`, схема `https://opencode.ai/config.json`.

### 4.1. Минимальная форма

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    await ctx.storage.set("loaded", true)
  },
})
```

Цитата (Overview): «A plugin is one package with a server part, a TUI part, a GUI part, or any combination»;
«The plugin's id comes from its server part's `Plugin.define`».
`setup` может вернуть cleanup-функцию («runs when the plugin unloads»).

### 4.2. Пакет и точки входа (parts)

```jsonc
{
  "name": "opencode-acme-plugin",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./server": "./src/server.ts",
    "./tui": "./src/tui.tsx",
    "./rpc": "./src/rpc.ts"
  },
  "files": ["src", "dist"],
  "dependencies": { "@opencode/plugin": "latest" }
}
```

* Server part — `.` **или** `./server`; TUI — `./tui`; GUI — `./gui-experimental`; RPC — `./rpc`.
* «One entry loads every part.»
* Локальный каталог без `package.json`/`exports` грузит файлы по именам в корне: `server` (иначе `index`), `tui`, `rpc`.

### 4.3. Подключение в конфиге

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "opencode-acme-plugin",
    "opencode-acme-plugin@1.2.0",
    "./plugins/local",
    "/absolute/path/plugin",
    "file:///home/me/plugins/local",
    {
      "package": "@acme/opencode-plugin",
      "options": { "agent": "reviewer", "strict": true }
    }
  ]
}
```

Схема конфига v2 подтверждает: `plugins` — массив `string | { package: string; options?: object }`
(`additionalProperties: false`). Плагины из `.opencode/plugins/` подхватываются автоматически.
Значения опций доступны в `ctx.options: Readonly<Record<string, any>>`.

**Важно (V2):** «Configured local paths must name directories… a configured `./plugin/local.ts` file is skipped
with a warning in the log.» То есть в `plugins` указывается каталог, а не `.ts`-файл.

### 4.4. Кастомные инструменты

Регистрация — синхронный transform в `setup`:

```ts
await ctx.tool.transform((editor) => {
  editor.namespace({ name: "acme", description: "Customer account tools" })
  editor.add({
    name: "greeting",
    description: "Create a greeting",
    input: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    options: { namespace: "acme", codemode: true },
    async execute(input, context) {
      await context.progress({ status: "greeting" })
      return { content: `Hello ${(input as { name: string }).name}!` }
    },
  })
})
```

Факты из документации и типов `@opencode/plugin@2.2.6`:

* `input` — JSON Schema (тип `Tool.ValueSchema`: `JsonSchema | Effect Schema | StandardSchemaV1`);
  в `execute` приходит `unknown`, валидация — на стороне плагина.
* `execute(input, context)` возвращает `Tool.Result`: `{ content?: string | Content[]; metadata?; output? }`.
  `context` содержит `signal: AbortSignal` и `progress(update) => Promise<void>`.
* Эффективное имя инструмента = `namespace` + `_` + `name`; точки и недопустимые символы заменяются на `_`:
  `namespace: "acme"` + `name: "greeting"` → `acme_greeting`.
* `options: { codemode: true }` кладёт инструмент в Code Mode (группировка по namespace, как у MCP):
  ожидаемо `tools.acme.greeting(...)`. Для MCP это документировано явно
  (`tools.<server>.<tool>`); для плагинов тот же namespace+codemode показан в примере — точное имя в Code Mode
  стоит проверить при первом запуске.
* `editor.update(id, ...)` / `editor.remove(id)` работают по эффективному имени; `transform` возвращает
  `Registration` с `dispose()`; `ctx.tool.reload()` переигрывает transforms, не перезапуская `setup`.
* Трансформация «replayable»: колбэк синхронный, дешёвый, без одноразовых побочных эффектов; внешние данные
  загружать **до** регистрации и захватывать в замыкании.

### 4.5. Хуки

В V2 хуки регистрируются на домене, владеющем операцией, и получают один мутируемый объект события:

```ts
await ctx.tool.hook("execute.before", (event) => { /* event.tool, event.input */ })
await ctx.shell.hook("create.before", (event) => { event.env.COMPANY_ENV = "development" })
```

Карта миграции V1→V2 (из `migrate-v1`): `event → ctx.event.subscribe()`, `dispose → cleanup из setup`,
`config/tool map → domain transform`, `tool.execute.before → ctx.tool.hook("execute.before")`,
`shell.env → ctx.shell.hook("create.before")`, `chat.params → ctx.session.hook("context")` и т.д.

### 4.6. V1 vs V2

| | V1 | V2 (v2.2.6) |
|---|---|---|
| Пакет | `@opencode-ai/plugin` | `@opencode/plugin` |
| Экспорт | функция `async ({ directory, project, client }) => ({ tool, ...hooks })` | `export default Plugin.define({ id, setup(ctx) })` |
| Ключ конфига | `plugin` + кортеж `[path, options]` | `plugins` + `{ package, options }` |
| Инструменты | `tool()`-хелпер, `args: { ... }` | `ctx.tool.transform` + JSON Schema, `execute → { content }` |
| Локальный путь | мог быть файлом | **только каталог** |

Цитата: «**V1 plugin implementations do not run in V2.** Moving a file or renaming its config entry is not enough.»
И обратное: «V1 calls `server()`… V2 reads the default export's `id` and `setup()`… ignoring `server()`».

---

## 5. Дизайн нативного V2-плагина: `src/plugin.ts`

### 5.1. Идея

Один инструмент `consilium_run`, который вызывает **существующую библиотеку** (`Consilium` из `src/index.ts`),
без вызова собственного CLI (`bin/cli.js`) и без дублирования логики MCP. Плагин — тонкий адаптер:
валидация входа → вызов use-case → форматирование `Tool.Result`. (Сама библиотека по-прежнему запускает
`opencode run` для экспертов — это её штатная работа.)

Чтобы не дублировать `src/mcp.ts` (`toolConsiliumRun`, строки 472-566), общую часть вынести в
`src/tool-run.ts` (application-слой) и использовать из обоих адаптеров:

```ts
// src/tool-run.ts — общий use-case (новый файл, позже)
export interface ToolRunHooks {
  progress?: (update: { status: string; progress?: number; total?: number }) => Promise<void> | void
  signal?: AbortSignal
}
export async function runConsiliumTool(
  args: Record<string, unknown>,
  hooks: ToolRunHooks = {}
): Promise<{ text: string; metadata: Record<string, unknown>; isError: boolean }>
```

Тогда `src/mcp.ts` и `src/plugin.ts` — только транспорты (JSON-RPC / V2 tool), а правила (`task` обязателен,
`output_file` внутри workspace, пресеты, таймауты) живут в одном месте.

### 5.2. Точка входа

```ts
// src/plugin.ts (новый файл)
import { Plugin } from "@opencode/plugin"
import { runConsiliumTool } from "./tool-run.js"

export default Plugin.define({
  id: "consilium",
  async setup(ctx) {
    const options = ctx.options as {
      configPath?: string
      defaultPreset?: "fast" | "deep" | "security" | "review" | "free"
      standalone?: boolean
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "consilium", description: "Expert council tools" })
      editor.add({
        name: "run",
        description:
          "Run a council of expert AI agents through the OpenCode CLI. " +
          "Experts analyze the task in parallel and the chair synthesizes the final answer.",
        input: {
          type: "object",
          properties: {
            task: { type: "string", minLength: 1, description: "Task for the expert council." },
            experts: { type: "array", items: { type: "string" } },
            chair: { type: "string" },
            preset: { type: "string", enum: ["fast", "deep", "security", "review", "free"] },
            timeout_ms: { type: "number", exclusiveMinimum: 0 },
            session: {
              type: "string",
              description:
                "OpenCode session id to continue. Omit to start a fresh session per run (recommended).",
            },
            fork: { type: "boolean", description: "Fork the given session before continuing." },
          },
          required: ["task"],
          additionalProperties: false,
        },
        options: { namespace: "consilium", codemode: true },
        async execute(input, context) {
          const result = await runConsiliumTool(input as Record<string, unknown>, {
            // runConsiliumTool подписывается на signal и вызывает consilium.cancel()
            signal: context.signal,
            progress: (update) => context.progress(update),
          })
          if (result.isError) throw new Error(result.text)
          return { content: result.text, metadata: result.metadata }
        },
      })
    })
  },
})
```

Замечания по реализации:

* `setup` остаётся дешёвым: колбэк `ctx.tool.transform` синхронный, поэтому `Consilium` создаётся внутри
  `execute`, а не в `setup`.
* `input` приходит как `unknown` — валидировать теми же хелперами, что в `mcp.ts`
  (`requireNonEmptyString`, `optionalStringArray`, `optionalEnum`, `resolveOutputFile`).
* `context.signal` → `Consilium.cancel()` (`src/index.ts`), чтобы остановка хода останавливала и совет.
* `ctx.location.directory` — рабочая директория проекта: передавать как `cwd` конфига, а не полагаться на
  `process.cwd()` сервера.
* `ctx.options.standalone` пробрасывать в `ConsiliumConfig.standalone` (по умолчанию `true`): дочерние прогоны
  не должны подключаться к серверу, внутри которого живёт плагин.

### 5.3. Экспорт пакета

`package.json` (изменения — позже, не в этом WP):

```jsonc
{
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./server": { "types": "./dist/plugin.d.ts", "import": "./dist/plugin.js" },
    "./config": "./dist/config.js",
    "./mcp": "./dist/mcp.js"
  },
  "dependencies": {
    "@opencode/plugin": "^2.2.6"
  }
}
```

* Server part публикуется как `./server` — это документированное имя части; корень (`.`) уже занят библиотекой.
* `@opencode/plugin` должен быть `dependency` (как в документации: `"dependencies": { "@opencode/plugin": "latest" }`);
  версия должна соответствовать целевому OpenCode. Для v2.2.6 актуальна `2.2.6`.
* У пакета `@opencode/plugin@2.2.6` тяжёлые транзитивные зависимости (`effect`, `@opencode/ai`, `@opencode/client`,
  `@opencode/schema`, `@opencode/protocol`). Если размер установки критичен — проверить `peerDependencies`-вариант
  отдельным экспериментом (в доках он не описан).

### 5.4. Конфиг

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "lv24-opencode-consilium",
      "options": {
        "configPath": "consilium.config.json",
        "defaultPreset": "review",
        "standalone": true
      }
    }
  ]
}
```

Локальная разработка без публикации — каталог, не файл:

```jsonc
{ "plugins": [{ "package": "./plugin", "options": {} }] }
```

```text
plugin/
  index.ts        # export { default } from "../dist/plugin.js"
```

(Либо `.opencode/plugins/consilium/index.ts` — такой каталог подхватывается автоматически.)

### 5.5. Почему только V2

1. Реализация V1 **не исполняется** в V2 (цитата из `migrate-v1`), а V2-объект `{ id, setup }` не является
   функцией, которую ждёт V1.
2. Ключ конфига и формат записи различаются (`plugin` + кортеж против `plugins` + объект), автоматическая
   нормализация покрывает конфиг, но не код.
3. Используемые API — `Plugin.define`, `ctx.tool.transform`, `options.codemode`/`namespace`, `ctx.options`,
   `ToolContext.signal` — существуют только в V2.
4. Целевая версия зафиксирована: установленный OpenCode — v2.2.6.

Если позже понадобится V1, документация даёт безопасный способ: экспортировать объект, развернув `Plugin.define`
и добавив `server()`:

```ts
export default {
  ...Plugin.define({ id: "consilium", setup }),
  async server() {
    return { /* V1 hooks */ }
  },
}
```

V1 вызовет `server()`, V2 прочитает `id`/`setup` и проигнорирует `server()`.

---

## 6. Чек-лист интеграции (файлы, которые надо будет менять)

Ничего из перечисленного в этом WP не изменялось.

| Файл | Изменение | Зачем |
|---|---|---|
| `package.json` | `exports["./server"]` → `dist/plugin.js`; `dependencies["@opencode/plugin"] = "^2.2.6"` | Публикация server part и `Plugin.define` |
| `src/plugin.ts` | **новый**: `Plugin.define({ id: "consilium" })`, инструмент `consilium_run` | Нативный вход для OpenCode v2 |
| `src/tool-run.ts` | **новый**: общий use-case `runConsiliumTool(args, hooks)` | Убрать дублирование между `mcp.ts` и `plugin.ts` |
| `src/mcp.ts` | `toolConsiliumRun` → вызов `runConsiliumTool` | Один источник валидации и форматирования |
| `src/agents.ts` | `runAgentProcess` (строки 692-696): прокинуть `session`/`fork` в `buildRunArgs` | Опция `session` сейчас мертва |
| `src/stream.ts` | добавить `sessionID` в `ParsedStream` (есть в каждом событии) | Возвращать id созданной сессии |
| `src/index.ts` | `RunOptions.session` → эксперты/председатель; писать `metadata.sessionID` | Управляемое переиспользование и трассировка |
| `src/types.ts` | `ConsiliumPluginOptions` (configPath, defaultPreset, standalone), `forkSession?: boolean` | Типы для `ctx.options` и новых опций |
| `schema/config.schema.json` | добавить `session` (сейчас поля нет), `forkSession` | Схема отстаёт от `types.ts` |
| `opencode.json` | блок `plugins` (dogfood) — только после публикации или через `./plugin` | Проверка «в бою» |
| `test/plugin.test.mjs` | **новый**: валидация входа инструмента, маппинг аргументов, отмена по `signal` | Регрессии |
| `README.md`, `README.ru.md`, `README.zh.md`, `docs/*` | раздел «Плагин OpenCode v2» с примером `plugins` | Пользовательская документация |
| `bin/cli.js`, `bin/mcp.js` | без изменений | Точки входа CLI/MCP не затрагиваются |

Порядок безопасного включения:

1. `src/tool-run.ts` + рефакторинг `mcp.ts` (поведение MCP не меняется, тесты `test/mcp.test.mjs` зелёные).
2. `src/plugin.ts` + `exports["./server"]` + зависимость.
3. Локальная проверка: `plugin/index.ts` → `.opencode/plugins/consilium/index.ts`, запуск `opencode` в репозитории,
   проверка, что инструмент виден и `consilium_run` отвечает.
4. Только потом — `plugins` в `opencode.json` и публикация.

---

## 7. Что осталось непроверенным

| Пункт | Статус |
|---|---|
| Фактическая загрузка плагина в v2.2.6 | Не проверялось (нужен локальный `plugins`-конфиг; в этом WP запрещены правки конфигов) |
| Точное имя инструмента в Code Mode (`tools.consilium.run`) | Выведено из документации и примера; проверить при первом запуске |
| `--worktree` | Не исполнялось: создаёт git worktree |
| `--continue` | Не исполнялось: зависит от «последней» сессии пользователя |
| Скрывает ли TUI архивные сессии | Неизвестно; CLI-список их показывает |
| Поведение `@opencode/plugin` как `peerDependency` | В доках описан только `dependencies` |
| Поведение нестандартных символов в самостоятельно заданном `session` id | Проверен только цифровой суффикс |

---

## 8. Источники

* `https://opencode.ai/docs/build/plugins` — обзор, parts, `exports`, загрузка, публикация.
* `https://opencode.ai/docs/build/plugins/server` — `Plugin.define`, `ctx.options`, `ctx.tool.transform`,
  `ToolEditor`, хуки, `Support V1`.
* `https://opencode.ai/docs/build/plugins/migrate-v1` — «V1 plugin implementations do not run in V2»,
  `plugin` → `plugins`, таблица соответствия хуков, миграция инструментов.
* `https://opencode.ai/docs/mcp-servers` — `mcp.servers`, `codemode` (по умолчанию `true`), имена
  `<server>_<tool>` и `tools.<server>.<tool>`.
* `https://opencode.ai/config.json` — `plugins: Array<string | { package, options }>`, наличие legacy `plugin`.
* Типы `@opencode/plugin@2.2.6` (`dist/promise/plugin.d.ts`, `dist/promise/tool.d.ts`) и
  `@opencode/schema@2.2.6` (`dist/tool.d.ts`): `Context`, `Tool.Info`, `Tool.Options`, `Tool.Result`, `ToolContext`.
* Собственные прогоны `opencode` v2.2.6 в `C:\0project\opencode-consilium` (T1-T6).
