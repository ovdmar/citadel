export type VoiceCommitOptions = {
  autoSubmit: boolean;
};

export type VoiceCommitResult =
  | { status: "submitted"; text: string }
  | { status: "inserted-not-submitted"; text: string }
  | { status: "buffered"; text: string; reason: string };

export type VoiceTarget = {
  kind: "registered" | "generic" | "terminal";
  insertText: (text: string) => void;
  commit?: (text: string, options: VoiceCommitOptions) => VoiceCommitResult;
  submit?: () => void | Promise<void>;
  canAcceptVoiceCommit: () => boolean;
};

type RegisteredEntry = {
  element: HTMLElement;
  target: VoiceTarget;
  active: boolean;
};

const TEXT_EDITABLE_INPUT_TYPES = new Set(["text", "search", "email", "tel", "url"]);

export class VoiceTargetRegistry {
  private readonly entries: RegisteredEntry[] = [];

  register(element: HTMLElement, target: VoiceTarget): () => void {
    const entry: RegisteredEntry = {
      element,
      target: {
        ...target,
        canAcceptVoiceCommit: () => entry.active && target.canAcceptVoiceCommit(),
      },
      active: true,
    };
    this.entries.unshift(entry);
    return () => {
      entry.active = false;
      const index = this.entries.indexOf(entry);
      if (index !== -1) this.entries.splice(index, 1);
    };
  }

  resolve(element: Element | null | undefined): VoiceTarget | null {
    if (!(element instanceof HTMLElement)) return null;
    for (const entry of this.entries) {
      if (!entry.element.isConnected) continue;
      if (!entry.target.canAcceptVoiceCommit()) continue;
      if (entry.element === element || entry.element.contains(element)) return entry.target;
    }
    return createGenericEditableVoiceTarget(element);
  }
}

export function createGenericEditableVoiceTarget(element: Element): VoiceTarget | null {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return null;
  if (!canAcceptTextEditableVoiceCommit(element)) return null;
  return {
    kind: "generic",
    insertText: (text) => insertTextIntoControl(element, text),
    commit: (text) => {
      insertTextIntoControl(element, text);
      return { status: "inserted-not-submitted", text };
    },
    canAcceptVoiceCommit: () => canAcceptTextEditableVoiceCommit(element),
  };
}

export function canAcceptTextEditableVoiceCommit(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (!element.isConnected) return false;
  if (element.disabled || element.readOnly) return false;
  if (!isElementVoiceVisible(element)) return false;
  if (element instanceof HTMLInputElement && !TEXT_EDITABLE_INPUT_TYPES.has(element.type)) return false;
  return true;
}

export function isElementVoiceVisible(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden) return false;
    if (current.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle?.(current);
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  }
  return true;
}

function insertTextIntoControl(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const value = element.value;
  const start = element.selectionStart ?? value.length;
  const end = element.selectionEnd ?? start;
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
  setNativeValue(element, next);
  const caret = start + text.length;
  try {
    element.setSelectionRange(caret, caret);
  } catch {
    /* Some text-like input types, such as email, do not expose selection APIs in every browser. */
  }
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: text,
    }),
  );
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement;
  const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (prototypeSetter) {
    prototypeSetter.call(element, value);
    return;
  }
  const ownSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
  if (ownSetter) {
    ownSetter.call(element, value);
    return;
  }
  element.value = value;
}
