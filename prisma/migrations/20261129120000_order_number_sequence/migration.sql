-- Step 5 unit 3: order number (Q-025, DECISIONS A-053 ②, DATABASE.md §5.1 / §19.15).
-- Raw SQL only: sequences, functions and CHECK constraints are not represented in schema.prisma (A-019).
--
-- Format  NZ-YYYYMM-NNNNNN
--   YYYYMM  the month of the given instant in Asia/Seoul (explicit conversion; independent of the session TimeZone,
--           which the application fixes to UTC)
--   N…      ONE global sequence, never reset per month; at least 6 digits (zero padded), more digits when the number
--           grows past 999999 (never truncated — lpad() would cut a longer value, so it is only applied below 6 digits)
-- Gaps are allowed: nextval() is not rolled back with the transaction (a rolled-back order leaves its number unused).
-- An order number is a reference for people, never a secret or an access credential (A-053 ②, TEST ORD-11).
BEGIN;

-- Existing rows must already match the format the CHECK below enforces. Real order numbers are never rewritten here:
-- a mismatch aborts the whole migration (it runs in one transaction) and reports only the count.
DO $$
DECLARE
  bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM "orders" WHERE "order_number" !~ '^NZ-[0-9]{6}-[0-9]{6,}$';
  IF bad > 0 THEN
    RAISE EXCEPTION 'orders.order_number: % existing row(s) do not match ^NZ-[0-9]{6}-[0-9]{6,}$; review them before applying this migration (they are not changed automatically)', bad
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE SEQUENCE "order_number_seq"
  AS bigint
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  START WITH 1
  CACHE 1
  NO CYCLE;

-- VOLATILE (nextval). SECURITY INVOKER (default): the caller needs USAGE (or UPDATE) on order_number_seq — the
-- application role must be granted it when DB roles are separated (Step 10, S9). EXECUTE is granted to PUBLIC by
-- PostgreSQL's default for functions.
-- `at` defaults to now() = the transaction start time, i.e. the same instant as the order row's created_at default, so
-- the month in the number is the KST month of the order's creation.
CREATE FUNCTION "next_order_number"("at" timestamptz DEFAULT now()) RETURNS varchar(40)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  digits text;
BEGIN
  IF "at" IS NULL THEN
    RAISE EXCEPTION 'next_order_number: the instant must not be NULL' USING ERRCODE = 'null_value_not_allowed';
  END IF;
  digits := nextval('order_number_seq')::text;
  IF length(digits) < 6 THEN
    digits := lpad(digits, 6, '0');
  END IF;
  RETURN 'NZ-' || to_char("at" AT TIME ZONE 'Asia/Seoul', 'YYYYMM') || '-' || digits;
END;
$$;

ALTER TABLE "orders" ADD CONSTRAINT "orders_order_number_format_ck"
  CHECK ("order_number" ~ '^NZ-[0-9]{6}-[0-9]{6,}$');

COMMIT;
