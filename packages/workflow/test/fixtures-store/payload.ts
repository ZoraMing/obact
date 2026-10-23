// 子进程与测试共用：第 n 次写入的大块数据。能由 n 重新生成，用来判断读到的内容是否完整。
export function payload(n: number): string {
  return String(n).padStart(8, '0').repeat(25_000);
}
