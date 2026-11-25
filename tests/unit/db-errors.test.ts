/** M7-U01 (A-051): the three error shapes dbConstraintOf understands, and claim error mapping / name masking. */
import { describe, expect, it } from "vitest";
import { dbConstraintOf } from "@/server/db/errors";
import { mapClaimDbError, maskName } from "@/server/identity/session";

describe("M7-U01 dbConstraintOf", () => {
  it("Prisma statement-time error (meta.driverAdapterError.cause), including a P2003-disguised 23001", () => {
    expect(dbConstraintOf({ code: "P2002", meta: { driverAdapterError: { cause: { originalCode: "23505", constraint: { index: "x_uq" } } } } })).toEqual({ sqlState: "23505", constraint: "x_uq" });
    expect(dbConstraintOf({ code: "P2003", meta: { driverAdapterError: { cause: { originalCode: "23001", constraint: "t" } } } })).toEqual({ sqlState: "23001", constraint: "t" });
  });
  it("COMMIT-time DriverAdapterError (cause.originalCode, constraint may be absent)", () => {
    expect(dbConstraintOf({ name: "DriverAdapterError", cause: { originalCode: "23514" } })).toEqual({ sqlState: "23514", constraint: null });
  });
  it("node-pg DatabaseError", () => {
    expect(dbConstraintOf({ code: "23503", constraint: "fk", severity: "ERROR" })).toEqual({ sqlState: "23503", constraint: "fk" });
  });
  it("anything else → null; messages are never read", () => {
    for (const e of [null, undefined, "23505", new Error("23505 duplicate"), { code: "P2002" }, { name: "DriverAdapterError", cause: { originalCode: "bad" } }]) expect(dbConstraintOf(e)).toBeNull();
  });
  it("claim mapping", () => {
    expect(mapClaimDbError({ name: "DriverAdapterError", cause: { originalCode: "23514" } })?.code).toBe("IDENTITY_VERIFICATION_FAILED");
    expect(mapClaimDbError({ code: "23503", constraint: "identity_sessions_verification_claim_fk", severity: "ERROR" })?.code).toBe("BROWSER_BINDING_MISMATCH");
    expect(mapClaimDbError({ code: "23505", constraint: "identity_sessions_active_binding_uq", severity: "ERROR" })?.code).toBe("IDENTITY_VERIFICATION_FAILED");
    expect(mapClaimDbError({ code: "23505", constraint: "orders_order_number_uq", severity: "ERROR" })).toBeNull();
  });
  it("maskName", () => {
    expect([maskName("홍길동"), maskName("홍길"), maskName("홍"), maskName("남궁민수")]).toEqual(["홍*동", "홍*", "*", "남**수"]);
  });
});
