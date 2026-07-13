import { describe, expect, it } from "vitest";
import {
  MODAL_FOCUSABLE_SELECTOR,
  modalFocusableElements,
  modalInitialFocus,
  modalShouldRestoreFocus,
} from "./modalFocus.ts";

type FakeElement = {
  tabIndex: number;
  disabled?: boolean;
  ariaDisabled?: boolean;
  ariaHidden?: boolean;
  inert?: boolean;
  autofocus?: boolean;
};

function element(value: FakeElement): HTMLElement {
  return {
    tabIndex: value.tabIndex,
    matches: (selector: string) =>
      selector === ":disabled, [aria-disabled='true'], [aria-hidden='true']" &&
      Boolean(value.disabled || value.ariaDisabled || value.ariaHidden),
    closest: (selector: string) => selector === "[inert]" && value.inert ? {} : null,
    hasAttribute: (name: string) =>
      Boolean(value.autofocus && (name === "autofocus" || name === "data-autofocus")),
  } as HTMLElement;
}

describe("modal focus targets", () => {
  it("includes native controls, links, contenteditable regions, and explicit tab stops", () => {
    expect(MODAL_FOCUSABLE_SELECTOR).toContain("a[href]");
    expect(MODAL_FOCUSABLE_SELECTOR).toContain("select:not([disabled])");
    expect(MODAL_FOCUSABLE_SELECTOR).toContain("textarea:not([disabled])");
    expect(MODAL_FOCUSABLE_SELECTOR).toContain("[contenteditable]");
    expect(MODAL_FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
  });
  it("suppresses focus restoration during an internal modal handoff", () => {
    let handoff = true;
    expect(modalShouldRestoreFocus(() => !handoff)).toBe(false);
    handoff = false;
    expect(modalShouldRestoreFocus(() => !handoff)).toBe(true);
  });

  it("filters disabled, hidden, inert, and negative-tab-index matches", () => {
    const included = element({ tabIndex: 0 });
    const disabled = element({ tabIndex: 0, disabled: true });
    const ariaDisabled = element({ tabIndex: 0, ariaDisabled: true });
    const hidden = element({ tabIndex: 0, ariaHidden: true });
    const inert = element({ tabIndex: 0, inert: true });
    const negative = element({ tabIndex: -1 });
    const dialog = {
      querySelectorAll: () => [included, disabled, ariaDisabled, hidden, inert, negative],
    } as unknown as HTMLElement;

    expect(modalFocusableElements(dialog)).toEqual([included]);
  });

  it("prefers an explicitly requested field over the modal close button", () => {
    const close = element({ tabIndex: 0 });
    const projectName = element({ tabIndex: 0, autofocus: true });
    const dialog = element({ tabIndex: -1 });
    expect(modalInitialFocus(dialog, [close, projectName])).toBe(projectName);
  });

  it("falls back to the first control and then the dialog", () => {
    const close = element({ tabIndex: 0 });
    const dialog = element({ tabIndex: -1 });
    expect(modalInitialFocus(dialog, [close])).toBe(close);
    expect(modalInitialFocus(dialog, [])).toBe(dialog);
  });
});
