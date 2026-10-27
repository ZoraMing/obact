/**
 * 加载仓库根目录的 .env（不存在则忽略）。已在环境里设置的变量不会被覆盖，命令行里临时设的值优先。
 * 所有入口（命令行、示例脚本、tools/browser.ts）在最前面 import 本文件，保证读到同一份配置。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envFile = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
