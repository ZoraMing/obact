import type { PageSignature } from '@obact/schemas';
import { ObactError } from '../errors.ts';
import type { Session } from '../session.ts';

/** 按 URL、标题、必须存在/不存在的元素判定当前页面（FR-08）；返回第一个命中的签名 ID。M1 并行实现中。 */
export async function matchSignature(
  _s: Session,
  _pageId: string,
  _signatures: PageSignature[],
): Promise<PageSignature | null> {
  throw new ObactError('internal', 'matchSignature 尚未实现');
}
