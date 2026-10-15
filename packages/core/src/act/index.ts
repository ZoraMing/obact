import type { Action, ActResult } from '@obact/schemas';
import { ObactError } from '../errors.ts';
import type { Session } from '../session.ts';

/** 执行一个动作（FR-12~FR-15、FR-32，契约 action.json / act-result.json）。M1 并行实现中。 */
export async function act(_s: Session, _action: Action): Promise<ActResult> {
  throw new ObactError('internal', 'act 尚未实现');
}
