type Child = Node | string | number | null | undefined | false;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], 'children' | 'style' | 'className'>
> & { class?: string };

/**
 * Builds an element. Text always goes in as a text node, never as HTML, so
 * nothing received over the air can inject markup into the page.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props<K> | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    const { class: className, ...rest } = props;
    if (className) el.className = className;
    Object.assign(el, rest);
  }
  fill(el, children);
  return el;
}

export function fill(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

/** Sets text only when it has changed, so unchanged parts of the page stay untouched. */
export function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export function download(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  const a = h('a', { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
