/**
 * Small DOM helpers. No framework: the app has three screens and a render
 * loop, and a framework would be more code than the thing it manages.
 */

type Child = Node | string | number | null | undefined | false;

interface Attributes {
  class?: string;
  id?: string;
  type?: string;
  href?: string;
  title?: string;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  hidden?: boolean;
  role?: string;
  style?: string;
  accept?: string;
  min?: string;
  max?: string;
  step?: string;
  inputmode?: string;
  autocomplete?: string;
  enterkeyhint?: string;
  rows?: string;
  selected?: boolean;
  multiple?: boolean;
  tabindex?: string;
  name?: string;
  checked?: boolean;
  [key: `data-${string}`]: string | undefined;
  [key: `aria-${string}`]: string | undefined;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  event: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  node.addEventListener(event, handler);
}

export function button(
  label: Child,
  className: string,
  onClick: () => void,
  attributes: Attributes = {},
): HTMLButtonElement {
  const node = el('button', { class: className, type: 'button', ...attributes }, label);
  node.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}

/** Trigger a file download from in-memory text. */
export function downloadText(fileName: string, mimeType: string, text: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoking immediately can cancel the download on some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Copy text, falling back to a hidden textarea.
 *
 * `navigator.clipboard` needs a secure context and is not always available in
 * an iOS home screen web app, and losing a shoot log to a silently failing
 * copy button is worth the fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function formatTimestamp(value: number): string {
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateOnly(value: number): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
