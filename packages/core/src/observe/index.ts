import type { ObserveParams, ObserveResult } from '@obact/schemas';
import { ObactError } from '../errors.ts';
import type { Session } from '../session.ts';

export type ObserveOptions = {
  /** 页面签名（FR-08）；命中的 ID 写入 result.signature。 */
  signatures?: import('@obact/schemas').PageSignature[];
  /** 截图类视图（screenshot、som）的保存目录；省略时用系统临时目录。 */
  outDir?: string;
};

/** 观察页面（FR-05、FR-31，契约 observe.json）。M1 并行实现中。 */
export async function observe(
  _s: Session,
  _params: ObserveParams,
  _opts: ObserveOptions = {},
): Promise<ObserveResult> {
  throw new ObactError('internal', 'observe 尚未实现');
}
