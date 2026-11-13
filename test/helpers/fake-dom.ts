/**
 * A tiny DOM stand-in for unit tests that exercise Obsidian's HTMLElement
 * helpers. It implements only the surface the chat UI touches: element
 * creation, classes, attributes, text, children, and simple selectors.
 */

export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();
  private readonly classes = new Set<string>();
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private ownText = "";
  parentElement: FakeElement | null = null;

  constructor(readonly tagName: string) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get classList(): {
    add: (...values: string[]) => void;
    remove: (...values: string[]) => void;
    contains: (value: string) => boolean;
    toggle: (value: string, force?: boolean) => boolean;
    toString: () => string;
  } {
    return {
      add: (...values) => values.forEach((value) => this.classes.add(value)),
      remove: (...values) => values.forEach((value) => this.classes.delete(value)),
      contains: (value) => this.classes.has(value),
      toggle: (value, force) => {
        const next = force ?? !this.classes.has(value);
        if (next) this.classes.add(value);
        else this.classes.delete(value);
        return next;
      },
      toString: () => [...this.classes].join(" "),
    };
  }

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const part of value.split(/\s+/)) if (part) this.classes.add(part);
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.splice(0);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null;
  }

  get scrollHeight(): number {
    return this.children.length;
  }

  get clientHeight(): number {
    return this.children.length;
  }

  scrollTop = 0;

  createDiv(options: { cls?: string | string[]; text?: string } = {}): FakeElement {
    return this.createEl("div", options);
  }

  createSpan(options: { cls?: string | string[]; text?: string } = {}): FakeElement {
    return this.createEl("span", options);
  }

  createEl(
    tagName: string,
    options: { cls?: string | string[]; text?: string; attr?: Record<string, string> } = {},
  ): FakeElement {
    const child = new FakeElement(tagName);
    const classes = Array.isArray(options.cls)
      ? options.cls
      : options.cls
        ? options.cls.split(/\s+/).filter(Boolean)
        : [];
    for (const cls of classes) child.classes.add(cls);
    if (options.text) child.ownText = options.text;
    for (const [name, value] of Object.entries(options.attr ?? {})) child.attributes.set(name, value);
    this.appendChild(child);
    return child;
  }

  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    child.remove();
    child.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  replaceWith(next: FakeElement): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children[index] = next;
    next.parentElement = parent;
    this.parentElement = null;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children.splice(0)) child.parentElement = null;
    for (const node of nodes) this.appendChild(node);
  }

  empty(): void {
    for (const child of this.children.splice(0)) child.parentElement = null;
    this.ownText = "";
  }

  appendText(text: string): void {
    this.ownText += text;
  }

  setText(text: string): void {
    this.textContent = text;
  }

  addClass(value: string): void {
    this.classes.add(value);
  }

  removeClass(value: string): void {
    this.classes.delete(value);
  }

  removeClasses(values: string[]): void {
    for (const value of values) this.classes.delete(value);
  }

  toggleClass(value: string, force?: boolean): boolean {
    const next = force ?? !this.classes.has(value);
    if (next) this.classes.add(value);
    else this.classes.delete(value);
    return next;
  }

  hasClass(value: string): boolean {
    return this.classes.has(value);
  }

  setAttr(name: string, value: string | number | boolean | null): void {
    this.attributes.set(name, String(value));
  }

  setAttrs(values: Record<string, string | number | boolean | null>): void {
    for (const [name, value] of Object.entries(values)) this.setAttr(name, value);
  }

  getAttr(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  /** Stable structural snapshot for equality checks. */
  snapshot(): string {
    const attrs = [...this.attributes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(",");
    const classes = [...this.classes].sort().join(".");
    const children = this.children.map((child) => child.snapshot()).join("");
    return `${this.localName}.${classes}[${attrs}](${JSON.stringify(this.ownText)}${children})`;
  }

  focus(): void {
    // Focus is not tracked; tests only need the call to exist.
  }

  closest(selector: string): FakeElement | null {
    if (!selector.startsWith(".")) return null;
    const classes = selector.slice(1).split(".").filter(Boolean);
    let current: FakeElement | null = this;
    while (current) {
      if (classes.every((cls) => current?.classes.has(cls))) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const all = [...this.walk()];
    const trimmed = selector.trim();
    if (trimmed.includes(">")) {
      const [parentSelector, childSelector] = trimmed.split(">").map((part) => part.trim());
      return all.filter((el) => matches(el, childSelector) && el.parentElement !== null && matches(el.parentElement, parentSelector));
    }
    if (trimmed.includes(" ")) {
      const parts = trimmed.split(/\s+/);
      const last = parts.pop() ?? "";
      return all.filter((el) => {
        if (!matches(el, last)) return false;
        let ancestor = el.parentElement;
        let index = parts.length - 1;
        while (ancestor && index >= 0) {
          if (matches(ancestor, parts[index])) index -= 1;
          ancestor = ancestor.parentElement;
        }
        return index < 0;
      });
    }
    return all.filter((el) => matches(el, trimmed));
  }

  private *walk(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

function matches(element: FakeElement, selector: string): boolean {
  if (!selector) return false;
  if (selector === "*") return true;
  if (selector.startsWith(".")) {
    return selector
      .split(".")
      .filter(Boolean)
      .every((cls) => element.hasClass(cls));
  }
  const [tag, ...classParts] = selector.split(".");
  if (tag && element.localName !== tag.toLowerCase()) return false;
  return classParts.filter(Boolean).every((cls) => element.hasClass(cls));
}

export function fakeElement(tagName = "div"): FakeElement {
  return new FakeElement(tagName);
}
