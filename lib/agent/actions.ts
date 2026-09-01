// Self-contained: must NOT import any module. Injected into page via executeScript.

interface ElInfo {
  id: number;
  tag: string;
  role: string | null;
  text: string;
  type: string | null;
  placeholder: string | null;
  href: string | null;
  options?: string[];
}

interface PageSnapshot {
  url: string;
  title: string;
  elements: ElInfo[];
  pageText: string;
}

export function domSnapshot(): PageSnapshot {
  const trim = (s: string, n: number): string => {
    const t = (s || '').trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  // Clear stale markers
  const stale = document.querySelectorAll('[data-edg-id]');
  stale.forEach((n) => n.removeAttribute('data-edg-id'));

  const elements: ElInfo[] = [];
  const candidates = document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="combobox"], [role="textbox"], [contenteditable=""], [contenteditable="true"], [onclick]');

  let nextId = 1;
  for (let i = 0; i < candidates.length && elements.length < 150; i++) {
    const el = candidates[i] as HTMLElement;
    const rects = el.getClientRects();
    if (rects.length === 0) continue;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;

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
    const text = trim(rawText, 60);

    const info: ElInfo = {
      id: nextId,
      tag,
      role: role || null,
      text,
      type: type || null,
      placeholder: placeholder || null,
      href: href || null,
    };

    if (tag === 'select') {
      const opts: string[] = [];
      const sel = el as HTMLSelectElement;
      for (let j = 0; j < sel.options.length && opts.length < 8; j++) {
        opts.push(trim(sel.options[j].textContent || sel.options[j].value || '', 20));
      }
      info.options = opts;
    }

    el.setAttribute('data-edg-id', String(nextId));
    elements.push(info);
    nextId++;
  }

  const main =
    (document.querySelector('main, article') as HTMLElement | null) ||
    (document.body as HTMLElement | null);
  const rawPageText = main ? main.innerText : '';
  const pageText = trim((rawPageText || '').replace(/\s+/g, ' ').trim(), 2000);

  return {
    url: location.href,
    title: document.title,
    elements,
    pageText,
  };
}


export function showOverlay(): void {
  { const old = document.getElementById('edg-overlay-root'); if (old && old.parentNode) old.parentNode.removeChild(old); }
  const root = document.createElement('div');
  root.id = 'edg-overlay-root';
  root.style.position = 'fixed';
  root.style.inset = '0';
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
    badge.style.position = 'fixed';
    badge.style.left = `${Math.round(rect.left)}px`;
    badge.style.top = `${Math.round(rect.top)}px`;
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
}

export function actClick(id: number): { ok: boolean; info: string } {
  const trim = (s: string, n: number): string => {
    const t = (s || '').trim();
    return t.length > n ? t.slice(0, n) : t;
  };
  const el = document.querySelector(`[data-edg-id="${id}"]`);
  if (!el) return { ok: false, info: 'element not found' };
  const tag = el.tagName.toLowerCase();
  const text = trim(
    (el as HTMLElement).innerText || (el as HTMLInputElement).value || '',
    30,
  );
  (el as HTMLElement).scrollIntoView({ block: 'center' });
  (el as HTMLElement).click();
  return { ok: true, info: `clicked <${tag}> "${text}"` };
}

export function actType(
  id: number,
  text: string,
): { ok: boolean; info: string } {
  const el = document.querySelector(`[data-edg-id="${id}"]`);
  if (!el) return { ok: false, info: 'element not found' };
  const tag = el.tagName.toLowerCase();
  const htmlEl = el as HTMLElement;

  if (htmlEl instanceof HTMLSelectElement) {
    return { ok: false, info: 'use select tool' };
  }

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
    return { ok: true, info: `typed "${text}" into <${tag}>` };
  }

  const ceAttr = htmlEl.getAttribute('contenteditable');
  if (ceAttr === '' || ceAttr === 'true') {
    htmlEl.focus();
    htmlEl.innerText = text;
    htmlEl.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, info: `typed "${text}" into contenteditable <${tag}>` };
  }

  return { ok: false, info: `unsupported element type <${tag}>` };
}

export function actSelect(
  id: number,
  value: string,
): { ok: boolean; info: string } {
  const el = document.querySelector(`[data-edg-id="${id}"]`);
  if (!el) return { ok: false, info: 'element not found' };
  if (!(el instanceof HTMLSelectElement)) {
    return { ok: false, info: 'not a select element' };
  }
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
  if (matchedIdx < 0) return { ok: false, info: 'option not found' };
  el.selectedIndex = matchedIdx;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const chosen = el.options[matchedIdx];
  return {
    ok: true,
    info: `selected "${chosen.textContent || chosen.value}"`,
  };
}

export function actScroll(
  direction: 'up' | 'down' | 'top' | 'bottom',
): { ok: boolean; info: string } {
  if (direction === 'down') {
    window.scrollBy(0, window.innerHeight * 0.8);
  } else if (direction === 'up') {
    window.scrollBy(0, -window.innerHeight * 0.8);
  } else if (direction === 'top') {
    window.scrollTo(0, 0);
  } else if (direction === 'bottom') {
    window.scrollTo(0, document.body.scrollHeight);
  } else {
    return { ok: false, info: `unknown direction ${direction}` };
  }
  return {
    ok: true,
    info: `scrolled ${direction} y=${Math.round(window.scrollY)}`,
  };
}