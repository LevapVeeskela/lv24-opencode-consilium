/**
 * @fileoverview Контроллер запуска OpenCode: отмена и учёт дочерних процессов
 * @module lv24-opencode-consilium
 */

import { spawn, type ChildProcess } from 'child_process';

/** Контроллер запуска: отмена и учёт дочерних процессов */
export interface RunController {
  cancel(): void;
  reset(): void;
  isCancelled(): boolean;
}

/** Состояние контроллера запуска */
export interface ControllerState {
  cancelled: boolean;
  children: Set<ChildProcess>;
}

const controllerStates = new WeakMap<RunController, ControllerState>();
export const killTimers = new WeakMap<ChildProcess, NodeJS.Timeout>();

/** Создаёт независимый контроллер запуска */
export function createRunController(): RunController {
  const state: ControllerState = {
    cancelled: false,
    children: new Set<ChildProcess>()
  };

  const controller: RunController = {
    cancel(): void {
      state.cancelled = true;
      for (const child of [...state.children]) {
        killProcessTree(child);
      }
      state.children.clear();
    },
    reset(): void {
      state.cancelled = false;
    },
    isCancelled(): boolean {
      return state.cancelled;
    }
  };

  controllerStates.set(controller, state);
  return controller;
}

export function getControllerState(controller: RunController): ControllerState {
  let state = controllerStates.get(controller);
  if (!state) {
    state = { cancelled: false, children: new Set<ChildProcess>() };
    controllerStates.set(controller, state);
  }
  return state;
}

export const defaultController = createRunController();

/** Отменяет запуск по умолчанию и убивает его процессы */
export function cancel(): void {
  defaultController.cancel();
}

/** Сбрасывает флаг отмены запуска по умолчанию */
export function resetCancel(): void {
  defaultController.reset();
}

/** Проверяет, отменён ли запуск по умолчанию */
export function isCancelled(): boolean {
  return defaultController.isCancelled();
}

/** Убивает процесс и его дерево */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;

  if (process.platform === 'win32') {
    if (pid === undefined) {
      try {
        child.kill();
      } catch {
        // Игнорируем
      }
      return;
    }

    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true
      });
      killer.on('error', () => {
        // taskkill недоступен — пробуем убить хотя бы сам процесс
        try {
          child.kill();
        } catch {
          // Игнорируем
        }
      });
      killer.on('close', code => {
        if (code !== 0) {
          try {
            child.kill();
          } catch {
            // Игнорируем
          }
        }
      });
      killer.unref();
    } catch {
      try {
        child.kill();
      } catch {
        // Игнорируем
      }
    }
    return;
  }

  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      if (pid !== undefined) {
        process.kill(-pid, signal);
        return;
      }
    } catch {
      // Группа недоступна — убиваем сам процесс
    }
    try {
      child.kill(signal);
    } catch {
      // Игнорируем
    }
  };

  signalGroup('SIGTERM');

  if (killTimers.has(child)) return;
  const killerTimer = setTimeout(() => {
    killTimers.delete(child);
    signalGroup('SIGKILL');
  }, 2000);
  killerTimer.unref();
  killTimers.set(child, killerTimer);
}
