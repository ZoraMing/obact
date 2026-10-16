/**
 * 页面内执行的代码：用一组自包含的函数声明拼成一个函数，交给 frame.evaluate / handle.evaluate。
 *
 * - 依赖函数必须是 `function 名字() {}` 形式的声明，只能互相调用，不能引用模块里的其他变量。
 * - 不在页面里留全局变量；每次调用都带上完整源码（本机 CDP，开销可以接受）。
 * - 助手之间可通过 __obactCache（每次调用新建的 Map）共享本次调用内的计算结果，见 dom.ts 的 obLabelsOf。
 * - 通过 DevTools 协议求值不受页面 CSP 限制；页面内不要再用 eval / new Function。
 */
// biome-ignore lint/complexity/noBannedTypes: 依赖可以是任意签名的函数声明
export function bundle<F extends (...args: never[]) => unknown>(main: F, deps: Function[]): F {
  // __obactCache：本次页面内调用的共享缓存（如 label 索引），每次调用都是新的，不跨调用、不留全局
  const src = `var __obactCache = new Map();\n${deps.map(String).join('\n')}\nreturn (${String(main)}).apply(this, arguments);`;
  return new Function(src) as F;
}
