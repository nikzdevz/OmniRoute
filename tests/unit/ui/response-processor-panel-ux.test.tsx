// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResponseProcessorPanel from "@/app/(dashboard)/dashboard/response-processor/ResponseProcessorPanel";

// Rules-list UX — collapsed summary rows in a scrollable list, sticky save bar, add expands.

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;

vi.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, vars?: Record<string, unknown>) =>
      vars
        ? `${key}:${JSON.stringify(vars)}`
        : key,
}));

vi.mock("@/shared/components/Card", () => ({
  default: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <section data-card-title={title}>{children}</section>
  ),
}));
vi.mock("@/shared/components/Button", () => ({
  default: ({
    children,
    onClick,
    disabled,
    "data-testid": testid,
    ariaLabel,
  }: React.ComponentProps<"button"> & { "data-testid"?: string; ariaLabel?: string }) => (
    <button onClick={onClick} disabled={disabled} data-testid={testid} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@/shared/components/Icon", () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />,
}));
vi.mock("@/shared/components/Input", () => ({
  default: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("@/shared/components/Select", () => ({
  default: ({ value }: { value?: string }) => <select value={value} readOnly />,
}));
vi.mock("@/shared/components/Textarea", () => ({
  default: (props: React.ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("@/shared/components/Toggle", () => ({
  default: ({ checked, label }: { checked: boolean; label?: string }) => (
    <span data-toggle-checked={String(checked)}>{label}</span>
  ),
}));

const savedConfig = {
  enabled: true,
  emptyFallback: "",
  rules: [
    {
      id: "r1",
      enabled: true,
      match: " Rp1.500 di bot @OniAIBot.",
      matchType: "literal",
      anchor: "anywhere",
      action: "remove",
      replaceWith: "",
    },
    {
      id: "r2",
      enabled: false,
      match: "PECUTI",
      matchType: "regex",
      anchor: "anywhere",
      action: "remove",
      replaceWith: "",
    },
  ],
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(savedConfig),
      })
    )
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel() {
  act(() => {
    root = createRoot(container);
    root.render(<ResponseProcessorPanel />);
  });
}

const byTestid = (testid: string) =>
  container.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`);

describe("ResponseProcessorPanel rules list UX", () => {
  it("renders one collapsed summary row per rule with the match text visible", async () => {
    renderPanel();
    await act(async () => {}); // flush the load effect
    const matchInputs = byTestid("response-processor-rule-match");
    expect(matchInputs.length).toBe(0); // collapsed: no editor inputs mounted
    expect(container.textContent).toContain(" Rp1.500 di bot @OniAIBot.");
    expect(container.textContent).toContain("PECUTI");
  });

  it("expands the editor for a tapped row and collapses it again", async () => {
    renderPanel();
    await act(async () => {});
    const row = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!;
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(byTestid("response-processor-rule-match").length).toBe(1);
    const openRow = container.querySelector<HTMLButtonElement>('[aria-expanded="true"]')!;
    act(() => openRow.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(byTestid("response-processor-rule-match").length).toBe(0);
  });

  it("add rule expands the new row immediately", async () => {
    renderPanel();
    await act(async () => {});
    expect(byTestid("response-processor-rule-match").length).toBe(0);
    act(
      () =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="response-processor-add-rule"]')!
          .dispatchEvent(new MouseEvent("click", { bubbles: true }))
    );
    expect(byTestid("response-processor-rule-match").length).toBe(1);
  });

  it("keeps the save button reachable and shows the active-rules summary", async () => {
    renderPanel();
    await act(async () => {});
    expect(container.querySelector('[data-testid="response-processor-save"]')).not.toBeNull();
    expect(container.textContent).toContain("responseProcessorRulesSummary");
    expect(container.textContent).toContain('"total":2');
  });
});
