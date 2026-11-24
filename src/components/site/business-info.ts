/**
 * Business details shown in the footer and on /business-info (card-company review, E-008).
 *
 * NOTHING HERE IS REAL DATA YET. Every value is `null` until the operator supplies it; the UI then shows "입력 대기"
 * for that field. Do not fill these with guesses — a wrong registration number on a public commerce page is worse
 * than an obviously missing one. Fields follow what Korean online-commerce pages usually display; the exact list the
 * card companies require is still unconfirmed (DECISIONS E-008).
 */
export interface BusinessInfoField {
  label: string;
  value: string | null;
}

export const BUSINESS_INFO: readonly BusinessInfoField[] = [
  { label: "상호", value: null },
  { label: "대표자", value: null },
  { label: "사업자등록번호", value: null },
  { label: "통신판매업 신고번호", value: null },
  { label: "사업장 주소", value: null },
  { label: "고객센터 전화번호", value: null },
  { label: "고객센터 이메일", value: null },
  { label: "개인정보 보호책임자", value: null },
];

export const PENDING = "입력 대기";
