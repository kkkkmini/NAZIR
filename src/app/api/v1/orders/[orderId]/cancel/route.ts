import { connection } from "next/server";
import { cancelAppDeps } from "@/server/booking/cancel-app-deps";
import { handleCancelOrder } from "@/server/booking/cancel-route";

/** Cancel a PENDING order (API_SPEC §4.5). Request time only, never cached. */
export async function POST(request: Request, ctx: RouteContext<"/api/v1/orders/[orderId]/cancel">) {
  await connection();
  const { orderId } = await ctx.params;
  return handleCancelOrder(request, { orderId }, cancelAppDeps);
}
