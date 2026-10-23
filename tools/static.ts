/**
 * 本地静态服务（夹具服务、基准的页面服务）共用的路径解析：URL 路径 → root 下的文件。
 * 路径含非法百分号编码返回 400（不能抛出：抛在请求回调里会让整个服务进程退出）；
 * 解码后落在 root 之外返回 403。比较要带分隔符，否则名字以 root 为前缀的兄弟目录（pages-private）也会放行。
 */
import { join, normalize, resolve, sep } from 'node:path';

export function resolveStatic(
  root: string,
  urlPath: string,
): { file: string } | { status: number } {
  let path: string;
  try {
    path = decodeURIComponent(urlPath);
  } catch {
    return { status: 400 };
  }
  const base = resolve(root);
  const file = normalize(join(base, path));
  if (file !== base && !file.startsWith(base + sep)) return { status: 403 };
  return { file };
}
