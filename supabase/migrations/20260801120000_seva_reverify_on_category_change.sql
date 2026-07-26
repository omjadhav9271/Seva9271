/* Seva — Step 9 follow-up: re-verify when the claim changes. Run AFTER 20260731120000.

   🔴 THE HOLE (found by probing Step 9's own thesis, "a provider cannot verify themselves"):

   Step 1 deliberately leaves category_id OUT of the client's UPDATE grant — what a provider is
   verified FOR is not theirs to edit. A direct UPDATE is correctly refused. But
   submit_provider_application is SECURITY DEFINER, so it runs as the table owner and column
   grants do not apply to it, and its ON CONFLICT branch happily writes category_id over an
   already-approved row while leaving status='approved' and is_verified=true untouched.

   Net effect: a verified electrician re-pointed their VERIFIED badge at Caretaker / Elderly Care
   — §7.1's flagged in-home, high-trust category — with no re-review. Worse, the row landed in
   status='approved' + kyc_status='submitted', a state the admin queue does not show ("to review"
   filters status='pending'), so the change was invisible to the people meant to catch it.

   This is the Step-9 spec's own §3 SQL, implemented verbatim; the spec assumed the only caller
   was a first-time or rejected applicant, and the upsert made the approved case reachable.

   THE RULE NOW: verification attests to a specific claim. Change the claim, re-earn the badge.
     - category changes on an approved/verified row  → back to pending + unverified, kyc
       'submitted', reason cleared, and the provider is TOLD (Step 9's honest-status bar); they
       reappear in the admin queue like any other applicant.
     - descriptive edits (name, bio, rate, city, area, experience) → unchanged behaviour, they
       never touched what was verified.
     - a verified row's kyc_documents are no longer silently replaceable: the evidence behind a
       granted badge stays put unless the row is going back for review. (Storage already froze
       the files themselves; this closes the metadata pointing at them.)
   Pending and rejected applicants are unaffected — resubmission works exactly as before. */

CREATE OR REPLACE FUNCTION public.submit_provider_application(
  p_category_id uuid, p_business_name text, p_bio text, p_experience_years int,
  p_hourly_rate numeric, p_city text, p_state text, p_address text,
  p_documents jsonb DEFAULT '[]'
) RETURNS service_providers LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  sp service_providers;
  v_old service_providers;
  v_requeued boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'must be signed in'; END IF;

  SELECT * INTO v_old FROM service_providers WHERE user_id = auth.uid();

  -- Is this a live, verified provider changing WHAT THEY ARE VERIFIED FOR?
  v_requeued := v_old.id IS NOT NULL
                AND (v_old.status = 'approved' OR v_old.is_verified)
                AND v_old.category_id IS DISTINCT FROM p_category_id;

  INSERT INTO service_providers (user_id, category_id, business_name, bio, experience_years,
                                 hourly_rate, city, state, address, kyc_documents,
                                 kyc_status, applied_at)
  VALUES (auth.uid(), p_category_id, p_business_name, p_bio, p_experience_years,
          p_hourly_rate, p_city, p_state, p_address, p_documents, 'submitted', now())
  ON CONFLICT (user_id) DO UPDATE SET
    category_id=EXCLUDED.category_id, business_name=EXCLUDED.business_name, bio=EXCLUDED.bio,
    experience_years=EXCLUDED.experience_years, hourly_rate=EXCLUDED.hourly_rate,
    city=EXCLUDED.city, state=EXCLUDED.state, address=EXCLUDED.address,
    -- keep the evidence behind a badge that has already been granted, unless we're re-reviewing
    kyc_documents = CASE
      WHEN v_requeued THEN EXCLUDED.kyc_documents
      WHEN service_providers.status = 'approved' OR service_providers.is_verified
        THEN service_providers.kyc_documents
      ELSE EXCLUDED.kyc_documents END,
    -- a changed claim goes back in the queue; everything else keeps its current state
    status      = CASE WHEN v_requeued THEN 'pending' ELSE service_providers.status END,
    is_verified = CASE WHEN v_requeued THEN false    ELSE service_providers.is_verified END,
    kyc_status  = 'submitted',
    applied_at  = now(),
    rejection_reason = NULL,
    reviewed_by = CASE WHEN v_requeued THEN NULL ELSE service_providers.reviewed_by END,
    reviewed_at = CASE WHEN v_requeued THEN NULL ELSE service_providers.reviewed_at END,
    updated_at  = now()
  RETURNING * INTO sp;

  -- Honest status (Step 9's bar): never let someone believe they're still live when they aren't.
  IF v_requeued THEN
    INSERT INTO notifications (user_id, title, message, type, link) VALUES (
      auth.uid(),
      'Back in review — your service changed',
      'You changed the service you offer, so your profile is paused while we re-verify it. '
        || 'Your reviews and history are untouched. This usually takes 24–48 hours.',
      'warning', '/become-provider');
  END IF;

  RETURN sp;
END; $$;
GRANT EXECUTE ON FUNCTION public.submit_provider_application(uuid,text,text,int,numeric,text,text,text,jsonb) TO authenticated;
