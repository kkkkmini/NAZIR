import type { SeatView } from "@/server/seats/seat-types";
import { groupBy } from "./seat-layout";

/**
 * 선택 좌석 위치 미리보기(읽기 전용) — A3-4.
 * 넘겨받은 배치(현재는 [DEV] 개발용 격자)를 작게 그리고 주문 좌석만 차콜로 강조한다.
 * 좌석 상태는 쓰지 않는다. 클릭·확대·축소 없음. 실제 SVG가 오면 svgSeatId로 강조하는 컴포넌트로 교체한다.
 */
export function SeatMiniMap({ layout, highlightIds, labels, dev }: { layout: SeatView[]; highlightIds: string[]; labels: string[]; dev: boolean }) {
  const on = new Set(highlightIds);
  const sections = groupBy(layout, (s) => s.section ?? "");
  return (
    <figure className="mx-auto flex w-full max-w-[14rem] flex-col gap-2 sm:mx-0 sm:max-w-none" data-mini-map aria-label={`좌석 위치 미리보기. 선택 좌석: ${labels.join(", ")}`}>
      <div className="flex flex-col items-center gap-2 border border-rule px-3 py-3 sm:gap-3 sm:py-4" aria-hidden>
        <div className="flex w-full max-w-[9rem] flex-col items-center gap-1">
          <div className="h-1 w-full rounded-full bg-char/70" />
          <span className="text-[0.5625rem] font-semibold tracking-[0.35em] text-char-3">STAGE</span>
        </div>
        {[...sections].map(([section, list]) => (
          <div key={section} className="flex flex-col items-center gap-1">
            <span className="text-[0.625rem] text-char-3">{section}석</span>
            <div className="flex flex-col gap-[3px]">
              {[...groupBy(list, (s) => s.row ?? "")].map(([row, seats]) => (
                <div key={row} className="flex justify-center gap-[3px]">
                  {seats.map((s) => (
                    <span key={s.sessionSeatId} data-mini-seat={s.svgSeatId} data-on={on.has(s.sessionSeatId) || undefined} className={"h-2.5 w-2.5 rounded-[2px] " + (on.has(s.sessionSeatId) ? "bg-char" : "bg-[#e3e3e6]")} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <figcaption className="flex flex-col gap-0.5 text-center text-[0.6875rem] leading-snug text-char-3 sm:text-left">
        {dev && <span className="font-semibold text-char-2">[DEV] 개발용 임시 배치</span>}
        <span>실제 공연장 배치와 다를 수 있습니다.</span>
      </figcaption>
    </figure>
  );
}
