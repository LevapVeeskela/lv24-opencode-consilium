#!/usr/bin/env node

/**
 * @file Точка входа CLI для consilium
 */

import('../dist/cli.js')
  .then(async (module) => {
    const code = await module.main(process.argv.slice(2));
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Ошибка запуска CLI:', message);
    if (message.includes('Cannot find module')) {
      console.error('   Похоже, проект не собран. Выполните: npm run build');
    }
    process.exit(1);
  });
