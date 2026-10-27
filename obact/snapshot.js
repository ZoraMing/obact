/*
 * Obact 页面端脚本，由 snapshot.py 注入，挂在 window.__obact 上。
 * 收集可见、未被遮挡的可交互元素，为每个元素生成稳定 XPath，在视口内的元素上画编号框。
 * XPath 生成与遮挡检测参考 Stagehand v1（lib/dom/xpathUtils.ts、lib/dom/elementCheckUtils.ts）。
 */
() => {
  if (window.__obact) return;

  const MARK_ID = '__obact_marks';
  const MAX_ITEMS = 300;
  const MAX_ANCESTORS = 6;
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'CANVAS']);
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'treeitem', 'gridcell', 'textbox', 'searchbox', 'combobox',
    'listbox', 'slider', 'spinbutton',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME']);
  // 生成选择器时依次尝试的属性；文本谓词排在 alt 之后、type 之前
  const ATTRS_BEFORE_TEXT = ['data-testid', 'data-test', 'data-qa', 'id', 'name', 'aria-label', 'placeholder', 'title', 'alt'];
  const ATTRS_AFTER_TEXT = ['type', 'role'];
  const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];

  let elements = [];

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // 与 XPath normalize-space() 一致，只折叠 XML 空白
  const xmlSpace = (s) => (s || '').replace(/[ \t\r\n]+/g, ' ').trim();

  function esc(v) {
    if (!v.includes("'")) return `'${v}'`;
    if (!v.includes('"')) return `"${v}"`;
    return 'concat(' + v.split(/('+)/).filter((p) => p).map((p) => (p.startsWith("'") ? `"${p}"` : `'${p}'`)).join(',') + ')';
  }

  function stepTag(el) {
    return el.namespaceURI === XHTML ? el.localName : `*[local-name()=${esc(el.localName)}]`;
  }

  function positionalStep(el) {
    const tag = stepTag(el);
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = Array.from(parent.children).filter((c) => c.localName === el.localName && c.namespaceURI === el.namespaceURI);
    return same.length > 1 ? `${tag}[${same.indexOf(el) + 1}]` : tag;
  }

  function evaluate(xp) {
    try {
      return document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (e) {
      return null;
    }
  }

  function matchesOnly(xp, el) {
    const r = evaluate(xp);
    return !!r && r.snapshotLength === 1 && r.snapshotItem(0) === el;
  }

  function attrPredicates(el, names) {
    const out = [];
    for (const a of names) {
      const v = el.getAttribute(a);
      if (!v || v.length > 100) continue;
      // 带长串数字或冒号的 id 多半是框架自动生成的
      if (a === 'id' && /\d{3,}|:|^\d/.test(v)) continue;
      out.push(`@${a}=${esc(v)}`);
    }
    return out;
  }

  // 文本谓词和两两组合只用于目标元素本身；祖先的文本是多个子元素拼起来的，容易随内容变化
  function predicates(el, isTarget) {
    const single = attrPredicates(el, ATTRS_BEFORE_TEXT);
    const text = xmlSpace(el.textContent);
    if (isTarget && text && text.length <= 40) single.push(`normalize-space()=${esc(text)}`);
    single.push(...attrPredicates(el, ATTRS_AFTER_TEXT));
    if (!isTarget) return single;
    const pairs = [];
    for (let i = 0; i < single.length; i++) {
      for (let j = i + 1; j < single.length; j++) pairs.push(`${single[i]} and ${single[j]}`);
    }
    return single.concat(pairs);
  }

  // 从元素往上找第一个能唯一定位的谓词，下面接位置路径；都不行就退回从 /html 开始的绝对路径
  function selectorFor(el) {
    let tail = '';
    let depth = 0;
    for (let cur = el; cur; cur = cur.parentElement, depth++) {
      if (depth <= MAX_ANCESTORS && cur !== document.body && cur !== document.documentElement) {
        for (const p of predicates(cur, cur === el)) {
          const xp = `//${stepTag(cur)}[${p}]${tail}`;
          if (matchesOnly(xp, el)) return xp;
        }
        if (cur === el && matchesOnly(`//${stepTag(el)}`, el)) return `//${stepTag(el)}`;
      }
      tail = `/${positionalStep(cur)}${tail}`;
    }
    return tail;
  }

  // 参数锚定：找最近的、文本包含全部参数值的祖先，生成 //tr[.//text()[contains(., 'CA1234')]]//button[...] 这类选择器
  function anchor(id, values) {
    const el = elements[id];
    if (!el || !el.isConnected) return null;
    const head = values.map((v) => `[.//text()[contains(., ${esc(v)})]]`).join('');
    // 单独就能唯一定位的条件会绕过锚点：外层容器也包含参数值，换参数后仍会命中原来的元素
    const own = predicates(el, true)
      .map((p) => `//${stepTag(el)}[${p}]`)
      .filter((xp) => (evaluate(xp)?.snapshotLength || 0) > 1);
    let rel = '';
    for (let child = el, a = el.parentElement; a && a !== document.documentElement; child = a, a = a.parentElement) {
      rel = `/${positionalStep(child)}${rel}`;
      const text = a.textContent || '';
      if (!values.every((v) => text.includes(v))) continue;
      for (const tail of [...own, rel]) {
        const xp = `//${stepTag(a)}${head}${tail}`;
        if (matchesOnly(xp, el)) return xp;
      }
    }
    return null;
  }

  // 可访问名称；输入框不取当前值，保证输入前后名称一致
  function nameOf(el) {
    let n = clean(el.getAttribute('aria-label'));
    if (!n) {
      const ids = el.getAttribute('aria-labelledby');
      if (ids) n = clean(ids.split(/\s+/).map((i) => document.getElementById(i)?.innerText || '').join(' '));
    }
    const tag = el.tagName;
    if (!n && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      if (el.labels && el.labels.length) n = clean(el.labels[0].innerText);
      if (!n) n = clean(el.getAttribute('placeholder'));
      if (!n && ['button', 'submit', 'reset'].includes(el.type)) n = clean(el.value);
    } else if (!n && !el.isContentEditable) {
      n = clean(el.innerText);
    }
    if (!n) n = clean(el.getAttribute('title') || el.getAttribute('alt') || el.querySelector('img[alt]')?.getAttribute('alt'));
    return n.slice(0, 80);
  }

  function valueOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return clean(el.selectedOptions[0]?.text);
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'checked' : '';
    if (tag === 'INPUT' && ['button', 'submit', 'reset', 'password'].includes(el.type)) return '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return String(el.value || '').slice(0, 60);
    return '';
  }

  function isCandidate(el, st) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable) return !el.parentElement || !el.parentElement.isContentEditable;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    // cursor:pointer 会被子元素继承，只收最外层那个
    if (st.cursor === 'pointer') {
      const parent = el.parentElement;
      return !parent || getComputedStyle(parent).cursor !== 'pointer';
    }
    return false;
  }

  function visibleRect(el, st) {
    if (st.visibility !== 'visible' || st.pointerEvents === 'none') return null;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    const docWidth = Math.max(document.documentElement.scrollWidth, innerWidth);
    if (r.right + scrollX <= 0 || r.left + scrollX >= docWidth || r.bottom + scrollY <= 0) return null;
    return r;
  }

  // 中心和四个内点里只要有一个点击中元素本身或其后代，就认为没有被遮挡
  function isTop(el, r) {
    const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    return points.some(([fx, fy]) => {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return !!hit && (hit === el || el.contains(hit));
    });
  }

  // 收集整页可见元素；遮挡检测只对中心在视口内的元素做，超过上限时优先保留离视口近的
  function collect() {
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        return getComputedStyle(el).display === 'none' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const found = [];
    let el;
    while ((el = walker.nextNode())) {
      const st = getComputedStyle(el);
      if (!isCandidate(el, st)) continue;
      const r = visibleRect(el, st);
      if (!r) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      if (inView && !isTop(el, r)) continue;
      const dist = inView ? 0 : Math.abs(cx - innerWidth / 2) + Math.abs(cy - innerHeight / 2);
      found.push({ el, r, inView, dist });
    }
    if (found.length <= MAX_ITEMS) return found;
    const keep = new Set([...found].sort((a, b) => a.dist - b.dist).slice(0, MAX_ITEMS));
    return found.filter((f) => keep.has(f));
  }

  function drawMarks(items) {
    const box = document.createElement('div');
    box.id = MARK_ID;
    box.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    for (const it of items) {
      if (!it.inView) continue;
      const [x, y, w, h] = it.rect;
      const color = COLORS[it.id % COLORS.length];
      const mark = document.createElement('div');
      mark.style.cssText = `all:initial;position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:2px solid ${color};box-sizing:border-box;`;
      const label = document.createElement('span');
      label.textContent = String(it.id);
      label.style.cssText = `all:initial;position:absolute;left:-2px;top:${y >= 14 ? -14 : 0}px;background:${color};color:#fff;font:bold 11px/14px Arial,sans-serif;padding:0 3px;`;
      mark.appendChild(label);
      box.appendChild(mark);
    }
    document.documentElement.appendChild(box);
  }

  function clearMarks() {
    document.getElementById(MARK_ID)?.remove();
  }

  function snapshot() {
    clearMarks();
    const found = collect();
    elements = [null];
    const items = found.map(({ el, r, inView }, i) => {
      const id = i + 1;
      elements[id] = el;
      const item = {
        id,
        tag: el.localName,
        type: el.tagName === 'INPUT' ? el.type : '',
        role: el.getAttribute('role') || '',
        name: nameOf(el),
        value: valueOf(el),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        inView,
        selector: selectorFor(el),
      };
      if (el.tagName === 'SELECT') item.options = Array.from(el.options).slice(0, 20).map((o) => clean(o.text));
      return item;
    });
    drawMarks(items);
    return items;
  }

  // DOM 连续 quietMs 没有节点变化即视为稳定，最多等 maxMs（参考 Stagehand 的 waitForDomSettle）
  function settle(quietMs, maxMs) {
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        observer.disconnect();
        clearTimeout(timer);
        clearTimeout(cap);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(done, quietMs);
      });
      observer.observe(document, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(done, quietMs);
      const cap = setTimeout(done, maxMs);
    });
  }

  window.__obact = { snapshot, clearMarks, nameOf, anchor, settle };
}
