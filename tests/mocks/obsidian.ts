/** Minimal mock of the Obsidian API for unit and integration testing. */

export class FileSystemAdapter {
  constructor(private basePath: string) {}
  getBasePath(): string {
    return this.basePath;
  }
}

export class TFile {
  path = "";
}

export class MarkdownView {
  file: TFile | null = null;
  editor: unknown = null;
}

export class Notice {
  static messages: string[] = [];
  message: string;
  constructor(message: string, _timeout?: number) {
    this.message = message;
    Notice.messages.push(message);
  }
  setMessage(message: string): this {
    this.message = message;
    return this;
  }
  hide(): void {}
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface MockElement {
  cls?: string;
  text: string;
  hidden: boolean;
  classes: Set<string>;
  style: Record<string, string>;
  onclick: (() => void) | null;
  children: MockElement[];
  empty(): void;
  setText(t: string): void;
  addClass(...cls: string[]): void;
  removeClass(...cls: string[]): void;
  hide(): void;
  show(): void;
  createDiv(opts?: { cls?: string }): MockElement;
}

export function createMockElement(cls?: string): MockElement {
  const el: MockElement = {
    cls,
    text: "",
    hidden: false,
    classes: new Set(cls ? [cls] : []),
    style: {},
    onclick: null,
    children: [],
    empty() {
      this.children = [];
      this.text = "";
    },
    setText(t: string) {
      this.text = t;
    },
    addClass(...c: string[]) {
      for (const item of c) this.classes.add(item);
    },
    removeClass(...c: string[]) {
      for (const item of c) this.classes.delete(item);
    },
    hide() {
      this.hidden = true;
    },
    show() {
      this.hidden = false;
    },
    createDiv(opts?: { cls?: string }) {
      const child = createMockElement(opts?.cls);
      this.children.push(child);
      return child;
    },
  };
  return el;
}

export class Plugin {
  app: unknown;
  manifest: { id: string; dir?: string };
  private storedData: Record<string, unknown> | null = null;

  constructor(app: unknown, manifest: { id: string; dir?: string }) {
    this.app = app;
    this.manifest = manifest;
  }

  async loadData(): Promise<Record<string, unknown> | null> {
    return this.storedData;
  }

  async saveData(data: Record<string, unknown>): Promise<void> {
    this.storedData = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  }

  addStatusBarItem(): MockElement {
    return createMockElement("status-bar-item");
  }

  addRibbonIcon(_icon: string, _title: string, _callback: () => void): MockElement {
    return createMockElement("ribbon-icon");
  }

  addCommand(_cmd: unknown): void {}
  addSettingTab(_tab: unknown): void {}
  registerEditorExtension(_ext: unknown): void {}
  registerEvent(_evt: unknown): void {}
}

export class PluginSettingTab {
  containerEl: MockElement & { settings?: Setting[] };
  constructor(public app: unknown, public plugin: unknown) {
    this.containerEl = Object.assign(createMockElement("settings-container"), {
      settings: [] as Setting[],
    });
    const origEmpty = this.containerEl.empty.bind(this.containerEl);
    this.containerEl.empty = () => {
      origEmpty();
      this.containerEl.settings = [];
    };
  }
}

export class MockTextComponent {
  value = "";
  placeholder = "";
  onChangeCallback: ((v: string) => Promise<void> | void) | null = null;

  setValue(v: string): this {
    this.value = v;
    return this;
  }
  setPlaceholder(p: string): this {
    this.placeholder = p;
    return this;
  }
  onChange(cb: (v: string) => Promise<void> | void): this {
    this.onChangeCallback = cb;
    return this;
  }
}

export class MockDropdownComponent {
  options: Record<string, string> = {};
  value = "";
  onChangeCallback: ((v: string) => Promise<void> | void) | null = null;

  addOption(key: string, label: string): this {
    this.options[key] = label;
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  onChange(cb: (v: string) => Promise<void> | void): this {
    this.onChangeCallback = cb;
    return this;
  }
}

export class MockButtonComponent {
  buttonText = "";
  cta = false;
  disabled = false;
  onClickCallback: (() => Promise<void> | void) | null = null;

  setButtonText(text: string): this {
    this.buttonText = text;
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  setDisabled(d: boolean): this {
    this.disabled = d;
    return this;
  }
  onClick(cb: () => Promise<void> | void): this {
    this.onClickCallback = cb;
    return this;
  }
}

export class MockToggleComponent {
  value = false;
  onChangeCallback: ((v: boolean) => Promise<void> | void) | null = null;

  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  onChange(cb: (v: boolean) => Promise<void> | void): this {
    this.onChangeCallback = cb;
    return this;
  }
}

export class Setting {
  name = "";
  desc = "";
  heading = false;
  textComponents: MockTextComponent[] = [];
  dropdownComponents: MockDropdownComponent[] = [];
  buttonComponents: MockButtonComponent[] = [];
  toggleComponents: MockToggleComponent[] = [];

  constructor(containerEl: { settings?: Setting[] }) {
    if (Array.isArray(containerEl.settings)) {
      containerEl.settings.push(this);
    }
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }

  setDesc(desc: string): this {
    this.desc = desc;
    return this;
  }

  setHeading(): this {
    this.heading = true;
    return this;
  }

  addText(cb: (t: MockTextComponent) => unknown): this {
    const t = new MockTextComponent();
    this.textComponents.push(t);
    cb(t);
    return this;
  }

  addDropdown(cb: (d: MockDropdownComponent) => unknown): this {
    const d = new MockDropdownComponent();
    this.dropdownComponents.push(d);
    cb(d);
    return this;
  }

  addButton(cb: (b: MockButtonComponent) => unknown): this {
    const b = new MockButtonComponent();
    this.buttonComponents.push(b);
    cb(b);
    return this;
  }

  addToggle(cb: (t: MockToggleComponent) => unknown): this {
    const t = new MockToggleComponent();
    this.toggleComponents.push(t);
    cb(t);
    return this;
  }
}
