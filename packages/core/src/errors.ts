import type { ObactError as ObactErrorShape } from '@obact/schemas';

export type ErrorCode = ObactErrorShape['code'];

/** 工具内所有可预期的失败都抛这个错误；code 对应契约 common.json#/$defs/ErrorCode。 */
export class ObactError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ObactError';
    this.code = code;
    this.details = details;
  }

  toJSON(): ObactErrorShape {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

/** 把任意异常归一为 ObactError，便于写进动作返回。 */
export function asObactError(e: unknown): ObactError {
  if (e instanceof ObactError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === 'TimeoutError') return new ObactError('timeout', err.message);
  if (/Target closed|Session closed|Connection closed|detached/i.test(err.message)) {
    return new ObactError('browser_disconnected', err.message);
  }
  if (/Evaluation failed|ReferenceError|SyntaxError/.test(err.message)) {
    return new ObactError('script_error', err.message);
  }
  return new ObactError('internal', err.message);
}
