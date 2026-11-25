/** [DEV] 개발 환경 안내 — A안(화이트 미니멀) 화면 공통. 운영 화면에서는 렌더하지 않는다. */
export function DevNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 border-l-2 border-char-3 bg-wash px-3.5 py-2 text-xs leading-relaxed text-char-2 md:py-2.5 md:text-[0.8125rem]">
      <span className="shrink-0 font-bold text-char">[DEV]</span>
      <span>{children}</span>
    </p>
  );
}
