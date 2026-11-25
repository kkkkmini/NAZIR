import Image from "next/image";
import { Suspense } from "react";
import { BOOKING_NOTICE, BookingCta } from "@/components/landing/booking-cta";
import { BookingEntry } from "@/components/landing/booking-entry";
import { FixedBookingBar } from "@/components/landing/fixed-booking-bar";
import { SectionTabs } from "@/components/landing/section-tabs";
import { ChevronRightIcon } from "@/components/site/icons";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { nazir, type CreditEntry } from "@/content/nazir";

/**
 * A1 〈나지르〉 공연 소개·예매 랜딩 (docs/design/01_IA.md §3.1, §4.1) — A안 화이트 미니멀.
 * - 본인인증을 시작하지 않는다(D-004: 인증은 회차 선택 후, 좌석 선택 전).
 * - 판매 상태·가격은 서버 계산 값이 없으므로 표시하지 않는다(R-E).
 * - 확정되지 않은 콘텐츠는 항목마다 반복하지 않고 묶어서 "추후 공개"로 안내한다.
 * - 포스터는 제작 예정. 없으면 빈 자리(작품 표기만)를 보여주고 가짜 이미지를 쓰지 않는다.
 */

const facts = [
  { label: "공연장", value: nazir.venue },
  { label: "공연 기간", value: nazir.period },
  { label: "관람 시간", value: nazir.runningTime },
  { label: "관람 연령", value: nazir.ageRating },
];
const knownFacts = facts.filter((f) => f.value);
const pendingFacts = facts.filter((f) => !f.value);

/** 예매 진행 순서 — 확정 정책(D-002, D-004, D-006)과 User Flow 1.1을 따른다. */
const bookingSteps = [
  { title: "회차 선택", body: "관람할 날짜와 시간을 고릅니다." },
  { title: "본인인증", body: "좌석을 고르기 전에 휴대전화 본인인증을 합니다. 비회원으로 예매할 수 있습니다." },
  { title: "좌석 선택", body: "한 회차에 1인 최대 4석까지 선택할 수 있습니다." },
  { title: "결제", body: "확보한 좌석은 7분 동안 유지됩니다. 시간 안에 결제해 주세요." },
  { title: "예매 확인서", body: "결제가 완료되면 모바일 예매 확인서를 볼 수 있습니다." },
];

const bookingNotes = [
  "선택한 좌석의 유지 시간 7분은 연장되지 않습니다.",
  "예매 후 좌석은 변경할 수 없습니다. 다른 좌석을 원하시면 결제 전 예매를 취소한 뒤 다시 예매해 주세요.",
  "결제는 카드와 간편결제로 할 수 있으며, 사용 가능한 결제수단은 결제 단계에서 안내합니다.",
  "결제 결과를 확인하는 동안에는 좌석이 보호되며, 다시 결제하지 않아도 됩니다.",
  "결제 완료 후 취소·환불은 취소·환불 규정에 따라 고객 문의로 접수합니다.",
];

/** 예매 영역에 붙는 요약 — 확정 정책만 */
const bookingSummary = [
  "좌석 선택 전 휴대전화 본인인증",
  "한 회차 1인 최대 4석",
  "좌석 확보 후 7분 안에 결제",
  "예매 후 좌석 변경 불가",
];

const TABS = [
  { id: "about", label: "공연 소개" },
  { id: "credits", label: "출연진·창작진" },
  { id: "guide", label: "예매 안내" },
];

const hasAbout = Boolean(nazir.synopsis?.length || nazir.description?.length);
const hasCredits = Boolean(nazir.cast?.length || nazir.creatives?.length);
const showName = `${nazir.genre} ${nazir.title}`;

/** 본문 섹션 공통 틀 — 세 섹션이 같은 제목·여백·구분선을 쓴다. */
function Section({ id, title, children, last = false }: { id: string; title: string; children: React.ReactNode; last?: boolean }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={"scroll-mt-14 py-9 md:py-12 " + (last ? "" : "border-b border-rule")}>
      <h2 id={`${id}-title`} className="text-lg font-bold text-char md:text-xl">
        {title}
      </h2>
      <div className="mt-4 md:mt-5">{children}</div>
    </section>
  );
}

function Pending({ children }: { children: React.ReactNode }) {
  return <p className="text-[0.9375rem] leading-relaxed text-char-3">{children}</p>;
}

function CreditList({ title, entries }: { title: string; entries: CreditEntry[] }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-char-2">{title}</h3>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-4 gap-y-2 text-[0.9375rem]">
        {entries.map((e) => (
          <div key={`${e.role}-${e.name}`} className="contents">
            <dt className="text-char-3">{e.role}</dt>
            <dd className="text-char">{e.name}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function Home() {
  return (
    <div className="theme-a flex flex-1 flex-col">
      <SiteHeader tone="light" />

      <main className="mx-auto grid w-full max-w-[77.5rem] flex-1 grid-cols-1 gap-x-16 px-5 pb-16 sm:px-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:pb-24">
        {/* 1. 포스터 + 작품명 + 관람 정보 */}
        <section aria-labelledby="show-title" className="pt-6 md:pt-12 lg:col-start-1 lg:row-start-1 lg:pt-14">
          <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-end gap-x-5 gap-y-6 sm:grid-cols-[13rem_minmax(0,1fr)] sm:grid-rows-[auto_1fr] sm:items-start sm:gap-x-9 sm:gap-y-7 md:grid-cols-[17.5rem_minmax(0,1fr)] md:gap-x-12 xl:grid-cols-[19rem_minmax(0,1fr)]">
            <div className="relative aspect-[3/4] overflow-hidden rounded-[0.25rem] bg-char sm:row-span-2">
              {nazir.posterUrl ? (
                <Image src={nazir.posterUrl} alt={`${showName} 포스터`} fill priority className="object-cover" sizes="(min-width: 1280px) 304px, (min-width: 768px) 280px, 120px" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2.5 px-3 text-center sm:gap-4">
                  <span className="text-[0.8125rem] font-extrabold tracking-[0.42em] text-white/90 sm:text-xl md:text-2xl">NAZIR</span>
                  <span aria-hidden className="h-px w-6 bg-white/30 sm:w-10" />
                  <span className="text-[0.6875rem] text-white/55 sm:text-xs">포스터 준비 중</span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5 pb-1 sm:gap-3 sm:pb-0 sm:pt-1">
              <p className="text-[0.8125rem] font-medium text-char-3 sm:text-sm">{nazir.genre}</p>
              <h1 id="show-title" className="text-[1.75rem] font-bold leading-[1.15] tracking-[-0.035em] text-char sm:text-[2.5rem] md:text-[3rem] xl:text-[3.25rem]">
                {nazir.title}
              </h1>
              <p className="text-[0.6875rem] font-semibold tracking-[0.36em] text-char-3 sm:text-xs">{nazir.titleLatin}</p>
            </div>

            <div className="col-span-2 flex flex-col gap-6 sm:col-span-1 sm:col-start-2 md:gap-7">
              <p className="text-[0.9375rem] leading-relaxed text-char-2 md:text-base">
                {nazir.tagline ?? "공연 정보는 확정되는 대로 이 페이지에서 공개합니다."}
              </p>

              {/* 관람 정보 표. 미확정 항목은 칸만 두고 안내는 한 번만 표시한다. */}
              <dl className="border-t border-char text-[0.9375rem]">
                {knownFacts.map((f) => (
                  <div key={f.label} className="grid grid-cols-[5.5rem_1fr] gap-4 border-b border-rule py-3 md:grid-cols-[6.5rem_1fr] md:py-3.5">
                    <dt className="text-char-3">{f.label}</dt>
                    <dd className="text-char">{f.value}</dd>
                  </div>
                ))}
                {pendingFacts.length > 0 && (
                  <div className="grid grid-cols-[5.5rem_1fr] gap-4 border-b border-rule py-3 md:grid-cols-[6.5rem_1fr] md:py-3.5">
                    <dt className="flex flex-col gap-2 text-char-3 md:gap-2.5">
                      {pendingFacts.map((f) => (
                        <span key={f.label}>{f.label}</span>
                      ))}
                    </dt>
                    <dd className="flex flex-col justify-center gap-1 border-l border-rule pl-4">
                      <span className="font-medium text-char">추후 공개</span>
                      <span className="text-[0.8125rem] leading-relaxed text-char-3">확정되는 대로 이 페이지에서 안내합니다.</span>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </section>

        {/* 2. 예매 영역 — 데스크톱은 오른쪽에서 따라 내려오고, 모바일은 관람 정보 바로 아래 */}
        <aside aria-label="예매" className="mt-7 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-14">
          <div className="flex flex-col gap-8 lg:sticky lg:top-6">
            <section id="hero-booking-bar" aria-labelledby="booking-title" className="flex flex-col gap-4 lg:border-t-2 lg:border-char lg:pt-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="booking-title" className="text-base font-bold text-char md:text-lg">
                  예매
                </h2>
                <span className="text-[0.8125rem] text-char-3">비회원 예매</span>
              </div>
              <p className="text-sm leading-relaxed text-char-2">날짜와 회차는 다음 단계에서 선택합니다.</p>
              <div className="flex flex-col [&>*]:w-full">
                <Suspense fallback={<BookingCta />}>
                  <BookingEntry />
                </Suspense>
              </div>
              <p className="text-xs leading-relaxed text-char-3">{BOOKING_NOTICE}</p>
            </section>

            <section aria-labelledby="summary-title" className="hidden flex-col gap-3 border-t border-rule pt-5 lg:flex">
              <h2 id="summary-title" className="text-sm font-bold text-char">
                예매 전 확인
              </h2>
              <ul className="flex flex-col gap-2 text-sm text-char-2">
                {bookingSummary.map((s) => (
                  <li key={s} className="flex gap-2">
                    <span aria-hidden className="text-char-3">
                      ·
                    </span>
                    {s}
                  </li>
                ))}
              </ul>
              <a href="#guide" className="mt-1 flex items-center gap-0.5 self-start text-[0.8125rem] text-char-3 hover:text-char">
                상세 예매 안내
                <ChevronRightIcon className="h-3.5 w-3.5" />
              </a>
            </section>
          </div>
        </aside>

        {/* 3. 본문 탭 + 섹션 */}
        <div className="mt-10 flex min-w-0 flex-col md:mt-14 lg:col-start-1 lg:row-start-2 lg:mt-16">
          <SectionTabs tabs={TABS} />

          <Section id="about" title="공연 소개">
            {hasAbout ? (
              <div className="flex max-w-[42rem] flex-col gap-4 text-[0.9375rem] leading-[1.8] text-char-2 md:text-base">
                {nazir.synopsis?.map((p, i) => <p key={`s${i}`}>{p}</p>)}
                {nazir.description?.map((p, i) => <p key={`d${i}`}>{p}</p>)}
              </div>
            ) : (
              <Pending>시놉시스와 작품 설명은 공연 정보가 확정되는 대로 공개합니다.</Pending>
            )}
          </Section>

          {/* 작품 전체 기준. 회차별 캐스팅은 표시하지 않는다(D3). */}
          <Section id="credits" title="출연진·창작진">
            {hasCredits ? (
              <div className="grid gap-8 sm:grid-cols-2 sm:gap-12">
                {nazir.cast?.length ? <CreditList title="출연진" entries={nazir.cast} /> : null}
                {nazir.creatives?.length ? <CreditList title="창작진" entries={nazir.creatives} /> : null}
              </div>
            ) : (
              <Pending>출연진과 창작진은 확정되는 대로 공개합니다.</Pending>
            )}
          </Section>

          <Section id="guide" title="예매 안내" last>
            <ol className="grid border-t border-rule md:grid-cols-5 md:border-t-0">
              {bookingSteps.map((s, i) => (
                <li
                  key={s.title}
                  className="grid grid-cols-[2rem_1fr] gap-x-3 border-b border-rule py-3.5 md:flex md:flex-col md:gap-2 md:border-b-0 md:border-t-2 md:border-t-rule md:py-0 md:pr-5 md:pt-4 first:md:border-t-char"
                >
                  <span className="text-[0.8125rem] font-semibold tabular-nums text-char-3">{String(i + 1).padStart(2, "0")}</span>
                  <div className="flex flex-col gap-1">
                    <p className="text-[0.9375rem] font-semibold text-char">{s.title}</p>
                    <p className="text-[0.8125rem] leading-relaxed text-char-2 md:text-sm">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex flex-col gap-3 md:mt-10">
              <h3 className="text-sm font-semibold text-char">예매 전에 확인해 주세요</h3>
              <ul className="flex flex-col gap-2 text-[0.8125rem] leading-relaxed text-char-2 md:text-sm">
                {bookingNotes.map((n) => (
                  <li key={n} className="flex gap-2">
                    <span aria-hidden className="text-char-3">
                      ·
                    </span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        </div>
      </main>

      <SiteFooter tone="light" />
      {/* 모바일 하단 고정 바가 푸터 내용을 가리지 않도록 여백 */}
      <div className="h-[calc(4.25rem+env(safe-area-inset-bottom,0px))] bg-wash lg:hidden" aria-hidden />
      <FixedBookingBar
        targetId="hero-booking-bar"
        title={showName}
        cta={
          <Suspense fallback={<BookingCta size="sm" label="예매 준비 중" />}>
            <BookingEntry size="sm" />
          </Suspense>
        }
      />
    </div>
  );
}
