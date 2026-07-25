/* Seva — Step 8 follow-up: lock dispute_fault_rate down to server-only.

   The Step-8 migration (20260728120000) granted EXECUTE on dispute_fault_rate to service_role but
   never revoked Postgres's DEFAULT public EXECUTE grant — so authenticated (and anon) could read
   any provider's or customer's dispute-fault rate directly. Its sibling engine functions
   (compute_reputation, recompute_all_reputation, credit_wallet) are all revoked from
   public/anon/authenticated and granted only to service_role; this makes dispute_fault_rate match.

   Safe: dispute_fault_rate is called from inside compute_reputation, whose owner (superuser)
   bypasses grant checks, so the internal call keeps working; only direct client calls are closed. */
REVOKE EXECUTE ON FUNCTION public.dispute_fault_rate(text,uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.dispute_fault_rate(text,uuid) TO service_role;
