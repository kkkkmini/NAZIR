import { connection } from "next/server";
import { orderAppDeps } from "@/server/booking/order-app-deps";
import { handleCreateOrder } from "@/server/booking/order-route";

/** Create an order: seats held for 7 minutes (API_SPEC §4.4). Request time only, never cached. */
export async function POST(request: Request) {
  await connection();
  return handleCreateOrder(request, orderAppDeps);
}
