"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSelectedSessionId } from "@/components/booking/selected-session";

/** URL에 회차가 없으면 같은 탭에 저장된 선택 회차로 바꿔 다시 연다. 저장된 값도 없으면 회차 선택으로 안내한다. */
export function SessionRedirect() {
  const id = useSelectedSessionId();
  const router = useRouter();
  useEffect(() => {
    if (id) router.replace(`/booking/seats?session=${encodeURIComponent(id)}`);
  }, [id, router]);

  if (id === null) {
    return (
      <div className="flex flex-col gap-2.5 border-y border-rule py-10">
        <p className="text-base text-char">선택한 회차 정보가 없습니다.</p>
        <Link href="/booking" className="self-start text-sm font-medium text-char underline underline-offset-4">
          회차를 먼저 선택해 주세요
        </Link>
      </div>
    );
  }
  return <div className="h-64 animate-pulse bg-wash motion-reduce:animate-none" aria-label="불러오는 중" />;
}
