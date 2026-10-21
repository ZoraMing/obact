import type { Assertion, AssertionResult, Locator, PageSignature } from '@obact/schemas';
import type { Frame, Page } from 'puppeteer-core';
import { ObactError } from '../errors.ts';
import { bundle } from '../page/bundle.ts';
import { frameFor, resolveLocator } from '../resolve.ts';
import type { Session } from '../session.ts';
import { ACT_DEPS, obActCount, obActFrameShown, obActText, obActValue } from './page.ts';
import { within } from './util.ts';

const COUNT = bundle(obActCount, ACT_DEPS);
const VALUE = bundle(obActValue, ACT_DEPS);
const FRAME_TEXT = bundle(
  (main: boolean, limit: number) => (main || obActFrameShown() ? obActText(limit) : ''),
  ACT_DEPS,
);

export type AssertOptions = {
  /** 页面签名（signature 检查用，FR-08）。 */
  signatures?: PageSignature[];
  /** 签名判定函数；省略时按签名规则做最小判定（URL、标题、必须存在/不存在的元素）。 */
  matchSignature?: (
    s: Session,
    pageId: string,
    signatures: PageSignature[],
  ) => Promise<PageSignature | null>;
  /** 单项检查的求值上限（页面无响应时不挂起），默认 5000 毫秒。 */
  timeoutMs?: number;
};

const TEXT_LIMIT = 500_000;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * 判定一组检查项（前置/后置检查、assert、wait_for 共用）：每项只求值一次，不等待；等待由调用方轮询。
 * 结果逐项返回：原检查项 + pass + detail（未通过的原因）。
 * 页面不存在报 page_not_found；正则无效、选择器无效、签名未提供报 invalid_params。
 * 页面无响应、求值出错时 absent 类检查不通过（不能断定“没有”）。
 */
export async function checkAssertions(
  s: Session,
  pageId: string,
  checks: Assertion[],
  opts: AssertOptions = {},
): Promise<AssertionResult[]> {
  const page = s.pages.get(pageId);
  const limit = opts.timeoutMs ?? 5000;
  let texts: Promise<Texts> | null = null;
  const getTexts = () => {
    texts ??= visibleTexts(page, limit);
    return texts;
  };
  const out: AssertionResult[] = [];
  for (const check of checks) {
    const r = await checkOne(s, pageId, page, check, opts, limit, getTexts);
    const res: AssertionResult = { ...check, pass: r.pass };
    if (r.detail) res.detail = r.detail;
    out.push(res);
  }
  return out;
}

type Verdict = { pass: boolean; detail?: string };

async function checkOne(
  s: Session,
  pageId: string,
  page: Page,
  check: Assertion,
  opts: AssertOptions,
  limit: number,
  getTexts: () => Promise<Texts>,
): Promise<Verdict> {
  if (check.text_present !== undefined || check.text_absent !== undefined) {
    const present = check.text_present !== undefined;
    const needle = norm((check.text_present ?? check.text_absent) as string);
    const { texts, partial } = await getTexts();
    const found = texts.some((t) => norm(t).includes(needle));
    if (present) {
      if (found) return { pass: true };
      return {
        pass: false,
        detail: `页面上没有“${needle}”${partial ? '（有 frame 无响应）' : ''}`,
      };
    }
    if (found) return { pass: false, detail: `页面上仍有“${needle}”` };
    // 有 frame 没取到文本时，不能断定页面上没有
    return partial
      ? { pass: false, detail: `页面无响应，无法确认没有“${needle}”` }
      : { pass: true };
  }
  if (check.element_present || check.element_absent) {
    const present = !!check.element_present;
    const loc = (check.element_present ?? check.element_absent) as Locator;
    const c = await countVisible(page, loc, limit);
    const detail = c.note ?? `可见匹配 ${c.visible} 个（共 ${c.total} 个）`;
    if (present) return c.visible > 0 ? { pass: true } : { pass: false, detail };
    // 求值没有结果（页面无响应、出错）时，不能断定元素不存在
    if (c.unknown) return { pass: false, detail };
    return c.visible === 0 ? { pass: true } : { pass: false, detail };
  }
  if (check.url_matches !== undefined) {
    const url = page.url();
    return regex(check.url_matches, 'url_matches').test(url)
      ? { pass: true }
      : { pass: false, detail: `当前 URL：${url}` };
  }
  if (check.title_matches !== undefined) {
    const title = (await within(page.title(), limit, null).catch(() => null)) ?? '';
    return regex(check.title_matches, 'title_matches').test(title)
      ? { pass: true }
      : { pass: false, detail: `当前标题：${title}` };
  }
  if (check.signature !== undefined) {
    const sig = opts.signatures?.find((x) => x.id === check.signature);
    if (!sig) {
      throw new ObactError('invalid_params', `没有提供页面签名：${check.signature}`, {
        signature: check.signature,
      });
    }
    if (opts.matchSignature) {
      const m = await opts.matchSignature(s, pageId, [sig]);
      return m?.id === sig.id
        ? { pass: true }
        : { pass: false, detail: `页面不符合签名 ${sig.id}` };
    }
    return matchOne(page, sig, limit);
  }
  if (check.value_equals) {
    const { target, value } = check.value_equals;
    try {
      const r = await resolveLocator(s, pageId, target);
      const v = (await within(r.handle.evaluate(VALUE), limit, null).catch(() => null)) as
        | string
        | null;
      await r.handle.dispose().catch(() => {});
      if (v === null) return { pass: false, detail: '页面无响应' };
      return v === value || norm(v) === norm(value)
        ? { pass: true }
        : { pass: false, detail: `当前值：${v.slice(0, 200)}` };
    } catch (e) {
      if (e instanceof ObactError && e.code !== 'page_not_found') {
        return { pass: false, detail: e.message };
      }
      throw e;
    }
  }
  if (check.expr !== undefined) {
    const src = `(async () => Boolean(${check.expr}))()`;
    try {
      const v = await within(page.mainFrame().evaluate(src), limit, null);
      if (v === null) return { pass: false, detail: '页面无响应' };
      return v ? { pass: true } : { pass: false, detail: '表达式为假' };
    } catch (e) {
      return { pass: false, detail: `表达式出错：${firstLine(e)}` };
    }
  }
  throw new ObactError('invalid_params', '未知的检查项', { check });
}

function firstLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split('\n')[0] ?? '';
}

function regex(pattern: string, field: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw new ObactError('invalid_params', `${field} 不是有效的正则：${pattern}`, {
      [field]: pattern,
    });
  }
}

/** 可见文本；partial 表示有 frame 超时或求值出错，文本没取到（已移除的 frame 不算）。 */
type Texts = { texts: string[]; partial: boolean };

/** 主 frame 及同源 frame 的可见文本（跨域 frame 不计）。 */
async function visibleTexts(page: Page, limit: number): Promise<Texts> {
  const main = page.mainFrame();
  const origin = originOf(main.url());
  const frames = page.frames().filter((f) => {
    if (f === main) return true;
    if (f.detached) return false;
    const u = f.url();
    return u === 'about:blank' || u === 'about:srcdoc' || originOf(u) === origin;
  });
  let partial = false;
  const texts = await Promise.all(
    frames.map(async (f) => {
      const t = (await within(f.evaluate(FRAME_TEXT, f === main, TEXT_LIMIT), limit, null).catch(
        () => null,
      )) as string | null;
      if (t === null && !f.detached) partial = true;
      return t;
    }),
  );
  return { texts: texts.filter(Boolean) as string[], partial };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * 按定位器计数可见元素（≥1 即存在，不要求唯一）；frame 链找不到时计为 0。
 * 页面无响应或求值出错时 unknown 为 true（0 只是没有结果，不代表不存在）；选择器无效报 invalid_params。
 */
async function countVisible(
  page: Page,
  loc: Locator,
  limit: number,
): Promise<{ visible: number; total: number; note?: string; unknown?: boolean }> {
  let frame: Frame;
  try {
    frame = await frameFor(page, loc.frame);
  } catch (e) {
    if (e instanceof ObactError && (e.code === 'not_found' || e.code === 'not_unique')) {
      return { visible: 0, total: 0, note: e.message };
    }
    throw e;
  }
  const { frame: _f, ...inFrame } = loc;
  try {
    const r = await within(frame.evaluate(COUNT, inFrame), limit, null);
    return r ?? { visible: 0, total: 0, note: '页面无响应', unknown: true };
  } catch (e) {
    const msg = firstLine(e);
    if (/not a valid selector/.test(msg)) {
      throw new ObactError(
        'invalid_params',
        `定位器的选择器无效：${msg.replace(/^SyntaxError: /, '')}`,
        {
          locator: loc,
        },
      );
    }
    return { visible: 0, total: 0, note: `页面求值出错：${msg}`, unknown: true };
  }
}

/** 页面签名的最小判定（FR-08）：URL、标题正则，必须存在与必须不存在的元素。 */
async function matchOne(page: Page, sig: PageSignature, limit: number): Promise<Verdict> {
  if (sig.url !== undefined && !regex(sig.url, 'signature.url').test(page.url())) {
    return { pass: false, detail: `URL 不符合签名 ${sig.id}` };
  }
  if (sig.title !== undefined) {
    const title = (await within(page.title(), limit, null).catch(() => null)) ?? '';
    if (!regex(sig.title, 'signature.title').test(title)) {
      return { pass: false, detail: `标题不符合签名 ${sig.id}` };
    }
  }
  for (const loc of sig.must_exist ?? []) {
    if ((await countVisible(page, loc, limit)).visible === 0) {
      return { pass: false, detail: `签名 ${sig.id} 要求的元素不存在：${JSON.stringify(loc)}` };
    }
  }
  for (const loc of sig.must_not_exist ?? []) {
    const c = await countVisible(page, loc, limit);
    if (c.unknown)
      return { pass: false, detail: `签名 ${sig.id} 无法确认排除的元素不存在：${c.note}` };
    if (c.visible > 0) {
      return { pass: false, detail: `签名 ${sig.id} 排除的元素存在：${JSON.stringify(loc)}` };
    }
  }
  return { pass: true };
}
