/**
 * TZ-06: the pool configuration every application connection uses (src/server/db/pg-adapter.ts). No database.
 * The effect on real connections is TZ-01..TZ-05 (tests/contract/schema/timezone.test.ts).
 */
import { describe, expect, it } from "vitest";
import { DatabaseConfigError } from "@/server/config/database-config";
import { buildPgPoolConfig, PG_SESSION_OPTIONS } from "@/server/db/pg-adapter";

const URL_OK = "postgresql://nazir:secret-pw@db.example.com:5432/nazir_dev?sslmode=require";

describe("TZ-06 buildPgPoolConfig", () => {
  it("passes a clean connection string through unchanged and fixes the session TimeZone to UTC", () => {
    expect(buildPgPoolConfig(URL_OK)).toEqual({ connectionString: URL_OK, options: "-c TimeZone=UTC" });
    expect(PG_SESSION_OPTIONS).toBe("-c TimeZone=UTC");
  });

  it.each([
    ["a trailing newline", `${URL_OK}\n`],
    ["leading and trailing spaces", `  ${URL_OK}  `],
    ["tabs and CRLF", `\t${URL_OK}\r\n`],
  ])("trims %s and hands pg exactly the string it validated", (_label, raw) => {
    const config = buildPgPoolConfig(raw);
    expect(config.connectionString).toBe(URL_OK);
    expect(config.options).toBe(PG_SESSION_OPTIONS);
  });

  it("still refuses `options` hidden behind surrounding whitespace", () => {
    expect(() => buildPgPoolConfig(`  postgresql://u:secret-pw@h/nazir_dev?options=x \n`)).toThrow(DatabaseConfigError);
  });

  it.each([
    ["options", "?options=-c%20TimeZone%3DAsia%2FSeoul"],
    ["upper-case key", "?OPTIONS=-c%20TimeZone%3DAsia%2FSeoul"],
    ["among other params", "?sslmode=require&options=-c%20search_path%3Dx"],
    ["empty value", "?options="],
  ])("refuses a URL that sets its own `options` (%s)", (_label, query) => {
    expect(() => buildPgPoolConfig(`postgresql://u:secret-pw@h/nazir_dev${query}`)).toThrow(DatabaseConfigError);
  });

  it.each([[undefined], [""], ["   "], ["not a url"]])("refuses a missing or malformed URL (%j)", (raw) => {
    expect(() => buildPgPoolConfig(raw)).toThrow(DatabaseConfigError);
  });

  it.each([
    ["an options URL", "postgresql://u:secret-pw@h/nazir_dev?options=x"],
    ["a malformed URL", "postgresql://u:secret-pw@[bad-host/nazir_dev"],
  ])("never echoes the password in its errors (%s)", (_label, raw) => {
    try {
      buildPgPoolConfig(raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DatabaseConfigError);
      expect(String((e as Error).message)).not.toContain("secret-pw");
    }
  });
});
