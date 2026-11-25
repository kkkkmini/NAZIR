/**
 * 예매 시작 CTA (A1, A안 화이트 미니멀).
 *
 * 예매 버튼의 상태(판매 예정·판매 중·매진·일시 중지·판매 종료)는 서버가 계산해 내려줘야 한다
 * (docs/design/01_IA.md R-E). 그 응답이 아직 없으므로 클라이언트에서 판매 가능 여부를 추정하지 않고
 * "연결 전" 상태 하나만 비활성으로 표시한다. 주 버튼은 차콜, 강조색은 쓰지 않는다.
 */
export const BOOKING_NOTICE = "예매 일정은 확정되는 대로 이 페이지에서 안내합니다.";

export const bookingButtonClass = (size: "lg" | "sm") =>
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[0.25rem] font-semibold transition-colors " +
  (size === "lg" ? "min-h-[3.25rem] px-8 text-base" : "min-h-11 px-5 text-sm");

export function BookingCta({ size = "lg", label = "예매 오픈 준비 중" }: { size?: "lg" | "sm"; label?: string }) {
  return (
    <button
      type="button"
      disabled
      data-booking-state="not-connected"
      className={bookingButtonClass(size) + " cursor-not-allowed border border-rule bg-wash text-char-3"}
    >
      {label}
    </button>
  );
}
