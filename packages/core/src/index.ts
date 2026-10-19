export { checkAssertions } from './act/assert.ts';
export { type ActOptions, act, currentActionSeq, type ObscuredInfo } from './act/index.ts';
export { BANNER_ATTR, DEFAULT_BANNER_TEXT, hideBanner, showBanner } from './banner.ts';
export {
  browserEnv,
  connectBrowser,
  type LaunchOptions,
  launchBrowser,
  resolveChromePath,
  sandboxArgs,
} from './browser.ts';
export { asObactError, type ErrorCode, ObactError } from './errors.ts';
export { generateLocator, generateLocatorForHandle, locatorAtPoint } from './locator/index.ts';
export { exposeForMarking, type FrameRefs, markPage } from './mark.ts';
export { type ObserveOptions, observe } from './observe/index.ts';
export { matchSignature } from './observe/signature.ts';
export { PageRegistry } from './pages.ts';
export {
  assertAccountName,
  BrowserPool,
  type PoolEntryInfo,
  type PoolExit,
  type PoolLease,
  type PoolOptions,
  type PoolWarning,
} from './pool.ts';
export { type RefEntry, RefRegistry } from './refs.ts';
export {
  frameFor,
  type Resolved,
  resolveLocator,
  resolveRef,
  resolveTarget,
} from './resolve.ts';
export { REF_ATTR, Session } from './session.ts';
export {
  type BrowserVersionCheck,
  checkBrowserVersion,
  judgeBrowserVersion,
  MIN_BROWSER_MAJOR,
} from './version.ts';
