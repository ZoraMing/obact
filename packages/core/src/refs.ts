import type { Frame } from 'puppeteer-core';

export type RefEntry = { ref: number; pageId: string; frame: Frame };

/**
 * 编号表（FR-06）：编号在会话内递增、不复用，绑定到具体节点。
 *
 * 节点身份由页面内两样东西共同确定：元素属性 data-obact-ref（各视图对齐用）和本会话写在元素上的
 * 不可枚举标记（键名含会话随机串）。克隆重绘会带走属性但带不走标记，所以能识别为失效（M0 预研 1.3）。
 * 这里只记编号属于哪个标签页的哪个 frame。
 */
export class RefRegistry {
  #next = 1;
  readonly #map = new Map<number, RefEntry>();

  get next(): number {
    return this.#next;
  }

  /** 页面内编号完成后，推进计数并登记新编号。 */
  commit(next: number, added: number[], pageId: string, frame: Frame): void {
    if (next < this.#next) throw new Error(`编号回退：${next} < ${this.#next}`);
    this.#next = next;
    for (const ref of added) this.#map.set(ref, { ref, pageId, frame });
  }

  get(ref: number): RefEntry | undefined {
    return this.#map.get(ref);
  }

  /** 标签页关闭时清理。 */
  dropPage(pageId: string): void {
    for (const [ref, e] of this.#map) if (e.pageId === pageId) this.#map.delete(ref);
  }

  get size(): number {
    return this.#map.size;
  }
}
