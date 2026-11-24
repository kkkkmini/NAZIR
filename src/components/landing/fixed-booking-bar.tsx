"use client";

import { useEffect, useState } from "react";
import { luminaArtHall } from "@/content/venue";

/**
 * 모바일·태블릿 하단 고정 예매 바. 상단 예매 영역(targetId)이 화면에서 사라지면 나타난다.
 * 데스크톱(lg 이상)은 오른쪽 예매 영역이 따라 내려오므로(sticky) 이 바를 쓰지 않는다.
 */
export function FixedBookingBar({ targetId, title, cta }: { targetId: string; title: string; cta: React.ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!entry.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);

  return (
    <div
      aria-hidden={!visible}
      inert={!visible}
      className={
        "fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur transition-transform duration-200 motion-reduce:transition-none lg:hidden " +
        (visible ? "translate-y-0" : "translate-y-full")
      }
    >
      <div className="mx-auto flex max-w-[77.5rem] items-center gap-4 px-5 py-3 sm:px-8">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.9375rem] font-bold text-char">{title}</p>
          <p className="truncate text-xs text-char-3">{luminaArtHall.name} · 공연 일정 추후 공개</p>
        </div>
        {cta}
      </div>
    </div>
  );
}
