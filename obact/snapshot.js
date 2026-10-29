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
  const BLOCK_TAGS = new Set([
    'ARTICLE', 'MAIN', 'SECTION', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'DIV', 'P', 'UL', 'OL', 'LI', 'DL',
    'TABLE', 'TR', 'PRE', 'BLOCKQUOTE', 'FORM', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ]);
  const MIN_BLOCK_TEXT = 10;
  const MAX_LEAF_TEXT = 30;
  const MAX_PSEUDO_NODES = 20;
  const PRIVATE_USE = /[\uE000-\uF8FF]/g;
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
    // 先要求某个文字节点正好等于参数值，不行再退回包含：短值（如航班号 43）用包含时还会命中 4346、1:43
    const heads = [
      values.map((v) => `[.//text()[normalize-space(.)=${esc(v)}]]`).join(''),
      values.map((v) => `[.//text()[contains(., ${esc(v)})]]`).join(''),
    ];
    // 单独就能唯一定位的条件会绕过锚点：外层容器也包含参数值，换参数后仍会命中原来的元素
    const own = predicates(el, true)
      .map((p) => `//${stepTag(el)}[${p}]`)
      .filter((xp) => (evaluate(xp)?.snapshotLength || 0) > 1);
    for (const head of heads) {
      let rel = '';
      for (let child = el, a = el.parentElement; a && a !== document.documentElement; child = a, a = a.parentElement) {
        rel = `/${positionalStep(child)}${rel}`;
        const text = a.textContent || '';
        if (!values.every((v) => text.includes(v))) continue;
        // 位置路径同样不能单独唯一定位：锚点退到 tbody 这类大容器时，只剩位置下标在起作用
        const tails = (evaluate(`//${stepTag(a)}${rel}`)?.snapshotLength || 0) > 1 ? [...own, rel] : own;
        for (const tail of tails) {
          const xp = `//${stepTag(a)}${head}${tail}`;
          if (matchesOnly(xp, el)) return xp;
        }
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
    if (!n) n = pseudoName(el);
    return n.slice(0, 80);
  }

  // ::before 或 ::after 生成的文字。content 只取引号里的字符串，有 "/" 后的替代文字时取替代文字；
  // none、normal 以及含 counter()、open-quote、url() 等算不出文字的值返回空；去掉图标字体用的私用区字符
  function pseudoText(el, which) {
    const st = getComputedStyle(el, which);
    if (st.display === 'none' || st.visibility !== 'visible') return '';
    const tokens = st.content.match(/"(?:[^"\\]|\\.)*"|[^\s"]+/g) || [];
    const slash = tokens.indexOf('/');
    const strs = slash >= 0 ? tokens.slice(slash + 1) : tokens;
    if (!strs.length || strs.some((t) => t[0] !== '"')) return '';
    const unescape = (s) => s.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g,
      (m, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
    return strs.map(unescape).join('').replace(PRIVATE_USE, '');
  }

  // 元素本身和前 MAX_PSEUDO_NODES 个可见后代的伪元素文字，如文字写在 <button><i></i></button> 的 i::before 里
  function pseudoName(el) {
    const inner = Array.from(el.querySelectorAll('*')).slice(0, MAX_PSEUDO_NODES).filter((d) => d.checkVisibility());
    const parts = inner.flatMap((d) => [pseudoText(d, '::before'), pseudoText(d, '::after')]);
    return clean([pseudoText(el, '::before'), ...parts, pseudoText(el, '::after')].join(' '));
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

  // 叶子文字元素：没有子元素，带一段含字母或数字的短文字，不在 label 里。靠事件委托响应点击的元素（React 的下拉项、
  // 日历格子）自身没有交互特征，靠这条规则进清单（参考 Stagehand v1 的 isLeafElement）
  function isLeafText(el) {
    if (el.childElementCount || el.closest('label')) return false;
    const text = clean(el.textContent);
    return text.length <= MAX_LEAF_TEXT && /[\p{L}\p{N}]/u.test(text);
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

  // 遍历页面元素，跳过 display:none 的整棵子树
  function makeWalker() {
    const root = document.body || document.documentElement;
    return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        return getComputedStyle(el).display === 'none' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  // 收集整页可见元素；遮挡检测只对中心在视口内的元素做。叶子文字元素只收视口内、不在可交互元素里面的。
  // 超过上限时先保留可交互元素，再按离视口的远近
  function collect() {
    const walker = makeWalker();
    const found = [];
    const owners = new Set();
    let el;
    while ((el = walker.nextNode())) {
      const st = getComputedStyle(el);
      const leaf = !isCandidate(el, st);
      if (!leaf) owners.add(el);
      else if (!isLeafText(el)) continue;
      const r = visibleRect(el, st);
      if (!r) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      if (leaf) {
        if (!inView) continue;
        let a = el.parentElement;
        while (a && !owners.has(a)) a = a.parentElement;
        if (a) continue;
      }
      if (inView && !isTop(el, r)) continue;
      const dist = inView ? 0 : Math.abs(cx - innerWidth / 2) + Math.abs(cy - innerHeight / 2);
      found.push({ el, r, inView, dist, leaf });
    }
    if (found.length <= MAX_ITEMS) return found;
    const keep = new Set([...found].sort((a, b) => a.leaf - b.leaf || a.dist - b.dist).slice(0, MAX_ITEMS));
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
      // all:initial 会把 pointer-events 恢复成 auto；编号框盖住鼠标时会抢走悬停状态，悬停菜单随之收起
      mark.style.cssText = `all:initial;pointer-events:none;position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border:2px solid ${color};box-sizing:border-box;`;
      const label = document.createElement('span');
      label.textContent = String(it.id);
      label.style.cssText = `all:initial;pointer-events:none;position:absolute;left:-2px;top:${y >= 14 ? -14 : 0}px;background:${color};color:#fff;font:bold 11px/14px Arial,sans-serif;padding:0 3px;`;
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

  // read 用的文本块清单：整页可见、文字不太短的块级元素；文字和外层完全相同的包装元素只保留最外层，
  // 超过上限时优先保留文字多的块。不画编号框，截图保持原样
  function blocks() {
    clearMarks();
    const walker = makeWalker();
    const textOf = new Map();
    const found = [];
    let el;
    while ((el = walker.nextNode())) {
      if (!BLOCK_TAGS.has(el.tagName)) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const text = clean(el.innerText);
      if (text.length < MIN_BLOCK_TEXT) continue;
      let anc = el.parentElement;
      while (anc && !textOf.has(anc)) anc = anc.parentElement;
      if (anc && textOf.get(anc) === text) continue;
      textOf.set(el, text);
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
      found.push({ el, r, inView, text });
    }
    let kept = found;
    if (found.length > MAX_ITEMS) {
      const keep = new Set([...found].sort((a, b) => b.text.length - a.text.length).slice(0, MAX_ITEMS));
      kept = found.filter((f) => keep.has(f));
    }
    elements = [null];
    return kept.map(({ el, r, inView, text }, i) => {
      elements[i + 1] = el;
      return {
        id: i + 1,
        tag: el.localName,
        preview: text.slice(0, 60),
        length: text.length,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        inView,
        selector: selectorFor(el),
      };
    });
  }

  // extract 用的页面文本：一行一个可见文本块，带视口坐标。块状元素（display 不是 inline、contents，含 inline-block、
  // table-cell 和 flex、grid 的子项）里不属于下层块状元素的文字按顺序成行，下层块状元素前后的文字各自成行；
  // 相邻的两个行内元素之间补一个空格。隐藏的元素整棵跳过；伪元素文字、链接的 title、图片的 alt、下拉框的选中项也写进行里
  function texts() {
    const lines = [];
    const shown = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    function walk(block) {
      let parts = [];
      let first = null;
      let last = null;
      const add = (s, node) => {
        parts.push(s);
        if (node && s.trim()) {
          first = first || node;
          last = node;
        }
      };
      const flush = () => {
        const text = clean(parts.join(''));
        if (text) {
          let r = block.getBoundingClientRect();
          if (first) {
            const range = document.createRange();
            range.setStartBefore(first);
            range.setEndAfter(last);
            r = range.getBoundingClientRect();
          }
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
          const rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
          lines.push({ text, rect, inView });
        }
        parts = [];
        first = last = null;
      };
      const pseudo = (el, which) => {
        const t = pseudoText(el, which);
        if (t) add(` ${t} `);
      };
      const content = (el) => {
        pseudo(el, '::before');
        if (el.tagName === 'IMG') {
          const alt = clean(el.alt || el.title);
          if (alt) add(` [img: ${alt}] `, el);
        } else if (el.tagName === 'SELECT') {
          add(` ${el.selectedOptions[0]?.text || ''} `, el);
        } else {
          let prevEl = false;
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
              add(child.data, child);
              prevEl = false;
              continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(child.tagName)) continue;
            const st = getComputedStyle(child);
            // display:contents 的元素自己没有盒子，checkVisibility 总是 false，可见性由子元素各自判断
            if (st.display === 'none' || (st.display !== 'contents' && !shown(child))) continue;
            if (st.display !== 'inline' && st.display !== 'contents') {
              flush();
              walk(child);
              prevEl = false;
              continue;
            }
            if (prevEl || child.tagName === 'BR') add(' ');
            content(child);
            prevEl = true;
          }
        }
        const title = el.tagName === 'A' ? clean(el.title) : '';
        if (title && !clean(el.textContent).includes(title)) add(` [title: ${title}] `);
        pseudo(el, '::after');
      };
      content(block);
      flush();
    }
    walk(document.body || document.documentElement);
    return lines;
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

  // 这次点击或按键是否会在新标签页打开页面：target=_blank 的链接（下载链接除外），
  // 或 target=_blank 的表单里点提交按钮、在输入框按回车。脚本里 window.open 打开的无法事先判断
  function opensTab(el, method, key) {
    const enter = method === 'press' && key === 'Enter';
    if ((method === 'click' || enter) && el.closest('a[target="_blank"]:not([download])')) return true;
    const form = el.form || el.closest('form');
    if (!form || form.target !== '_blank') return false;
    if (enter) return el.tagName === 'INPUT';
    if (method !== 'click') return false;
    const btn = el.closest('button, input[type="submit"], input[type="image"]');
    return !!btn && (btn.tagName !== 'BUTTON' || btn.type === 'submit');
  }

  // 点击时浏览器会让按钮、链接获得焦点，点在不能获得焦点的地方时焦点回到 body：这类焦点变化是点击本身带来的
  const CLICK_FOCUS = 'body, a, button, input[type=button], input[type=submit], input[type=reset], input[type=image], '
    + '[role=button], [role=link]';
  // 内部的变化观察不到的元素：画布、内嵌页面和插件、视频
  const OPAQUE = 'canvas, iframe, embed, object, video';
  let watching = null;

  // 表单控件的值、勾选和选中状态；这些 property 的变化不会触发 MutationObserver
  function formState() {
    const controls = document.querySelectorAll('input, textarea, select');
    const state = (el) => (el.tagName === 'SELECT' ? Array.from(el.options, (o) => o.selected) : [el.value, el.checked]);
    return JSON.stringify(Array.from(controls, state));
  }

  // 编号框容器的插入、移除和容器内部的变化
  function isMark(r) {
    const el = r.target.nodeType === Node.ELEMENT_NODE ? r.target : r.target.parentElement;
    if (el && el.closest(`#${MARK_ID}`)) return true;
    const nodes = [...r.addedNodes, ...r.removedNodes];
    return nodes.length > 0 && nodes.every((n) => n.id === MARK_ID);
  }

  // 动作执行前调用：记下焦点和表单控件状态，开始记录 DOM 变化（childList、attributes、characterData）和滚动
  function watchEffect(method) {
    if (watching) watching.stop();
    const w = { method, changed: false, focus: document.activeElement, form: formState() };
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !isMark(r))) w.changed = true;
    });
    observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true });
    const onScroll = () => { w.changed = true; };
    addEventListener('scroll', onScroll, true);
    w.stop = () => {
      if (observer.takeRecords().some((r) => !isMark(r))) w.changed = true;
      observer.disconnect();
      removeEventListener('scroll', onScroll, true);
    };
    watching = w;
  }

  // 动作执行并等页面稳定后调用：这期间 DOM、滚动、焦点、表单控件状态有没有变化。
  // 导航后的新文档里没有观察记录，算作有变化；click 后焦点落在 CLICK_FOCUS 上不算变化
  function hadEffect() {
    const w = watching;
    watching = null;
    if (!w) return true;
    w.stop();
    const focus = document.activeElement;
    const focusMoved = focus !== w.focus && !(w.method === 'click' && (!focus || focus.matches(CLICK_FOCUS)));
    return w.changed || focusMoved || formState() !== w.form;
  }

  // 页面没有变化时再看动作目标：fill、select_option 后的值等于要求的值（与原值相同），或目标内部的变化观察不到
  function effectOn(el, method, value) {
    if (!el || el.closest(OPAQUE) || el.querySelector(OPAQUE) || el.shadowRoot) return true;
    if (method === 'fill') return el.value === value;
    if (method === 'select_option') return Array.from(el.selectedOptions || []).some((o) => o.value === value || o.label === value);
    return false;
  }

  window.__obact = {
    snapshot, blocks, texts, clearMarks, nameOf, anchor, settle, opensTab, watchEffect, hadEffect, effectOn,
  };
}
