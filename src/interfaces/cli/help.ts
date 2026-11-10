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
  consilium init [--free | --local]
  consilium models [--available] [--local] [--probe-local] [--json] [--reliability]
  consilium presets [--json]
  consilium doctor
  consilium mcp
  consilium eval [--fixtures <dir>] [--rounds <1|2> | --compare-rounds] [--json]
                 [--fail-under <pct>] [--max-cost <usd>]
  consilium baseline accept <runId|latest> [--dry-run]
  consilium baseline prune [--older-than <дни>] [--all] [--yes] [--dry-run]
  consilium history [--limit N] [--json]
  consilium stats [--json] [--html <файл>]
  consilium audit --since <ref> [--dry-run] [--json] [--findings|--no-findings]
                   [--fail-on <уровень>] [--max-cost <usd>]
  consilium sarif [--run <id|latest>] [--output <файл>]

КОДЫ ВЫХОДА:
  0 — успех; 1 — запуск не удался; 2 — ошибка использования;
  3 — сработала политика --fail-on (находки не ниже порога)
      или catch rate eval ниже --fail-under
      (в compare-режиме — catch rate дебатов)

ОСНОВНЫЕ ОПЦИИ:
  -h, --help              Показать эту справку
  -v, --version           Показать версию
  -V, --verbose           Подробный вывод
  -s, --silent            Тихий режим (только результат)

  -c, --config <файл>     Путь к файлу конфигурации
  -e, --experts <список>  Эксперты через запятую (arch,ux,ba,sec)
  --chair <агент>         Агент-председатель
  --preset <имя>          Пресет: fast, deep, security, review, free или свой из presets

  --expert-timeout <мс>   Таймаут экспертов (по умолчанию: 300000)
  --chair-timeout <мс>    Таймаут председателя (по умолчанию: 600000)
  --deadline <мс>         Общий дедлайн экспертной фазы (не больше 24 часов)
  --rounds <1|2>          Раундов дебатов: 1 — обычный, 2 — анонимное peer-review
                          экспертов перед председателем (run, watch, eval)
  --compare-rounds        (eval) Сравнить прогоны rounds=1 и rounds=2 на тех же
                          фикстурах; взаимоисключающе с --rounds
  --local-only            Только локальные модели (ollama/lmstudio/vllm/…);
                          завершиться с кодом 2, если модель внешняя
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
  --report <формат>       Отчёт после запуска: html, pr, markdown, sarif (SARIF 2.1.0),
                          jira (Jira wiki), linear (Linear markdown)
  --report-file <файл>    Записать отчёт в файл (по умолчанию stdout);
                          .sarif — автоматически SARIF 2.1.0,
                          .jira/.linear — Jira/Linear разметка
  --variant <имя>         Вариант для моделей без #variant (существующий сохраняется)

РЕЖИМ НАБЛЮДЕНИЯ:
  watch [--debounce <мс>] [задача]
                          Перезапускать консилиум при изменениях в проекте
  hooks install|uninstall Установить/удалить git pre-commit hook

КОМАНДЫ:
  init [--free | --local] [--force] [--dry-run] [--native-v2]
                          Создать конфиг; --free — подобрать и проверить сильнейшие бесплатные модели;
                          --local — собрать консилиум из моделей Ollama/LM Studio
                          (--free и --local взаимоисключающие)
  models [--available] [--verify] [--limit N] [--refresh] [--json] [--reliability]
         [--local] [--probe-local]
                          Рейтинг бесплатных моделей (models.dev + OpenRouter)
                          --local — только локальные провайдеры
                          --probe-local — проверить Ollama и LM Studio
                          --reliability — статистика .consilium/reliability.json
  presets [--json]        Встроенные и пользовательские пресеты из конфигурации
  doctor                  Проверить окружение, конфиг, агентов и модели
  mcp [--install] [--global]
                          Запустить MCP-сервер (stdio) или зарегистрировать его в opencode.json
  eval [--fixtures <dir>] [--rounds <1|2> | --compare-rounds] [--json]
       [--fail-under <pct>] [--max-cost <usd>]
                          Прогнать eval-фикстуры (по умолчанию eval/fixtures);
                          --rounds 2 — прогон с peer-review, --compare-rounds — сравнение
                          rounds=1 и rounds=2 (взаимоисключающе с --rounds);
                          --fail-under — код 3, если catch rate ниже порога
                          (в compare-режиме — catch rate дебатов);
                          --max-cost в compare-режиме ограничивает сумму обоих прогонов
  baseline accept <runId|latest> [--dry-run]
                          Принять находки запуска в .consilium/baseline.json
  baseline prune [--older-than <дни>] [--all] [--yes] [--dry-run]
                          Удалить старые записи baseline (по умолчанию старше 90 дней)
  history [--limit N] [--json]
                          История запусков из .consilium/runs
  stats [--json] [--html <файл>]
                          Сводная статистика запусков; --html — автономный HTML-отчёт
  audit --since <ref> [--dry-run] [--json] [--findings|--no-findings]
        [--fail-on <уровень>] [--max-cost <usd>] [-c <файл>] [-s] [--artifacts]
                          Аудит изменений с git ref: ревью diff, баги, безопасность и тесты;
                          --dry-run — показать запрос без вызова моделей
                          --fail-on автоматически включает находки
  sarif [--run <id|latest>] [--output <файл>]
                          Экспорт находок запуска в SARIF 2.1.0 (stdout или файл);
                          по умолчанию — самый свежий запуск из .consilium/runs

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
  consilium history --limit 10
  consilium stats
  consilium stats --html stats.html
  consilium models --available
  consilium models --local --probe-local
  consilium presets --json
  consilium models --reliability
  consilium eval --fail-under 80
  consilium eval --compare-rounds --fail-under 80
  consilium init --local --dry-run
  consilium audit --since HEAD~1 --fail-on high
  consilium sarif --run latest --output consilium.sarif
  consilium --report linear --report-file ticket.md "Сделать ревью изменений"
  consilium --rounds 2 "Оценить архитектуру проекта"
  consilium doctor

ДОКУМЕНТАЦИЯ:
  https://github.com/LevapVeeskela/lv24-opencode-consilium
`);
}
