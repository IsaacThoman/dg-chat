import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import {
  PWA_UPDATE_GUIDANCE,
  PWA_UPDATE_TITLE,
  PwaUpdateNotice,
  pwaUpdateNoticeClearance,
  PwaUpdateNoticeContent,
} from "./PwaUpdateNotice.tsx";

const pwaState = vi.hoisted(() => ({ updateReady: false }));
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    needRefresh: [pwaState.updateReady, () => undefined],
    offlineReady: [false, () => undefined],
    updateServiceWorker: () => Promise.resolve(),
  }),
}));

describe("PWA update notice", () => {
  beforeEach(() => {
    pwaState.updateReady = false;
  });

  it("does not render before a waiting version is available", () => {
    expect(renderToString(<PwaUpdateNotice />)).toBe("");
  });

  it("documents the safe two-version handoff without offering eager activation", () => {
    pwaState.updateReady = true;
    expect(PWA_UPDATE_TITLE).toBe("An update is ready");
    expect(PWA_UPDATE_GUIDANCE).toContain("close every DG Chat tab or window");
    expect(PWA_UPDATE_GUIDANCE).toContain("Nothing will reload automatically");
    expect(PWA_UPDATE_GUIDANCE).toContain("send or copy any draft");
    expect(PWA_UPDATE_GUIDANCE).toContain("next time you open DG Chat");
    const html = renderToString(<PwaUpdateNotice />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(">Later</button>");
    expect(html).not.toMatch(/reload now|update now|install now/i);

    // The presentational form remains independently renderable for accessibility review.
    expect(renderToString(<PwaUpdateNoticeContent onDismiss={() => undefined} />)).toContain(
      'aria-describedby="pwa-update-guidance"',
    );
  });

  it("keeps the notice above desktop and mobile composer bounds", () => {
    expect(pwaUpdateNoticeClearance(700, 900)).toBe(212);
    expect(pwaUpdateNoticeClearance(560, 800)).toBe(252);
    expect(pwaUpdateNoticeClearance(null, 800)).toBe(16);
    const html = renderToString(
      <PwaUpdateNoticeContent composerClearance={252} onDismiss={() => undefined} />,
    );
    expect(html).toContain("--pwa-composer-clearance:252px");
  });
});
