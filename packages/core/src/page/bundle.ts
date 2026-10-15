/**
 * 页面内执行的代码：用一组自包含的函数声明拼成一个函数，交给 frame.evaluate / handle.evaluate。
 *
 * - 依赖函数必须是 `function 名字() {}` 形式的声明，只能互相调用，不能引用模块里的其他变量。
 * - 不在页面里留全局变量；每次调用都带上完整源码（本机 CDP，开销可以接受）。
 * - 通过 DevTools 协议求值不受页面 CSP 限制；页面内不要再用 eval / new Function。
 */
// biome-ignore lint/complexity/noBannedTypes: 依赖可以是任意签名的函数声明
export function bundle<F extends (...args: never[]) => unknown>(main: F, deps: Function[]): F {
  const src = `${deps.map(String).join('\n')}\nreturn (${String(main)}).apply(this, arguments);`;
  return new Function(src) as F;
}
