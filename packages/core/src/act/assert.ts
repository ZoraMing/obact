import type { Assertion, AssertionResult } from '@obact/schemas';
import { ObactError } from '../errors.ts';
import type { Session } from '../session.ts';

/** 判定一组检查项（前置/后置检查、assert、wait_for 共用）。M1 并行实现中。 */
export async function checkAssertions(
  _s: Session,
  _pageId: string,
  _checks: Assertion[],
): Promise<AssertionResult[]> {
  throw new ObactError('internal', 'checkAssertions 尚未实现');
}
