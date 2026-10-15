import type { Locator, PageSignature } from '@obact/schemas';
import type { Page } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
import { bundle } from '../page/bundle.ts';
import { DOM_LIB } from '../page/dom.ts';
import { frameFor } from '../resolve.ts';
import type { Session } from '../session.ts';
import { OBS_LIB, obsCountLocator } from './page.ts';

const COUNT = bundle(obsCountLocator, [...DOM_LIB, ...OBS_LIB]);

function regex(source: string, field: string, id: string): RegExp {
  try {
    return new RegExp(source);
  } catch (e) {
    throw new ObactError(
      'invalid_params',
      `签名 ${id} 的 ${field} 正则无效：${(e as Error).message}`,
      {
        signature: id,
        [field]: source,
      },
    );
  }
}

/** 定位器是否至少命中一个渲染出来的元素（display:none 的模板、隐藏副本不算）；frame 找不到视为不存在。 */
async function exists(page: Page, loc: Locator, id: string): Promise<boolean> {
  let frame: Awaited<ReturnType<typeof frameFor>>;
  try {
    frame = await frameFor(page, loc.frame);
  } catch (e) {
    if (e instanceof ObactError && (e.code === 'not_found' || e.code === 'not_unique'))
      return false;
    throw e;
  }
  const { frame: _f, ...inFrame } = loc;
  try {
    return (await frame.evaluate(COUNT, inFrame)) > 0;
  } catch (e) {
    throw new ObactError('invalid_params', `签名 ${id} 的定位器无效：${(e as Error).message}`, {
      signature: id,
      locator: loc,
    });
  }
}

/**
 * 按 URL、标题、必须存在/不存在的元素判定当前页面（FR-08）：url、title 为正则；must_exist 每个至少命中一个，
 * must_not_exist 全部不命中。按顺序返回第一个命中的签名，都不命中返回 null。
 */
export async function matchSignature(
  s: Session,
  pageId: string,
  signatures: PageSignature[],
): Promise<PageSignature | null> {
  const page = s.pages.get(pageId);
  const url = page.url();
  const title = await page.title();
  for (const sig of signatures) {
    if (sig.url !== undefined && !regex(sig.url, 'url', sig.id).test(url)) continue;
    if (sig.title !== undefined && !regex(sig.title, 'title', sig.id).test(title)) continue;
    let ok = true;
    for (const loc of sig.must_exist ?? []) {
      if (!(await exists(page, loc, sig.id))) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const loc of sig.must_not_exist ?? []) {
      if (await exists(page, loc, sig.id)) {
        ok = false;
        break;
      }
    }
    if (ok) return sig;
  }
  return null;
}
