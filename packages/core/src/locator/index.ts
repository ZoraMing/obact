import type { ResolveLocatorResult } from '@obact/schemas';
import { ObactError } from '../errors.ts';
import type { Session } from '../session.ts';

/** 把编号转成持久定位器并实测唯一性（FR-07，方法 resolve_locator）。M1 并行实现中。 */
export async function generateLocator(
  _s: Session,
  _pageId: string,
  _ref: number,
): Promise<ResolveLocatorResult> {
  throw new ObactError('internal', 'generateLocator 尚未实现');
}
