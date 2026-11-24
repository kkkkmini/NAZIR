import { connection } from "next/server";
import { getSecurityConfig } from "@/server/identity/app-deps";
import { handleBootstrap } from "@/server/identity/bootstrap";

/** Browser binding + CSRF token (API_SPEC §4.1). Request time only, never cached. */
export async function GET(request: Request) {
  await connection();
  return handleBootstrap(request, { security: getSecurityConfig });
}
