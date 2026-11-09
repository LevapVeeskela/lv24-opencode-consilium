/**
 * @fileoverview Справка CLI consilium
 * @module lv24-opencode-consilium/cli/help
 */

export function printHelp(): void {
  console.log(`
consilium - Консилиум ИИ-экспертов через OpenCode CLI

ИСПОЛЬЗОВАНИЕ:
  consilium [опции] <задача>
  consilium <задача> -              задача читается из stdin
  consilium init [--free]
  consilium models [--available] [--json] [--reliability]
  consilium doctor
  consilium mcp
  consilium eval [--fixtures <dir>] [--json] [--fail-under <pct>] [--max-cost <usd>]
  consilium baseline accept <runId|latest> [--dry-run]
  consilium baseline prune [--older-than <дни>] [--all] [--yes] [--dry-run]

КОДЫ ВЫХОДА:
  0 — успех; 1 — запуск не удался; 2 — ошибка использования;
  3 — сработала политика --fail-on (находки не ниже порога)
      или catch rate eval ниже --fail-under

ОСНОВНЫЕ ОПЦИИ:
  -h, --help              Показать эту справку
  -v, --version           Показать версию
  -V, --verbose           Подробный вывод
  -s, --silent            Тихий режим (только результат)

  -c, --config <файл>     Путь к файлу конфигурации
  -e, --experts <список>  Эксперты через запятую (arch,ux,ba,sec)
  --chair <агент>         Агент-председатель
  --preset <имя>          Пресет: fast, deep, security, review, free

  --expert-timeout <мс>   Таймаут экспертов (по умолчанию: 300000)
  --chair-timeout <мс>    Таймаут председателя (по умолчанию: 600000)
  -r, --retries <число>   Повторные попытки

  -o, --output <файл>     Сохранить результат в файл
  -f, --format <формат>   Формат: text, markdown, json (json — чистый JSON в stdout)
  --no-save               Не сохранять результат
  --verify                (models/init) Проверить модели реальным запросом
  --no-verify             (init) Не проверять модели (быстрее)

  --diff                  Добавить git diff текущих изменений к задаче
  --staged                Использовать staged-изменения
  --base <ref>            Сравнить с веткой/коммитом
  --task-file <файл>      Прочитать задачу из файла
  --context <off|auto>    Автосбор контекста проекта (файлы, правила, тесты);
                          по умолчанию off (поведение не меняется)

АНАЛИЗ И АРТЕФАКТЫ:
  --consensus             Анализ согласия экспертов (в промпт председателя и отчёт)
  --no-consensus          Отключить анализ согласия
  --findings              Структурированные находки экспертов и председателя в metadata.findings
  --no-findings           Отключить структурированные находки
  --fail-on <уровень>     Код 3, если после baseline остались находки >= уровня:
                          critical, high, medium, low, info, none (по умолчанию none)
  --smart-experts         Выбрать 2–3 релевантных эксперта по задаче/диффу
  --max-cost <usd>        Лимит стоимости; при превышении председатель не запускается
  --fallback-models a,b   Запасные модели при RATE_LIMITED/MODEL_UNAVAILABLE/EMPTY_RESPONSE
  --session <id>          Продолжить сессию председателя; эксперты получают свои сессии
  --artifacts             Сохранить запуск в .consilium/runs
  --artifacts-dir <путь>  Сохранить артефакты в указанный каталог
  --no-artifacts          Не сохранять артефакты
  --replay <id>           Повторить сохранённый запуск
  --diff-runs <a> <b>     Сравнить два артефакта
  --report <формат>       Отчёт после запуска: html, pr, markdown
  --report-file <файл>    Записать отчёт в файл (по умолчанию stdout)
  --variant <имя>         Вариант для моделей без #variant (существующий сохраняется)

РЕЖИМ НАБЛЮДЕНИЯ:
  watch [--debounce <мс>] [задача]
                          Перезапускать консилиум при изменениях в проекте
  hooks install|uninstall Установить/удалить git pre-commit hook

КОМАНДЫ:
  init [--free] [--force] [--dry-run] [--native-v2]
                          Создать конфиг; --free — подобрать и проверить сильнейшие бесплатные модели
  models [--available] [--verify] [--limit N] [--refresh] [--json] [--reliability]
                          Рейтинг бесплатных моделей (models.dev + OpenRouter)
                          --reliability — статистика .consilium/reliability.json
  doctor                  Проверить окружение, конфиг, агентов и модели
  mcp [--install] [--global]
                          Запустить MCP-сервер (stdio) или зарегистрировать его в opencode.json
  eval [--fixtures <dir>] [--json] [--fail-under <pct>] [--max-cost <usd>]
                          Прогнать eval-фикстуры (по умолчанию eval/fixtures);
                          --fail-under — код 3, если catch rate ниже порога
  baseline accept <runId|latest> [--dry-run]
                          Принять находки запуска в .consilium/baseline.json
  baseline prune [--older-than <дни>] [--all] [--yes] [--dry-run]
                          Удалить старые записи baseline (по умолчанию старше 90 дней)

СОВМЕСТИМОСТЬ:
  Работает с OpenCode V1 и V2. Формат opencode.json определяется автоматически:
  V1-формат (agent/prompt) читают обе версии, нативный V2 (agents/system)
  пишется только по флагу --native-v2.

БЕСПЛАТНЫЕ МОДЕЛИ:
  consilium init --free
    Скачивает каталог моделей, выбирает сильнейшие бесплатные с поддержкой tools
    и прописывает их в opencode.json и consilium.config.json.
    --refresh — обновить кэш, --dry-run — только показать план.

MCP (OpenCode V1/V2, Claude Desktop, Codex, любой MCP-харнесс):
  consilium mcp --install             # ./opencode.json → mcp.servers.consilium (V2) или mcp.consilium (V1)
  consilium mcp --install --global    # глобальный конфиг OpenCode

  Claude Desktop / Codex:
  {
    "mcpServers": {
      "consilium": {
        "command": "npx",
        "args": ["-y", "lv24-opencode-consilium", "mcp"]
      }
    }
  }

ПРИМЕРЫ:
  consilium "Оценить архитектуру проекта"
  consilium -e arch,sec "Проверить безопасность API"
  git diff | consilium - --diff "Сделай ревью изменений"
  consilium --findings --fail-on high "Проверить безопасность API"
  consilium baseline accept latest
  consilium models --available
  consilium models --reliability
  consilium eval --fail-under 80
  consilium doctor

ДОКУМЕНТАЦИЯ:
  https://github.com/LevapVeeskela/lv24-opencode-consilium
`);
}
