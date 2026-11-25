import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { mockControlAppDeps } from "@/server/identity/callback-app-deps";
import { loadMockTransaction } from "@/server/identity/mock-control";
import { MOCK_PERSONAS } from "@/server/identity/providers/mock-personas";

export const metadata: Metadata = { title: "Mock 본인인증 (개발용)", robots: { index: false, follow: false } };

/** Mock identity provider screen — local/test only (A-050). 404 everywhere else, and for unknown/used transactions. */
export default function MockIdentityPage(props: PageProps<"/identity/mock">) {
  return (
    <Suspense fallback={<p className="text-neutral-500">불러오는 중…</p>}>
      <MockIdentity searchParams={props.searchParams} />
    </Suspense>
  );
}

async function MockIdentity({ searchParams }: { searchParams: PageProps<"/identity/mock">["searchParams"] }) {
  await connection();
  if (!mockControlAppDeps.enabled()) notFound();
  const { txn } = await searchParams;
  const t = await loadMockTransaction(mockControlAppDeps, txn);
  if (!t) notFound();
  return (
    <section className="flex flex-col gap-6" data-mock-identity>
      <div className="rounded border border-red-400 bg-red-50 p-4 text-red-900" role="note">
        <p className="font-semibold">개발·테스트 전용 Mock 본인인증입니다.</p>
        <p className="text-sm">실제 본인인증이 아니며 운영 환경에서는 열리지 않습니다. 아래 사용자는 모두 가짜 테스트 데이터입니다.</p>
      </div>
      <h1 className="text-2xl font-semibold">Mock 본인인증 ({t.purpose})</h1>
      <form method="post" action="/api/v1/mock/identity/complete" className="flex flex-col gap-3">
        <input type="hidden" name="txn" value={String(txn)} />
        {(Object.keys(MOCK_PERSONAS) as (keyof typeof MOCK_PERSONAS)[]).map((id) => (
          <button key={id} type="submit" name="outcome" value={`success:${id}`} className="rounded border px-4 py-2 text-left">
            인증 성공 — {MOCK_PERSONAS[id].name}
          </button>
        ))}
        <button type="submit" name="outcome" value="cancel" className="rounded border px-4 py-2 text-left">
          사용자 취소
        </button>
        <button type="submit" name="outcome" value="fail" className="rounded border px-4 py-2 text-left">
          인증 실패
        </button>
      </form>
    </section>
  );
}
