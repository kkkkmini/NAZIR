import { connection } from "next/server";
import { describeRuntimeConfig } from "@/server/config/runtime-config";
import { getRuntimeConfig } from "@/server/config/server-config";

/**
 * Non-secret runtime status (ARCHITECTURE.md §6.5 item 7).
 * `connection()` forces request-time execution; without it Cache Components would
 * prerender this handler at build time and freeze the build environment's values.
 */
export async function GET() {
  await connection();
  return Response.json({
    status: "ok",
    ...describeRuntimeConfig(getRuntimeConfig()),
  });
}
