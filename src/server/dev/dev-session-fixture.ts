import "server-only";
import type { BookingSessionView, SessionState } from "@/server/booking/session-types";

/**
 * [DEV] 개발 환경 전용 가짜 회차 데이터. 실제 공연 일정이 아니다.
 * 화면 상태(회차 상태 6종)를 확인하기 위한 값이며 운영에서는 호출되지 않는다(devPreviewEnabled).
 * 날짜는 요청 시점 기준 상대 날짜로 만들어 항상 미래 회차가 되게 한다.
 */
const PLAN: { dayOffset: number; time: string; state: SessionState }[] = [
  { dayOffset: 10, time: "19:30", state: "AVAILABLE" },
  { dayOffset: 11, time: "19:30", state: "SOLD_OUT" },
  { dayOffset: 12, time: "14:00", state: "AVAILABLE" },
  { dayOffset: 12, time: "18:30", state: "SOLD_OUT" },
  { dayOffset: 13, time: "15:00", state: "AVAILABLE" },
  { dayOffset: 13, time: "19:30", state: "CANCELED" },
  { dayOffset: 15, time: "19:30", state: "PAUSED" },
  { dayOffset: 16, time: "19:30", state: "CLOSED" },
  { dayOffset: 17, time: "19:30", state: "SOLD_OUT" },
  { dayOffset: 19, time: "14:00", state: "UPCOMING" },
  { dayOffset: 19, time: "18:30", state: "UPCOMING" },
];

/** KST 기준 날짜(오늘 + offset)의 hh:mm을 UTC ISO로 */
function kstIso(now: Date, dayOffset: number, time: string): string {
  const kstNow = new Date(now.getTime() + 9 * 3600_000);
  const [h, m] = time.split(":").map(Number);
  const utc = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + dayOffset, h - 9, m);
  return new Date(utc).toISOString();
}

export function devSessionFixture(now: Date): BookingSessionView[] {
  return PLAN.map((p, i) => ({
    id: `dev-session-${i + 1}`,
    startsAt: kstIso(now, p.dayOffset, p.time),
    state: p.state,
    opensAt: p.state === "UPCOMING" ? kstIso(now, 5, "14:00") : null,
  }));
}
