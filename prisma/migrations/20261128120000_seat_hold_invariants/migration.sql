-- Step 5 unit 2 (DECISIONS A-053 ③ ⑦, IMPLEMENTATION_PLAN §4.1 S2, DATABASE.md §13.3 / §19.14).
-- Raw SQL only: triggers and functions are not represented in schema.prisma (A-019), so the Prisma schema is unchanged.
BEGIN;

-- ═════════════════════════════ S2. seat status <-> live hold ═════════════════════════════
--
-- Invariant (INV-9): a session seat that is SOLD has no live hold, and a live hold is only ever created on an AVAILABLE
-- seat. "Live" is the EXISTING definition used by seat_holds_active_seat_uq, the quota counter and admin blocking:
-- status IN ('ACTIVE', 'CONFIRMING'). There is no time test here on purpose: seat_holds has no expiry column (the
-- expiry is orders.hold_expires_at, A-007), and an ACTIVE hold whose order expired stays live until expireOrder moves it
-- to EXPIRED (DATABASE.md §5.7, §11.2 pre-cleanup, SEAT-09). CONFIRMING is live whatever the time (D-003).
--
-- Guard A (immediate, BEFORE ROW): creating a live hold — INSERT of an ACTIVE/CONFIRMING row, or an UPDATE that turns a
-- non-live row live or moves a live row to another seat — locks the seat row FOR SHARE and requires it to be AVAILABLE.
--   * BEFORE, so the seat lock is taken before the hold row and its unique-index entry exist: a writer never holds a
--     hold index entry while waiting for a seat (no hold -> seat lock order inversion).
--   * FOR SHARE conflicts with the row lock of an UPDATE of session_seats, so a concurrent SOLD/BLOCKED transition and
--     the new hold are serialised on the seat row: whichever locks it first wins; the other one waits, then
--       - READ COMMITTED: re-reads the committed seat row (sees SOLD -> rejected) — or, for the SOLD side, sees the
--         committed hold in guard B (rejected at COMMIT);
--       - REPEATABLE READ / SERIALIZABLE: a seat updated after the snapshot makes FOR SHARE fail with 40001.
--   * Live -> live on the same seat (ACTIVE <-> CONFIRMING, Tx1 / payment failure) is not a new hold: no check and no
--     seat lock, so those transitions keep the §13.2 order (they lock seats themselves when they need to).
--   * Booking writers lock their seats FOR UPDATE in id order first (lockSeatsSorted); FOR SHARE on a row the
--     transaction already locks FOR UPDATE is a no-op.
--
-- Guard B (DEFERRABLE INITIALLY DEFERRED constraint trigger): at COMMIT, a seat whose status was set to SOLD in this
-- transaction must have no live hold. Deferred because the sale (Tx2, DATABASE.md §11.7) writes the seat (SOLD) and the
-- hold (CONFIRMING -> CONVERTED) in one transaction in either order; only the final state is meaningful. The function
-- re-reads current rows (the deferred event carries the row image of the statement).
--   * Guard B reads with the COMMIT-time statement snapshot, which sees holds committed by others only under
--     READ COMMITTED. Under REPEATABLE READ a hold committed after the snapshot would be invisible, so a SOLD transition
--     outside READ COMMITTED is refused (A-029 already requires READ COMMITTED for booking writes).
--
-- Both raise SQLSTATE 23514 (check_violation). The constraint name is set, but the driver does not pass it through for
-- trigger errors (measured, DATABASE.md §19.13): the application maps 23514 by transaction context.

CREATE FUNCTION "seat_holds_check_seat_available"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  seat_status text;
BEGIN
  IF NEW."status" NOT IN ('ACTIVE', 'CONFIRMING') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('ACTIVE', 'CONFIRMING') AND OLD."session_seat_id" = NEW."session_seat_id" THEN
    RETURN NEW; -- live -> live on the same seat: not a new hold
  END IF;
  SELECT s."status" INTO seat_status FROM "session_seats" s WHERE s."id" = NEW."session_seat_id" FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW; -- the composite FK reports the missing seat
  END IF;
  IF seat_status <> 'AVAILABLE' THEN
    RAISE EXCEPTION 'session seat % is %: a live hold requires an AVAILABLE seat', NEW."session_seat_id", seat_status
      USING ERRCODE = 'check_violation', TABLE = 'seat_holds', CONSTRAINT = 'seat_holds_live_seat_available_ck';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "seat_holds_live_seat_guard"
  BEFORE INSERT OR UPDATE OF "status", "session_seat_id" ON "seat_holds"
  FOR EACH ROW
  EXECUTE FUNCTION "seat_holds_check_seat_available"();

CREATE FUNCTION "session_seats_check_sold_no_live_hold"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur_status text;
BEGIN
  SELECT s."status" INTO cur_status FROM "session_seats" s WHERE s."id" = NEW."id";
  IF NOT FOUND OR cur_status <> 'SOLD' THEN
    RETURN NULL; -- the final state is not SOLD (e.g. sold and released again in the same transaction)
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'session seat % set to SOLD outside READ COMMITTED: live holds committed by others would be invisible', NEW."id"
      USING ERRCODE = 'check_violation', TABLE = 'session_seats', CONSTRAINT = 'session_seats_sold_read_committed_ck';
  END IF;
  PERFORM 1 FROM "seat_holds" h WHERE h."session_seat_id" = NEW."id" AND h."status" IN ('ACTIVE', 'CONFIRMING');
  IF FOUND THEN
    RAISE EXCEPTION 'session seat % is SOLD but still has a live hold', NEW."id"
      USING ERRCODE = 'check_violation', TABLE = 'session_seats', CONSTRAINT = 'session_seats_sold_no_live_hold_ck';
  END IF;
  RETURN NULL;
END;
$$;

-- INSERT is not covered on purpose: a seat inserted as SOLD cannot have a hold yet, and guard A refuses a live hold on it.
CREATE CONSTRAINT TRIGGER "session_seats_sold_hold_guard"
  AFTER UPDATE OF "status" ON "session_seats"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."status" = 'SOLD')
  EXECUTE FUNCTION "session_seats_check_sold_no_live_hold"();

-- Existing rows: the triggers do not look at history, so verify the invariant once. A violation aborts this migration
-- (it runs in one transaction) instead of installing a guard over inconsistent data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "session_seats" s JOIN "seat_holds" h ON h."session_seat_id" = s."id"
     WHERE h."status" IN ('ACTIVE', 'CONFIRMING') AND s."status" <> 'AVAILABLE'
  ) THEN
    RAISE EXCEPTION 'existing data violates S2: a SOLD/BLOCKED seat has a live hold; resolve it before applying this migration'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- ═════════════════════════════ A-041 (extension, A-053 ⑦). history and hold rows are never removed ═════════════════
--
-- order_status_logs, seat_status_logs: append-only (INSERT / SELECT). seat_holds: no physical DELETE — a hold ends by a
-- status transition (EXPIRED / RELEASED / CONVERTED), which stays allowed. The functions are the existing ones
-- (SQLSTATE 23001 restrict_violation). Referencing FKs are all ON DELETE RESTRICT, so no cascade reaches these rows.
-- Out of reach of row triggers (documented, DATABASE.md §19.14): TRUNCATE, and a table owner / superuser disabling the
-- triggers — controlled by DB role separation (Step 10, S9).

CREATE TRIGGER "order_status_logs_no_update" BEFORE UPDATE ON "order_status_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();
CREATE TRIGGER "order_status_logs_no_delete" BEFORE DELETE ON "order_status_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();
CREATE TRIGGER "seat_status_logs_no_update" BEFORE UPDATE ON "seat_status_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_update"();
CREATE TRIGGER "seat_status_logs_no_delete" BEFORE DELETE ON "seat_status_logs" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();
CREATE TRIGGER "seat_holds_no_delete" BEFORE DELETE ON "seat_holds" FOR EACH ROW EXECUTE FUNCTION "ledger_reject_delete"();

COMMIT;
