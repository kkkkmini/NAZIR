"use client";

import { useEffect, useState } from "react";

/**
 * A1 본문 탭(공연 소개 · 출연진·창작진 · 예매 안내). 같은 페이지 안의 섹션으로 이동하는 링크이며,
 * 스크롤 위치에 따라 현재 섹션을 표시한다. 상단에 붙어 따라온다.
 */
export function SectionTabs({ tabs }: { tabs: { id: string; label: string }[] }) {
  const [active, setActive] = useState(tabs[0]?.id);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const els = tabs.map((t) => document.getElementById(t.id)).filter((e): e is HTMLElement => Boolean(e));
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-72px 0px -55% 0px" },
    );
    els.forEach((e) => observer.observe(e));
    return () => observer.disconnect();
  }, [tabs]);

  return (
    <nav aria-label="공연 정보" className="sticky top-0 z-20 -mx-5 border-b border-char/15 bg-paper/95 px-5 backdrop-blur sm:-mx-8 sm:px-8 lg:mx-0 lg:px-0">
      <ul className="flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <li key={t.id} className="shrink-0">
              <a
                href={`#${t.id}`}
                aria-current={on ? "true" : undefined}
                onClick={() => setActive(t.id)}
                className={
                  "relative block px-3.5 py-3.5 text-[0.9375rem] transition-colors md:px-6 md:py-4 " +
                  (on ? "font-bold text-char" : "text-char-3 hover:text-char")
                }
              >
                {t.label}
                <span aria-hidden className={"absolute inset-x-2 -bottom-px h-0.5 " + (on ? "bg-char" : "bg-transparent")} />
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
