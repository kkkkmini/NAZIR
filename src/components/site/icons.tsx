/** 관객 사이트 선 아이콘(장식용, aria-hidden). 1.5px 선, currentColor. */
type P = { className?: string };
const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  viewBox: "0 0 24 24",
};

export function TicketIcon({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className}>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4Z" />
      <path d="M14 6v12" strokeDasharray="2 2" />
    </svg>
  );
}
export function PinIcon({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.3" />
    </svg>
  );
}
export function CalendarIcon({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className}>
      <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </svg>
  );
}
export function ClockIcon({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
export function UsersIcon({ className = "h-5 w-5" }: P) {
  return (
    <svg {...base} className={className}>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
    </svg>
  );
}
export function ChevronRightIcon({ className = "h-4 w-4" }: P) {
  return (
    <svg {...base} className={className} strokeWidth={2}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
