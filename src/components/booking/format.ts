/** 예매 화면 공통 날짜·시간 표시 (Asia/Seoul). */
const TZ = "Asia/Seoul";

export const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const monthDayFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, month: "numeric", day: "numeric" });
export const weekdayFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, weekday: "short" });
export const timeFmt = new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
export const fullFmt = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TZ,
  month: "long",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatSessionDateTime(iso: string): string {
  return fullFmt.format(new Date(iso));
}

const wonFmt = new Intl.NumberFormat("ko-KR");

/** 서버가 준 가격(원)을 표시만 한다. 화면에서 가격을 계산·보정하지 않는다(합계는 표시용). */
export function formatWon(amount: number): string {
  return `${wonFmt.format(amount)}원`;
}
