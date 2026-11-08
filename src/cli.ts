// Compatibility entry point. Implementation: src/interfaces/cli/cli.ts
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { main } from './interfaces/cli/cli.js';

export * from './interfaces/cli/cli.js';

const invokedDirectly = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error('💥 Критическая ошибка:', error);
      process.exitCode = 1;
    });
}
