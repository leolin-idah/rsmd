import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../ipc";
import { useShellStore } from "../store";
import { applySettingsToBody, installSettingsProjection } from "./projection";

const base: Settings = { layout: "sideList", toc: false, tocSide: "left", wrapCode: true };

describe("settings → body.dataset projection", () => {
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    useShellStore.setState({ settings: null });
    for (const k of ["layout", "toc", "tocSide", "wrapCode"]) delete document.body.dataset[k];
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  it("writes every field with the spelling the CSS selectors expect", () => {
    applySettingsToBody(base);
    expect(document.body.dataset.layout).toBe("sideList");
    expect(document.body.dataset.toc).toBe("off");
    expect(document.body.dataset.tocSide).toBe("left");
    expect(document.body.dataset.wrapCode).toBe("on");
  });

  it("follows the store once installed (local-first panel edits reach the DOM immediately)", () => {
    unsubscribe = installSettingsProjection();
    useShellStore.getState().setSettings(base);
    expect(document.body.dataset.layout).toBe("sideList");
    useShellStore.getState().setSettings({ ...base, toc: true, wrapCode: false });
    expect(document.body.dataset.toc).toBe("on");
    expect(document.body.dataset.wrapCode).toBe("off");
  });

  it("does nothing while settings are still null", () => {
    unsubscribe = installSettingsProjection();
    useShellStore.setState({ settings: null });
    expect(document.body.dataset.layout).toBeUndefined();
  });
});
