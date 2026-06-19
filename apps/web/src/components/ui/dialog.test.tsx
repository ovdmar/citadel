// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";
import { fireClick, pressKey, render } from "./test-utils.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(node: React.ReactNode) {
  const result = render(node);
  cleanup = result.unmount;
  return result;
}

function Sample({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description text</DialogDescription>
        </DialogHeader>
        <div>Body content</div>
        <DialogFooter>
          <button type="button">Footer</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("does not render content when closed", () => {
    mount(<Sample />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens when defaultOpen is true and exposes role=dialog with title + description", () => {
    mount(<Sample defaultOpen />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Title");
    expect(dialog?.textContent).toContain("Description text");
    expect(dialog?.textContent).toContain("Body content");
    expect(dialog?.textContent).toContain("Footer");
  });

  it("opens via the trigger click", () => {
    mount(<Sample />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const trigger = document.querySelector('[data-slot="dialog-trigger"]');
    fireClick(trigger);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("closes on Escape", () => {
    mount(<Sample defaultOpen />);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    pressKey(document.body, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
