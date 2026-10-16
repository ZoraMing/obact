/**
 * 启动 Obact Lab：node lab/server.ts [--port 8700]
 * 打开 http://127.0.0.1:8700/s/<空间名>/ 使用；不同空间名的数据互相独立。
 */
import { createLab } from './src/app.ts';

const i = process.argv.indexOf('--port');
const lab = await createLab({ port: i > 0 ? Number(process.argv[i + 1]) : 8700 });
console.log(`Obact Lab：${lab.base}/s/default/`);
console.log(`模块：${lab.modules.map((m) => `${m.title}（${m.name}）`).join('、') || '无'}`);
console.log(
  '控制接口：POST /s/<空间>/_lab/reset、GET /s/<空间>/_lab/state、POST /s/<空间>/_lab/faults',
);
