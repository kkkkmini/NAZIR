import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="text-2xl font-semibold">페이지를 찾을 수 없습니다</h1>
      <p className="text-neutral-600">요청한 공연이나 회차가 없거나 공개되지 않았습니다.</p>
      <Link href="/" className="underline underline-offset-4">
        처음으로
      </Link>
    </>
  );
}
