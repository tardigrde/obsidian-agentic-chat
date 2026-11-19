/**
 * The `obsidian` module for the `ui` vitest project (happy-dom). It re-exports
 * the plain mock and replaces the parts that touch the DOM: Component lifecycle,
 * ItemView and Modal elements, setIcon, Notice, and a small markdown renderer.
 *
 * Obsidian's element helpers (createDiv, addClass, setText, ...) are prototype
 * patches, installed once by `installObsidianDom()` from test/ui/support/setup.ts.
 *
 * Keep it small and faithful: a helper behaves like Obsidian's, or it is absent.
 */
export * from "../../mocks/obsidian";

type Cleanup = () => void;

export interface EventRef {
  off(): void;
}

interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  value?: string;
  type?: string;
  href?: string;
  placeholder?: string;
  prepend?: boolean;
  parent?: Node;
}

function applyInfo(el: HTMLElement, info: DomElementInfo | string | undefined): void {
  if (info === undefined) return;
  const options: DomElementInfo = typeof info === "string" ? { cls: info } : info;
  if (options.cls) {
    const classes = Array.isArray(options.cls) ? options.cls : options.cls.split(/\s+/);
    el.classList.add(...classes.filter(Boolean));
  }
  if (options.text !== undefined) {
    if (typeof options.text === "string") el.textContent = options.text;
    else el.appendChild(options.text);
  }
  if (options.attr) {
    for (const [name, value] of Object.entries(options.attr)) {
      if (value === null || value === false) continue;
      el.setAttribute(name, value === true ? "" : String(value));
    }
  }
  if (options.title !== undefined) el.title = options.title;
  if (options.value !== undefined) (el as HTMLInputElement).value = options.value;
  if (options.type !== undefined) el.setAttribute("type", options.type);
  if (options.href !== undefined) el.setAttribute("href", options.href);
  if (options.placeholder !== undefined) el.setAttribute("placeholder", options.placeholder);
}

function createElIn<K extends keyof HTMLElementTagNameMap>(
  parent: Node | null,
  tag: K,
  info?: DomElementInfo | string,
  callback?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyInfo(el, info);
  const options = typeof info === "object" ? info : undefined;
  // `document.createDiv()` makes a detached element; a document has one root.
  const target = options?.parent ?? (parent?.nodeType === 9 ? null : parent);
  if (target) {
    if (options?.prepend) target.insertBefore(el, target.firstChild);
    else target.appendChild(el);
  }
  callback?.(el);
  return el;
}

let installed = false;

/** Patch happy-dom's prototypes with the Obsidian element helpers the plugin uses. */
export function installObsidianDom(): void {
  if (installed) return;
  installed = true;
  const nodeProto = Node.prototype as unknown as Record<string, unknown>;
  const elementProto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const define = (proto: Record<string, unknown>, name: string, value: unknown) => {
    Object.defineProperty(proto, name, { configurable: true, writable: true, value });
  };

  define(nodeProto, "createEl", function (this: Node, tag: keyof HTMLElementTagNameMap, info?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
    return createElIn(this, tag, info, cb);
  });
  define(nodeProto, "createDiv", function (this: Node, info?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
    return createElIn(this, "div", info, cb);
  });
  define(nodeProto, "createSpan", function (this: Node, info?: DomElementInfo | string, cb?: (el: HTMLElement) => void) {
    return createElIn(this, "span", info, cb);
  });
  define(nodeProto, "createSvg", function (this: Node, tag: string, info?: DomElementInfo | string, cb?: (el: SVGElement) => void) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag) as unknown as HTMLElement;
    applyInfo(el, info);
    const options = typeof info === "object" ? info : undefined;
    const target = options?.parent ?? (this.nodeType === 9 ? null : this);
    target?.appendChild(el);
    cb?.(el as unknown as SVGElement);
    return el;
  });
  define(nodeProto, "empty", function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  define(nodeProto, "detach", function (this: Node) {
    this.parentNode?.removeChild(this);
  });
  define(nodeProto, "appendText", function (this: Node, text: string) {
    this.appendChild(document.createTextNode(text));
  });
  define(nodeProto, "instanceOf", function (this: Node, type: new (...args: never[]) => unknown) {
    return this instanceof type;
  });
  define(Event.prototype as unknown as Record<string, unknown>, "instanceOf", function (this: Event, type: new (...args: never[]) => unknown) {
    return this instanceof type;
  });

  define(elementProto, "addClass", function (this: HTMLElement, ...classes: string[]) {
    this.classList.add(...classes);
  });
  define(elementProto, "addClasses", function (this: HTMLElement, classes: string[]) {
    this.classList.add(...classes);
  });
  define(elementProto, "removeClass", function (this: HTMLElement, ...classes: string[]) {
    this.classList.remove(...classes);
  });
  define(elementProto, "removeClasses", function (this: HTMLElement, classes: string[]) {
    this.classList.remove(...classes);
  });
  define(elementProto, "toggleClass", function (this: HTMLElement, classes: string | string[], value: boolean) {
    for (const cls of Array.isArray(classes) ? classes : [classes]) this.classList.toggle(cls, value);
  });
  define(elementProto, "hasClass", function (this: HTMLElement, cls: string) {
    return this.classList.contains(cls);
  });
  define(elementProto, "setText", function (this: HTMLElement, text: string | DocumentFragment) {
    if (typeof text === "string") this.textContent = text;
    else {
      this.textContent = "";
      this.appendChild(text);
    }
  });
  define(elementProto, "setAttr", function (this: HTMLElement, name: string, value: string | number | boolean | null) {
    if (value === null) this.removeAttribute(name);
    else this.setAttribute(name, String(value));
  });
  define(elementProto, "setAttrs", function (this: HTMLElement, attrs: Record<string, string | number | boolean | null>) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null) this.removeAttribute(name);
      else this.setAttribute(name, String(value));
    }
  });
  define(elementProto, "getAttr", function (this: HTMLElement, name: string) {
    return this.getAttribute(name);
  });
  define(elementProto, "find", function (this: HTMLElement, selector: string) {
    return this.querySelector(selector);
  });
  define(elementProto, "findAll", function (this: HTMLElement, selector: string) {
    return Array.from(this.querySelectorAll(selector));
  });
  define(elementProto, "show", function (this: HTMLElement) {
    this.style.display = "";
  });
  define(elementProto, "hide", function (this: HTMLElement) {
    this.style.display = "none";
  });
  define(elementProto, "toggle", function (this: HTMLElement, show: boolean) {
    this.style.display = show ? "" : "none";
  });
  define(elementProto, "isShown", function (this: HTMLElement) {
    return this.style.display !== "none";
  });
  define(elementProto, "setCssStyles", function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  });
  define(elementProto, "setCssProps", function (this: HTMLElement, props: Record<string, string>) {
    for (const [name, value] of Object.entries(props)) this.style.setProperty(name, value);
  });

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.createEl = (tag: keyof HTMLElementTagNameMap, info?: DomElementInfo | string, cb?: (el: HTMLElement) => void) =>
    createElIn(null, tag, info, cb);
  globals.createDiv = (info?: DomElementInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, "div", info, cb);
  globals.createSpan = (info?: DomElementInfo | string, cb?: (el: HTMLElement) => void) => createElIn(null, "span", info, cb);
  globals.createFragment = (cb?: (fragment: DocumentFragment) => void) => {
    const fragment = document.createDocumentFragment();
    cb?.(fragment);
    return fragment;
  };
  globals.activeDocument = document;
  globals.activeWindow = window;
}

/** Obsidian's Component: children, registered cleanups, load/unload. */
export class Component {
  private cleanups: Cleanup[] = [];
  private childComponents: Component[] = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    for (const child of this.childComponents) child.load();
  }

  onload(): void {
    // Subclass hook.
  }

  unload(): void {
    if (!this.loaded) return;
    this.loaded = false;
    for (const child of this.childComponents.splice(0)) child.unload();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    this.onunload();
  }

  onunload(): void {
    // Subclass hook.
  }

  addChild<T extends Component>(child: T): T {
    this.childComponents.push(child);
    if (this.loaded) child.load();
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    const index = this.childComponents.indexOf(child);
    if (index >= 0) {
      this.childComponents.splice(index, 1);
      child.unload();
    }
    return child;
  }

  register(cleanup: Cleanup): void {
    this.cleanups.push(cleanup);
  }

  registerEvent(ref: EventRef): void {
    this.cleanups.push(() => ref.off());
  }

  registerDomEvent(el: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void {
    el.addEventListener(type, handler, options);
    this.cleanups.push(() => el.removeEventListener(type, handler, options));
  }

  registerInterval(id: number): number {
    this.cleanups.push(() => window.clearInterval(id));
    return id;
  }
}

export class WorkspaceLeaf {
  view: unknown = null;
  constructor(readonly app: unknown) {}
}

/** Obsidian's ItemView: a leaf, its app, and a mounted `.view-content` element. */
export class ItemView extends Component {
  readonly app: unknown;
  readonly containerEl: HTMLElement;
  readonly contentEl: HTMLElement;

  constructor(readonly leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    leaf.view = this;
    this.containerEl = createElIn(document.body, "div", { cls: "workspace-leaf-content" });
    createElIn(this.containerEl, "div", { cls: "view-header" });
    this.contentEl = createElIn(this.containerEl, "div", { cls: "view-content" });
  }
}

type KeyHandler = (event: KeyboardEvent) => boolean | void;

/** Obsidian's Scope: key handlers that run while their owner (a modal) is open. */
export class Scope {
  private readonly handlers: Array<{ modifiers: string[]; key: string | null; handler: KeyHandler }> = [];

  register(modifiers: string[] | null, key: string | null, handler: KeyHandler): unknown {
    const entry = { modifiers: modifiers ?? [], key, handler };
    this.handlers.push(entry);
    return entry;
  }

  /** Run the first matching handler; a handler that returns false consumes the key. */
  handle(event: KeyboardEvent): boolean {
    const modifiers = { Mod: event.ctrlKey || event.metaKey, Shift: event.shiftKey, Alt: event.altKey };
    for (const entry of this.handlers) {
      if (entry.key !== null && entry.key !== event.key) continue;
      const wanted = new Set(entry.modifiers);
      if ((["Mod", "Shift", "Alt"] as const).some((name) => wanted.has(name) !== modifiers[name])) continue;
      if (entry.handler(event) === false) return true;
    }
    return false;
  }
}

/** Obsidian's Modal: a container in document.body while open; onOpen/onClose hooks. */
export class Modal {
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  scope = new Scope();
  isOpen = false;
  private readonly onKeydown = (event: KeyboardEvent) => {
    if (this.scope.handle(event)) return;
    if (event.key === "Escape") this.close();
  };

  constructor(readonly app?: unknown) {
    this.containerEl = createElIn(null, "div", { cls: "modal-container" });
    this.modalEl = createElIn(this.containerEl, "div", { cls: "modal" });
    const closeButton = createElIn(this.modalEl, "div", { cls: "modal-close-button" });
    closeButton.addEventListener("click", () => this.close());
    this.titleEl = createElIn(this.modalEl, "div", { cls: "modal-title" });
    this.contentEl = createElIn(this.modalEl, "div", { cls: "modal-content" });
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    document.body.appendChild(this.containerEl);
    document.addEventListener("keydown", this.onKeydown);
    this.onOpen();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener("keydown", this.onKeydown);
    this.containerEl.remove();
    this.onClose();
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  onOpen(): void {
    // Subclass hook.
  }

  onClose(): void {
    // Subclass hook.
  }
}

export class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    this.buttonEl = createElIn(containerEl, "button");
  }
  setButtonText(name: string): this {
    this.buttonEl.textContent = name;
    return this;
  }
  setClass(cls: string): this {
    this.buttonEl.classList.add(cls);
    return this;
  }
  setCta(): this {
    return this.setClass("mod-cta");
  }
  setWarning(): this {
    return this.setClass("mod-warning");
  }
  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }
  setTooltip(tooltip: string): this {
    this.buttonEl.setAttribute("aria-label", tooltip);
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    return this;
  }
  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (event) => void callback(event));
    return this;
  }
}

export class ToggleComponent {
  readonly toggleEl: HTMLElement;
  private value = false;
  private changed: ((value: boolean) => unknown) | null = null;
  constructor(containerEl: HTMLElement) {
    this.toggleEl = createElIn(containerEl, "div", { cls: "checkbox-container" });
    this.toggleEl.addEventListener("click", () => this.setValue(!this.value, true));
  }
  getValue(): boolean {
    return this.value;
  }
  setValue(on: boolean, notify = false): this {
    this.value = on;
    this.toggleEl.classList.toggle("is-enabled", on);
    if (notify) void this.changed?.(on);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.toggleEl.classList.toggle("is-disabled", disabled);
    return this;
  }
  onChange(callback: (value: boolean) => unknown): this {
    this.changed = callback;
    return this;
  }
}

/** Obsidian's Setting row: name, description, and controls. */
export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.settingEl = createElIn(containerEl, "div", { cls: "setting-item" });
    this.infoEl = createElIn(this.settingEl, "div", { cls: "setting-item-info" });
    this.nameEl = createElIn(this.infoEl, "div", { cls: "setting-item-name" });
    this.descEl = createElIn(this.infoEl, "div", { cls: "setting-item-description" });
    this.controlEl = createElIn(this.settingEl, "div", { cls: "setting-item-control" });
  }
  setName(name: string | DocumentFragment): this {
    if (typeof name === "string") this.nameEl.textContent = name;
    else this.nameEl.appendChild(name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    if (typeof desc === "string") this.descEl.textContent = desc;
    else this.descEl.appendChild(desc);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setHeading(): this {
    return this.setClass("setting-item-heading");
  }
  addButton(cb: (component: ButtonComponent) => unknown): this {
    cb(new ButtonComponent(this.controlEl));
    return this;
  }
  addToggle(cb: (component: ToggleComponent) => unknown): this {
    cb(new ToggleComponent(this.controlEl));
    return this;
  }
}

/** Every Notice shown in this test file, oldest first. Reset in setup between tests. */
export const shownNotices: string[] = [];

export class Notice {
  noticeEl: HTMLElement;
  constructor(public message: string | DocumentFragment) {
    this.noticeEl = createElIn(null, "div", { cls: "notice" });
    shownNotices.push(typeof message === "string" ? message : (message.textContent ?? ""));
  }
  setMessage(message: string): this {
    this.message = message;
    shownNotices.push(message);
    return this;
  }
  hide(): void {
    // Notices are not mounted in tests.
  }
}

/** Real Obsidian renders a lucide SVG; keep the class names selectors rely on. */
export function setIcon(parent: HTMLElement, iconId: string): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `svg-icon lucide-${iconId}`);
  parent.appendChild(svg);
}

function renderInline(parent: HTMLElement, text: string): void {
  // Code spans first: their content is literal (no images, no links).
  const pattern = /(`[^`]+`)|!\[([^\]]*)\]\(([^)\s]+)\)|!\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    if (match[1]) createElIn(parent, "code", { text: match[1].slice(1, -1) });
    else if (match[3] !== undefined) createElIn(parent, "img", { attr: { src: match[3], alt: match[2] } });
    else if (match[4] !== undefined) createElIn(parent, "span", { cls: "internal-embed is-unresolved", attr: { src: match[4] } });
    else createElIn(parent, "a", { text: match[5], attr: { href: match[6] } });
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

/**
 * A small CommonMark subset: fenced code, blockquotes, paragraphs, code spans,
 * images, wiki embeds, and links. Enough for rendering checks; not a parser.
 */
export class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, el: HTMLElement, _sourcePath?: string, _component?: unknown): Promise<void> {
    const blocks = markdown.split(/\n{2,}/);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const fence = /^```(\w*)\n([\s\S]*?)\n?```$/.exec(block.trim());
      if (fence) {
        const pre = createElIn(el, "pre");
        createElIn(pre, "code", { cls: fence[1] ? `language-${fence[1]}` : undefined, text: fence[2] });
        continue;
      }
      if (block.startsWith(">")) {
        const quote = createElIn(el, "blockquote");
        renderInline(createElIn(quote, "p"), block.replace(/^>\s?/gm, ""));
        continue;
      }
      if (block.trim()) renderInline(createElIn(el, "p"), block.trim());
    }
  }
}
