/** JOB-U01: scheduled-job authentication is fail-closed and exact. */
import { describe, expect, it } from "vitest";
import { MIN_CRON_SECRET_LENGTH, checkCronAuthorization } from "@/server/jobs/cron-auth";

const SECRET = "s".repeat(MIN_CRON_SECRET_LENGTH);
const h = (auth?: string) => new Headers(auth === undefined ? {} : { authorization: auth });

describe("JOB-U01 checkCronAuthorization", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(checkCronAuthorization(h(`Bearer ${SECRET}`), SECRET)).toEqual({ ok: true });
    expect(checkCronAuthorization(h(`Bearer ${SECRET}`), `  ${SECRET}\n`)).toEqual({ ok: true }); // env value whitespace
  });
  it.each([[undefined], [""], ["Bearer"], [`bearer ${SECRET}`], [`Bearer ${SECRET}x`], [`Bearer ${SECRET.slice(1)}`], [SECRET], [`Basic ${SECRET}`]])(
    "refuses %j with 401",
    (auth) => expect(checkCronAuthorization(h(auth), SECRET)).toEqual({ ok: false, status: 401, code: "JOB_UNAUTHORIZED" }),
  );
  it.each([[undefined], [""], ["   "], ["s".repeat(MIN_CRON_SECRET_LENGTH - 1)]])("no usable secret (%j) → 503, never runs, even with a matching header", (secret) => {
    expect(checkCronAuthorization(h(`Bearer ${secret ?? ""}`), secret)).toEqual({ ok: false, status: 503, code: "JOB_UNAVAILABLE" });
    expect(checkCronAuthorization(h("Bearer "), secret)).toEqual({ ok: false, status: 503, code: "JOB_UNAVAILABLE" });
  });
});
