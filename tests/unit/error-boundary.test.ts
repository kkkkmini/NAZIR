/**
 * PAGE-05 (review M1): the route error boundary (src/app/error.tsx) retries with Next.js `retry` — which refreshes the
 * route so the server components are fetched again — and never with `reset`, which only re-renders the failed content.
 * The component is called as a plain function (no DOM needed) and its button's handler is invoked.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "@/app/error";

function findButton(node: ReactNode): ReactElement<{ onClick: () => void; children: ReactNode }> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findButton(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === "button") return node as ReactElement<{ onClick: () => void; children: ReactNode }>;
  return findButton((node.props as { children?: ReactNode }).children);
}

describe("PAGE-05 error boundary", () => {
  it("'다시 시도' calls retry (server refetch), not reset", () => {
    const retry = vi.fn();
    const reset = vi.fn();
    // `reset` is what Next.js also passes; the component must not use it.
    const tree = (ErrorBoundary as unknown as (p: Record<string, unknown>) => ReactNode)({ error: new Error("db down"), retry, reset });
    const button = findButton(tree);
    expect(button).not.toBeNull();
    expect(button!.props.children).toBe("다시 시도");
    button!.props.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it("never renders the error's message (no internal detail on screen)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const tree = (ErrorBoundary as unknown as (p: Record<string, unknown>) => ReactNode)({ error: new Error("secret-internal-detail"), retry: () => {} });
    expect(renderToStaticMarkup(tree as ReactElement)).not.toContain("secret-internal-detail");
  });
});
