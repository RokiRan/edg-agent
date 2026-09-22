// Self-contained: must NOT import any module. Injected into page via executeScript.

export interface ElInfo {
  id: number;
  tag: string;
  role: string | null;
  text: string;
  type: string | null;
  placeholder: string | null;
  href: string | null;
  /** 仅 file input：accept 属性（允许的文件类型），其余元素为 null。 */
  accept?: string | null;
  options?: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElInfo[];
  pageText: string;
  /** 最近操作元素的邻近文本（无操作时为空串）。 */
  contextText: string;
}

export function domSnapshot(): PageSnapshot {
  const trim = (s: string, n: number): string => {
    const t = (s || '').trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  // Clear stale markers
  const stale = document.querySelectorAll('[data-edg-id]');
  stale.forEach((n) => n.removeAttribute('data-edg-id'));
  // 上一轮 upload 打在隐藏 file input 上的标记一并清掉
  document.querySelectorAll('[data-edg-upload]').forEach((n) => n.removeAttribute('data-edg-upload'));
  // 拖拽上传留下的影子 input 直接移除（我们自己注入的，不属于页面）
  document.querySelectorAll('input[data-edg-shadow]').forEach((n) => n.remove());

  const elements: ElInfo[] = [];
  const candidates = document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="combobox"], [role="textbox"], [role="option"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [contenteditable=""], [contenteditable="true"], [onclick], .ant-select-item-option, .el-select-dropdown__item, [class*="dropzone"], [class*="drop-zone"], [id*="dropzone"], [data-dropzone], .el-upload-dragger, .ant-upload-drag');

  // 两遍收集：先表单/控件，再链接等其余可交互元素。
  // 文档很长时（如组件库文档页），150 条上限按 DOM 序会被导航链接耗尽，
  // 导致页面上的表单根本进不了快照（实测 ant.design 表单 demo 页复现）。
  const isFormControl = (el: HTMLElement): boolean => {
    const t = el.tagName.toLowerCase();
    if (t === 'input' || t === 'select' || t === 'textarea' || t === 'button') return true;
    const r = el.getAttribute('role');
    return (
      r === 'combobox' ||
      r === 'textbox' ||
      r === 'searchbox' ||
      r === 'checkbox' ||
      r === 'radio' ||
      r === 'switch' ||
      r === 'tab' ||
      r === 'option' ||
      r === 'menuitem' ||
      r === 'menuitemcheckbox' ||
      r === 'menuitemradio'
    );
  };

  // 浮层优先（第 0 遍）：点击触发后新出现的下拉/弹窗门户挂在 body 末尾（DOM 序最末），
  // 在 150 上限下最先被挤出快照（实测 ant.design 级联页表单遍达 160 条、门户项全灭）。
  // 浮层判定 = popup 角色/类名祖先 + 计算样式 position absolute|fixed，
  // 排除文档流内的静态菜单（如文档站侧栏 ant-menu）。
  const inPopup = (el: HTMLElement): boolean => {
    const c = el.closest(
      '[role="listbox"], [role="menu"], [role="dialog"], [role="tooltip"], .ant-select-dropdown, .ant-cascader-menus, .el-select-dropdown, .el-popper',
    );
    if (!c) return false;
    const p = window.getComputedStyle(c as HTMLElement).position;
    return p === 'absolute' || p === 'fixed';
  };
  // 遮挡过滤：人只点得到最上层。被弹窗/遮罩盖住的元素（典型：列表页上开着
  // 大面积表单弹层时，底层列表的搜索表单）不应进快照——实测会严重干扰动作选择。
  // 判定：元素与视口交集的中心点 elementFromPoint 命中自身/子孙/祖先 = 未被遮挡；
  // 完全在视口外的元素无法命中，保留（滚动可及）。
  const notOccluded = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect();
    const ix = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    const iy = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (ix <= 0 || iy <= 0) return true;
    const hit = document.elementFromPoint(Math.max(r.left, 0) + ix / 2, Math.max(r.top, 0) + iy / 2);
    if (!hit) return true;
    return hit === el || el.contains(hit) || hit.contains(el);
  };

  let nextId = 1;
  const seen = new Set<HTMLElement>();
  for (let pass = 0; pass < 3 && elements.length < 150; pass++) {
  for (let i = 0; i < candidates.length && elements.length < 150; i++) {
    const el = candidates[i] as HTMLElement;
    if (seen.has(el)) continue;
    if (pass === 0 && !inPopup(el)) continue;
    if (pass === 1 && !isFormControl(el)) continue;
    const rects = el.getClientRects();
    if (rects.length === 0) continue;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!notOccluded(el)) continue;

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const type = el.getAttribute('type');
    const placeholder = el.getAttribute('placeholder');
    const href = el.getAttribute('href');
    const ariaLabel = el.getAttribute('aria-label');
    const titleAttr = el.getAttribute('title');
    const valueAttr = (el as HTMLInputElement).value;

    let rawText = '';
    if (tag === 'input') {
      rawText = valueAttr || ariaLabel || titleAttr || '';
    } else if (tag === 'textarea') {
      rawText = (el as HTMLTextAreaElement).value || ariaLabel || titleAttr || '';
    } else {
      rawText = (el as HTMLElement).innerText || ariaLabel || titleAttr || '';
    }
    const text = trim(rawText.replace(/\s+/g, ' ').trim(), 60);

    const info: ElInfo = {
      id: nextId,
      tag,
      role: role || null,
      text,
      type: type || null,
      placeholder: placeholder || null,
      href: href || null,
    };
    if (tag === 'input' && type === 'file') {
      info.accept = el.getAttribute('accept');
    }

    if (tag === 'select') {
      const opts: string[] = [];
      const sel = el as HTMLSelectElement;
      for (let j = 0; j < sel.options.length && opts.length < 8; j++) {
        opts.push(trim(sel.options[j].textContent || sel.options[j].value || '', 20));
      }
      info.options = opts;
    }

    el.setAttribute('data-edg-id', String(nextId));
    seen.add(el);
    elements.push(info);
    nextId++;
  }
  }

  const main =
    (document.querySelector('main, article') as HTMLElement | null) ||
    (document.body as HTMLElement | null);
  const rawPageText = main ? main.innerText : '';
  const pageText = trim((rawPageText || '').replace(/\s+/g, ' ').trim(), 2000);
  // 最近操作区域：以上一次 click/type 目标元素为锚，向上取第一个非空祖先文本。
  // 让 LLM 能在「正文摘录首轮才有」的条件下确认动作效果（如下拉选中值回显）。
  const ctxStore = window as unknown as { __edgCtx?: Element };
  let contextText = '';
  const ctxEl = ctxStore.__edgCtx;
  if (ctxEl && ctxEl.isConnected) {
    let node: Element | null = ctxEl;
    for (let up = 0; up < 3 && node; up++, node = node.parentElement) {
      const t = ((node as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
      if (t.length === 0) continue;
      contextText = trim(t, 300);
      if (t.length <= 300) break;
    }
  }
  // 标号徽标随每次快照重绘：data-edg-id 每步清掉重编号，旧徽标必须同步失效，
  // 否则第 2 步起页面上的编号就与快照脱节（实测页面越跑越乱的根源之一）。
  // 注意：本函数会被 executeScript 单独序列化注入，必须自包含——徽标绘制
  // 只能内联在这里，不能引用模块级 drawEdgBadges（页面侧会是未定义）。
  {
    const old = document.getElementById('edg-overlay-root');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const root = document.createElement('div');
    root.id = 'edg-overlay-root';
    root.style.position = 'absolute';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '0';
    root.style.height = '0';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';
    for (const info of elements) {
      const el = document.querySelector(`[data-edg-id="${info.id}"]`) as HTMLElement | null;
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const badge = document.createElement('div');
      badge.textContent = String(info.id);
      badge.style.position = 'absolute';
      badge.style.left = `${Math.round(rect.left + window.scrollX)}px`;
      badge.style.top = `${Math.round(rect.top + window.scrollY)}px`;
      badge.style.background = '#2563eb';
      badge.style.color = '#fff';
      badge.style.font = '11px monospace';
      badge.style.padding = '0 3px';
      badge.style.borderRadius = '3px';
      badge.style.lineHeight = '14px';
      badge.style.pointerEvents = 'none';
      root.appendChild(badge);
    }
    document.documentElement.appendChild(root);
  }

  return {
    url: location.href,
    title: document.title,
    elements,
    pageText,
    contextText,
  };
}


/**
 * showOverlay：任务首轮显式画一次标号（domSnapshot 已内联重绘，这里是幂等补充）。
 * 自包含约束与 domSnapshot 相同：executeScript 只序列化本函数，不携带模块级引用。
 */
export function showOverlay(): void {
  const old = document.getElementById('edg-overlay-root');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const root = document.createElement('div');
  root.id = 'edg-overlay-root';
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  root.style.width = '0';
  root.style.height = '0';
  root.style.zIndex = '2147483647';
  root.style.pointerEvents = 'none';

  const targets = document.querySelectorAll('[data-edg-id]');
  targets.forEach((el) => {
    const id = (el as HTMLElement).getAttribute('data-edg-id');
    if (!id) return;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const badge = document.createElement('div');
    badge.textContent = id;
    badge.style.position = 'absolute';
    badge.style.left = `${Math.round(rect.left + window.scrollX)}px`;
    badge.style.top = `${Math.round(rect.top + window.scrollY)}px`;
    badge.style.background = '#2563eb';
    badge.style.color = '#fff';
    badge.style.font = '11px monospace';
    badge.style.padding = '0 3px';
    badge.style.borderRadius = '3px';
    badge.style.lineHeight = '14px';
    badge.style.pointerEvents = 'none';
    root.appendChild(badge);
  });

  document.documentElement.appendChild(root);
}

export function hideOverlay(): void {
  const old = document.getElementById('edg-overlay-root');
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const cur = document.getElementById('edg-cursor-root');
  if (cur && cur.parentNode) cur.parentNode.removeChild(cur);
  delete (window as unknown as { __edgCursor?: unknown }).__edgCursor;
}

/** Self-contained: creates the on-page cursor element. Inlined into edgAct as well. */
export function cursorShow(): void {
  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);
  { const old = document.getElementById('edg-cursor-root'); if (old && old.parentNode) old.parentNode.removeChild(old); }
  const root = document.createElement('div');
  root.id = 'edg-cursor-root';
  root.style.position = 'fixed';
  root.style.inset = '0';
  root.style.zIndex = '2147483647';
  root.style.pointerEvents = 'none';

  const cur = document.createElement('div');
  cur.id = 'edg-cursor';
  cur.style.position = 'fixed';
  cur.style.width = '22px';
  cur.style.height = '22px';
  cur.style.left = (cx - 4) + 'px';
  cur.style.top = (cy - 2) + 'px';
  cur.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,.4))';
  cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15.5 L11 21 L13.5 19.8 L11 14.5 L16.5 14.5 Z" fill="#111" stroke="#fff" stroke-width="1.2"/></svg>';
  root.appendChild(cur);

  const status = document.createElement('div');
  status.id = 'edg-cursor-status';
  status.style.position = 'fixed';
  status.style.display = 'none';
  status.style.background = 'rgba(17,24,39,.92)';
  status.style.color = '#fff';
  status.style.font = '12px/1.5 sans-serif';
  status.style.padding = '2px 8px';
  status.style.borderRadius = '10px';
  status.style.whiteSpace = 'nowrap';
  status.style.pointerEvents = 'none';
  root.appendChild(status);
  const winStore = window as unknown as { __edgCursor?: { x: number; y: number } };
  document.documentElement.appendChild(root);
  winStore.__edgCursor = { x: cx, y: cy };
}

export interface EdgActArgs {
  id?: number;
  text?: string;
  value?: string;
  direction?: 'up' | 'down' | 'top' | 'bottom';
  x?: number;
  y?: number;
}

export async function edgAct(tool: string, args: EdgActArgs): Promise<{ ok: boolean; info: string; [k: string]: unknown }> {
  const trim = (s: string, n: number): string => {
    const t = (s || '').trim();
    return t.length > n ? t.slice(0, n) : t;
  };

  // Self-contained: persistence is a window-attached store with a known shape.
  const winStore = window as unknown as { __edgCursor?: { x: number; y: number } };
  const ensureCursor = (): { x: number; y: number; cur: HTMLElement; status: HTMLElement; root: HTMLElement } => {
    const existing = winStore.__edgCursor;
    let liveCur = document.getElementById('edg-cursor') as HTMLElement | null;
    let liveStatus = document.getElementById('edg-cursor-status') as HTMLElement | null;
    let liveRoot = document.getElementById('edg-cursor-root') as HTMLElement | null;
    if (existing && liveCur && liveStatus && liveRoot && liveCur.isConnected) {
      return { x: existing.x, y: existing.y, cur: liveCur, status: liveStatus, root: liveRoot };
    }
    const cx = Math.round(window.innerWidth / 2);
    const cy = Math.round(window.innerHeight / 2);
    if (liveRoot && liveRoot.parentNode) liveRoot.parentNode.removeChild(liveRoot);
    const root = document.createElement('div');
    root.id = 'edg-cursor-root';
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';
    const cur = document.createElement('div');
    cur.id = 'edg-cursor';
    cur.style.position = 'fixed';
    cur.style.width = '22px';
    cur.style.height = '22px';
    cur.style.left = (cx - 4) + 'px';
    cur.style.top = (cy - 2) + 'px';
    cur.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,.4))';
    cur.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15.5 L11 21 L13.5 19.8 L11 14.5 L16.5 14.5 Z" fill="#111" stroke="#fff" stroke-width="1.2"/></svg>';
    root.appendChild(cur);
    const status = document.createElement('div');
    status.id = 'edg-cursor-status';
    status.style.position = 'fixed';
    status.style.display = 'none';
    status.style.background = 'rgba(17,24,39,.92)';
    status.style.color = '#fff';
    status.style.font = '12px/1.5 sans-serif';
    status.style.padding = '2px 8px';
    status.style.borderRadius = '10px';
    status.style.pointerEvents = 'none';
    root.appendChild(status);
    document.documentElement.appendChild(root);
    winStore.__edgCursor = { x: cx, y: cy };
    return { x: cx, y: cy, cur, status, root };
  };

  const move = (cur: HTMLElement, state: { x: number; y: number }, tx: number, ty: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      const dx = tx - state.x;
      const dy = ty - state.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dur = Math.max(180, Math.min(600, Math.round(dist * 0.6)));
      const start = performance.now();
      const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      // 后台标签页 rAF 暂停：动画只是视觉效果，超时直接落到终点，不能卡死整个动作
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cur.style.left = (tx - 4) + 'px';
        cur.style.top = (ty - 2) + 'px';
        winStore.__edgCursor = { x: tx, y: ty };
        resolve();
      };
      setTimeout(finish, dur + 800);
      const step = (now: number): void => {
        const elapsed = now - start;
        const t = Math.min(1, elapsed / dur);
        const k = ease(t);
        const nx = state.x + dx * k;
        const ny = state.y + dy * k;
        cur.style.left = (nx - 4) + 'px';
        cur.style.top = (ny - 2) + 'px';
        winStore.__edgCursor = { x: nx, y: ny };
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          finish();
        }
      };
      requestAnimationFrame(step);
    });
  };

  const setStatus = (statusEl: HTMLElement, cur: HTMLElement, text: string): void => {
    if (!text) {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
      return;
    }
    statusEl.textContent = text;
    statusEl.style.display = 'block';
    const r = cur.getBoundingClientRect();
    statusEl.style.left = (r.left + 18) + 'px';
    statusEl.style.top = (r.top + 14) + 'px';
  };

  const ripple = (root: HTMLElement, x: number, y: number): void => {
    const dot = document.createElement('div');
    dot.style.position = 'fixed';
    dot.style.left = (x - 5) + 'px';
    dot.style.top = (y - 5) + 'px';
    dot.style.width = '10px';
    dot.style.height = '10px';
    dot.style.borderRadius = '50%';
    dot.style.background = 'rgba(37,99,235,.6)';
    dot.style.pointerEvents = 'none';
    root.appendChild(dot);
    const anim = dot.animate(
      [
        { transform: 'scale(1)', opacity: 0.7 },
        { transform: 'scale(4)', opacity: 0 },
      ],
      { duration: 450, easing: 'ease-out' },
    );
    anim.onfinish = (): void => {
      if (dot.parentNode) dot.parentNode.removeChild(dot);
    };
  };

  const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

  const byId = (id: number): HTMLElement | null =>
    document.querySelector(`[data-edg-id="${id}"]`) as HTMLElement | null;

  const st = ensureCursor();
  const stateRef = { x: st.x, y: st.y };

  if (tool === 'click') {
    const id = typeof args.id === 'number' ? args.id : -1;
    const el = byId(id);
    if (!el) return { ok: false, info: 'element not found' };
    const tag = el.tagName.toLowerCase();
    const text = trim(
      (el as HTMLElement).innerText || (el as HTMLInputElement).value || '',
      30,
    );
    (el as HTMLElement).scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    await move(st.cur, stateRef, cx, cy);
    setStatus(st.status, st.cur, '点击');
    ripple(st.root, cx, cy);
    await sleep(120);
    (el as HTMLElement).click();
    await sleep(150);
    setStatus(st.status, st.cur, '');
    return { ok: true, info: `clicked <${tag}> "${text}"` };
  }

  if (tool === 'click_at') {
    const fx = typeof args.x === 'number' ? args.x : NaN;
    const fy = typeof args.y === 'number' ? args.y : NaN;
    const x = Math.round(fx * window.innerWidth);
    const y = Math.round(fy * window.innerHeight);
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, info: 'no element at point' };
    const tag = el.tagName.toLowerCase();
    await move(st.cur, stateRef, x, y);
    setStatus(st.status, st.cur, '点击');
    ripple(st.root, x, y);
    const ev = (type: string): MouseEvent =>
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    el.dispatchEvent(ev('pointerdown'));
    el.dispatchEvent(ev('mousedown'));
    el.dispatchEvent(ev('mouseup'));
    el.dispatchEvent(ev('click'));
    await sleep(150);
    setStatus(st.status, st.cur, '');
    return { ok: true, info: `clicked at (${x},${y}) <${tag}>` };
  }

  if (tool === 'type') {
    const id = typeof args.id === 'number' ? args.id : -1;
    const text = typeof args.text === 'string' ? args.text : '';
    const el = byId(id);
    if (!el) return { ok: false, info: 'element not found' };
    const tag = el.tagName.toLowerCase();
    const htmlEl = el as HTMLElement;

    if (htmlEl instanceof HTMLSelectElement) {
      return { ok: false, info: 'use select tool' };
    }

    (htmlEl as HTMLElement).scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = htmlEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    await move(st.cur, stateRef, cx, cy);
    setStatus(st.status, st.cur, '输入');

    if (htmlEl instanceof HTMLInputElement || htmlEl instanceof HTMLTextAreaElement) {
      htmlEl.focus();
      const proto =
        htmlEl instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(htmlEl, text);
      } else {
        htmlEl.value = text;
      }
      htmlEl.dispatchEvent(new Event('input', { bubbles: true }));
      htmlEl.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      setStatus(st.status, st.cur, '');
      return { ok: true, info: `typed "${text}" into <${tag}>` };
    }

    const ceAttr = htmlEl.getAttribute('contenteditable');
    if (ceAttr === '' || ceAttr === 'true') {
      htmlEl.focus();
      htmlEl.innerText = text;
      htmlEl.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(120);
      setStatus(st.status, st.cur, '');
      return { ok: true, info: `typed "${text}" into contenteditable <${tag}>` };
    }

    setStatus(st.status, st.cur, '');
    return { ok: false, info: `unsupported element type <${tag}>` };
  }

  if (tool === 'type_focused') {
    const text = typeof args.text === 'string' ? args.text : '';
    setStatus(st.status, st.cur, '输入');
    const el = document.activeElement as HTMLElement | null;
    if (!el) {
      setStatus(st.status, st.cur, '');
      return { ok: false, info: 'no focused editable element' };
    }
    const tag = el.tagName.toLowerCase();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      const proto =
        el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      setStatus(st.status, st.cur, '');
      return { ok: true, info: `typed "${text}" into focused <${tag}>` };
    }
    const ceAttr = el.getAttribute('contenteditable');
    if (ceAttr === '' || ceAttr === 'true') {
      el.focus();
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setStatus(st.status, st.cur, '');
      return { ok: true, info: `typed "${text}" into focused contenteditable <${tag}>` };
    }
    setStatus(st.status, st.cur, '');
    return { ok: false, info: 'no focused editable element' };
  }

  if (tool === 'select') {
    const id = typeof args.id === 'number' ? args.id : -1;
    const value = typeof args.value === 'string' ? args.value : '';
    const el = byId(id);
    if (!el) return { ok: false, info: 'element not found' };
    if (!(el instanceof HTMLSelectElement)) {
      return { ok: false, info: 'not a select element' };
    }
    (el as HTMLElement).scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    await move(st.cur, stateRef, cx, cy);
    setStatus(st.status, st.cur, '选择');
    const target = value.toLowerCase();
    let matchedIdx = -1;
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if (opt.value === value) {
        matchedIdx = i;
        break;
      }
      const txt = (opt.textContent || '').toLowerCase();
      if (txt.includes(target)) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx < 0) {
      setStatus(st.status, st.cur, '');
      return { ok: false, info: 'option not found' };
    }
    el.selectedIndex = matchedIdx;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setStatus(st.status, st.cur, '');
    const chosen = el.options[matchedIdx];
    return {
      ok: true,
      info: `selected "${chosen.textContent || chosen.value}"`,
    };
  }

  if (tool === 'scroll') {
    const dir = args.direction;
    let label = '滚动';
    if (dir === 'down') {
      window.scrollBy(0, window.innerHeight * 0.8);
      label = '滚动 ↓';
    } else if (dir === 'up') {
      window.scrollBy(0, -window.innerHeight * 0.8);
      label = '滚动 ↑';
    } else if (dir === 'top') {
      window.scrollTo(0, 0);
      label = '滚动到顶部';
    } else if (dir === 'bottom') {
      window.scrollTo(0, document.body.scrollHeight);
      label = '滚动到底部';
    } else {
      return { ok: false, info: `unknown direction ${String(dir)}` };
    }
    setStatus(st.status, st.cur, label);
    await sleep(500);
    setStatus(st.status, st.cur, '');
    return {
      ok: true,
      info: `scrolled ${String(dir)} y=${Math.round(window.scrollY)}`,
    };
  }


  // ---- CDP prep / utility branches (self-contained, zero module-level refs) ----

  if (tool === 'click_prep') {
    const id = typeof args.id === 'number' ? args.id : -1;
    const el = byId(id);
    if (!el) return { ok: false, info: 'element not found' };
    (window as unknown as { __edgCtx?: Element }).__edgCtx = el;
    const tag = el.tagName.toLowerCase();
    const text = trim(
      (el as HTMLElement).innerText || (el as HTMLInputElement).value || '',
      30,
    );
    (el as HTMLElement).scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    await move(st.cur, stateRef, cx, cy);
    setStatus(st.status, st.cur, '点击');
    ripple(st.root, cx, cy);
    return { ok: true, x: cx, y: cy, tag, text, info: `clicked <${tag}> "${text}"` };
  }

  if (tool === 'click_at_prep') {
    const fx = typeof args.x === 'number' ? args.x : NaN;
    const fy = typeof args.y === 'number' ? args.y : NaN;
    const x = Math.round(fx * window.innerWidth);
    const y = Math.round(fy * window.innerHeight);
    const el = document.elementFromPoint(x, y);
    if (!el) return { ok: false, info: 'no element at point' };
    (window as unknown as { __edgCtx?: Element }).__edgCtx = el;
    const tag = el.tagName.toLowerCase();
    await move(st.cur, stateRef, x, y);
    setStatus(st.status, st.cur, '点击');
    ripple(st.root, x, y);
    return { ok: true, x, y, tag, info: `clicked at (${x},${y}) <${tag}>` };
  }

  if (tool === 'type_prep') {
    const id = typeof args.id === 'number' ? args.id : -1;
    const text = typeof args.text === 'string' ? args.text : '';
    const el = byId(id);
    if (!el) return { ok: false, info: 'element not found' };
    (window as unknown as { __edgCtx?: Element }).__edgCtx = el;
    const tag = el.tagName.toLowerCase();
    const htmlEl = el as HTMLElement;
    if (htmlEl instanceof HTMLSelectElement) {
      return { ok: false, info: 'use select tool' };
    }
    (htmlEl as HTMLElement).scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = htmlEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    await move(st.cur, stateRef, cx, cy);
    setStatus(st.status, st.cur, '输入');
    if (
      htmlEl instanceof HTMLInputElement ||
      htmlEl instanceof HTMLTextAreaElement
    ) {
      htmlEl.focus();
      return { ok: true, editable: true, tag, info: `typed "${text}" into <${tag}>` };
    }
    const ceAttr = htmlEl.getAttribute('contenteditable');
    if (ceAttr === '' || ceAttr === 'true') {
      htmlEl.focus();
      return { ok: true, editable: true, tag, info: `typed "${text}" into contenteditable <${tag}>` };
    }
    return { ok: false, info: `unsupported element type <${tag}>` };
  }

  if (tool === 'upload_prep') {
    const id = typeof args.id === 'number' ? args.id : -1;
    const el = byId(id);
    if (!el) return { ok: false, info: 'element not found' };
    (window as unknown as { __edgCtx?: Element }).__edgCtx = el;
    const tag = el.tagName.toLowerCase();
    const text = trim(
      (el as HTMLElement).innerText || (el as HTMLInputElement).value || '',
      30,
    );
    (el as HTMLElement).scrollIntoView({ block: 'center' });
    await sleep(200);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    await move(st.cur, stateRef, cx, cy);
    setStatus(st.status, st.cur, '上传文件');

    // 目标本身就是可见 file input：直接 DOM.setFileInputFiles，无需点击
    if (el instanceof HTMLInputElement && el.type === 'file') {
      return { ok: true, kind: 'input', tag, text, info: `upload target <input type=file> "${text}"` };
    }

    // 触发器（按钮/拖拽区里的链接等）：找到它背后的隐藏 file input 并打标，
    // 由 CDP 点击触发 + 拦截文件选择框后按标记喂文件。
    const findFileInput = (start: HTMLElement): HTMLInputElement | null => {
      const direct = start.querySelector('input[type="file"]');
      if (direct) return direct as HTMLInputElement;
      const label = start.closest('label');
      if (label) {
        const inLabel = label.querySelector('input[type="file"]');
        if (inLabel) return inLabel as HTMLInputElement;
      }
      const form = start.closest('form');
      if (form) {
        const inForm = form.querySelector('input[type="file"]');
        if (inForm) return inForm as HTMLInputElement;
      }
      const all = document.querySelectorAll('input[type="file"]');
      if (all.length === 1) return all[0] as HTMLInputElement;
      return null;
    };
    const input = findFileInput(el as HTMLElement);
    if (!input) {
      // 纯拖拽区：造影子 file input，DOM.setFileInputFiles 喂文件后 JS 侧拿到真 File，
      // 再由 upload_drop 合成 dragenter/dragover/drop 事件派发到该区域。
      document.querySelectorAll('input[data-edg-shadow]').forEach((n) => n.remove());
      const shadow = document.createElement('input');
      shadow.type = 'file';
      shadow.multiple = true;
      shadow.style.display = 'none';
      shadow.setAttribute('data-edg-upload', '1');
      shadow.setAttribute('data-edg-shadow', '1');
      document.body.appendChild(shadow);
      ripple(st.root, cx, cy);
      return { ok: true, kind: 'drop', x: cx, y: cy, tag, text, info: `drop-upload <${tag}> "${text}"` };
    }
    document.querySelectorAll('[data-edg-upload]').forEach((n) => n.removeAttribute('data-edg-upload'));
    input.setAttribute('data-edg-upload', '1');
    ripple(st.root, cx, cy);
    return { ok: true, kind: 'trigger', x: cx, y: cy, tag, text, info: `upload via trigger <${tag}> "${text}"` };
  }

  if (tool === 'upload_drop') {
    // 拖拽落文件：从影子 input 取 File → DataTransfer → 合成事件序列。
    // 目标是 upload_prep 记下的 __edgCtx（拖拽区元素），不在/不连通时退回坐标命中。
    const shadow = document.querySelector('input[data-edg-shadow]') as HTMLInputElement | null;
    if (!shadow || !shadow.files || shadow.files.length === 0) {
      return { ok: false, info: 'shadow input 无文件（setFileInputFiles 未成功？）' };
    }
    const ctxStore = window as unknown as { __edgCtx?: Element };
    const ctxEl = ctxStore.__edgCtx as HTMLElement | undefined;
    const zone =
      ctxEl && ctxEl.isConnected
        ? ctxEl
        : (document.elementFromPoint(
            typeof args.x === 'number' ? args.x : 0,
            typeof args.y === 'number' ? args.y : 0,
          ) as HTMLElement | null);
    if (!zone) {
      shadow.remove();
      return { ok: false, info: 'no drop target' };
    }
    const files = Array.from(shadow.files);
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const cx = typeof args.x === 'number' ? args.x : 0;
    const cy = typeof args.y === 'number' ? args.y : 0;
    const mk = (type: string): DragEvent =>
      new DragEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt });
    zone.dispatchEvent(mk('dragenter'));
    zone.dispatchEvent(mk('dragover'));
    zone.dispatchEvent(mk('drop'));
    shadow.remove();
    await sleep(150);
    setStatus(st.status, st.cur, '');
    return {
      ok: true,
      info: `已拖入 ${files.length} 个文件到 <${zone.tagName.toLowerCase()}>: ${files.map((f) => f.name).join(', ')}`,
    };
  }

  if (tool === 'action_done') {
    await sleep(150);
    setStatus(st.status, st.cur, '');
    return { ok: true, info: 'done' };
  }

  if (tool === 'viewport_size') {
    return { ok: true, w: window.innerWidth, h: window.innerHeight, info: 'viewport' };
  }
  return { ok: false, info: `unknown tool ${tool}` };
}