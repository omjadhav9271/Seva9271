/* One-off seed for the Step-8 BROWSER test: creates a realistic disputable booking for test2
   (customer) with test1's real provider profile, a captured escrow ledger row, a short chat
   thread, and a plausible event timeline — so the /bookings/[id] "Report a problem" flow and the
   admin evidence bundle have real content to show. Prints the booking id + url.

   Two shapes, because the settlement summary reads differently in each:
     (default)   in_progress + escrow HELD  → resolving pays out of money we still hold
     --released  paid + escrow ALREADY RELEASED (a real payout event + the wallet credit behind
                 it) → resolving in the customer's favour must CLAW BACK from the provider's
                 wallet. That branch is nearly impossible to reach by hand, and it's the one the
                 settlement card has the most to explain.

   Run:  node scripts/seed-step8-browser.mjs [--released]
   Undo: node scripts/seed-step8-browser.mjs --clean   (deletes bookings tagged in notes) */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });

const TAG = 'STEP8-BROWSER-SEED';
const test1Email = 'test1@gmail.com', test2Email = 'test2@gmail.com';

const uid = async (email) => {
  // service role can read auth via admin API
  const { data, error } = await service.auth.admin.listUsers();
  if (error) throw new Error('listUsers: ' + error.message);
  const u = data.users.find((x) => x.email === email);
  if (!u) throw new Error('no user ' + email);
  return u.id;
};

const test1Id = await uid(test1Email);
const test2Id = await uid(test2Email);

if (process.argv.includes('--clean')) {
  const { data: bks } = await service.from('bookings').select('id, provider_id, customer_id, created_at').eq('notes', TAG);
  const rows = bks ?? [];
  const ids = rows.map((b) => b.id);
  if (!ids.length) { console.log('nothing to clean.'); process.exit(0); }

  // reverse any wallet movement these bookings caused (a favor_provider payout / a clawback)
  const { data: wt } = await service.from('wallet_transactions').select('user_id, type, amount').in('reference_id', ids);
  const net = {};
  for (const t of wt ?? []) { const d = t.type === 'debit' ? -Number(t.amount) : Number(t.amount); net[t.user_id] = (net[t.user_id] || 0) + d; }
  for (const [uid, delta] of Object.entries(net)) {
    const { data: p } = await service.from('profiles').select('wallet_balance').eq('id', uid).maybeSingle();
    await service.from('profiles').update({ wallet_balance: Number(p?.wallet_balance || 0) - delta }).eq('id', uid);
    console.log(`  wallet restored for ${uid}: reversed ${delta >= 0 ? '+' : ''}${delta}`);
  }

  for (const id of ids) await service.from('notifications').delete().like('link', `/bookings/${id}%`);
  await service.from('wallet_transactions').delete().in('reference_id', ids);
  await service.from('bookings').delete().in('id', ids); // cascades dispute/paytx/messages/events

  // recompute the involved reputations so scores reflect reality without the test bookings
  const since = rows.map((b) => b.created_at).sort()[0];
  for (const pid of [...new Set(rows.map((b) => b.provider_id))]) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'provider').eq('subject_id', pid).gte('computed_at', since);
    await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: pid });
  }
  for (const cid of [...new Set(rows.map((b) => b.customer_id))]) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'customer').eq('subject_id', cid).gte('computed_at', since);
    await service.rpc('compute_reputation', { p_subject_type: 'customer', p_subject_id: cid });
  }
  console.log(`cleaned ${ids.length} seeded booking(s); wallet + reputation restored.`);
  process.exit(0);
}

// test1's real provider profile
const { data: sp } = await service.from('service_providers')
  .select('id, business_name').eq('user_id', test1Id).limit(1).maybeSingle();
if (!sp) throw new Error('test1 owns no service_providers profile');
const { data: cat } = await service.from('service_categories').select('id').limit(1).maybeSingle();

const RELEASED = process.argv.includes('--released');
const AMOUNT = 800;
// what the escrow release would have taken and paid, at the live fee
const { data: feeRow } = await service.rpc('platform_fee_pct');
const FEE = Math.round(AMOUNT * Number(feeRow ?? 0.01) * 100) / 100;
const PAYOUT = AMOUNT - FEE;

// the booking. Held: money is still ours to move. Released: the provider has already been paid.
const { data: bk, error: bkErr } = await service.from('bookings').insert({
  customer_id: test2Id, provider_id: sp.id, category_id: cat?.id ?? null,
  service_type: 'one-time', scheduled_date: '2026-07-24', scheduled_time: '15:00',
  duration_hours: 2, hourly_rate: 400, total_amount: AMOUNT, price_charged: AMOUNT,
  payment_method: 'upi',
  status: RELEASED ? 'paid' : 'in_progress',
  payment_status: RELEASED ? 'released' : 'held',
  notes: TAG,
}).select('id').single();
if (bkErr) throw new Error('booking insert: ' + bkErr.message);
const bId = bk.id;

// the escrow ledger row (paise): captured, or already split and released
await service.from('payment_transactions').insert({
  booking_id: bId, razorpay_order_id: 'order_s8browser_' + Date.now(),
  razorpay_payment_id: 'pay_s8browser_' + Date.now(), amount: AMOUNT * 100,
  status: RELEASED ? 'released' : 'captured',
  provider_amount: RELEASED ? PAYOUT : null,
  platform_fee: RELEASED ? FEE : null,
});

// a plausible timeline. NOTE: never insert a 'confirmed' event here — trg_release_escrow fires on
// exactly that and would pay the provider a SECOND time. The released shape therefore writes the
// system 'paid' event itself, carrying the meta.payout that proves the escrow was already out.
const t = (min) => new Date(Date.now() - min * 60000).toISOString();
const ev = [
  { from_status: null, to_status: 'requested', actor_id: test2Id, actor_role: 'customer', created_at: t(180) },
  { from_status: 'requested', to_status: 'accepted', actor_id: test1Id, actor_role: 'provider', created_at: t(160) },
  { from_status: 'accepted', to_status: 'en_route', actor_id: test1Id, actor_role: 'provider', created_at: t(90) },
  { from_status: 'en_route', to_status: 'arrived', actor_id: test1Id, actor_role: 'provider', created_at: t(60) },
  { from_status: 'arrived', to_status: 'in_progress', actor_id: test1Id, actor_role: 'provider', created_at: t(45) },
];
if (RELEASED) {
  ev.push(
    { from_status: 'in_progress', to_status: 'completed', actor_id: test1Id, actor_role: 'provider', created_at: t(35) },
    { from_status: 'confirmed', to_status: 'paid', actor_id: null, actor_role: 'system', created_at: t(30),
      meta: { payout: PAYOUT, fee: FEE } },
  );
}
for (const e of ev) await service.from('booking_events').insert({ booking_id: bId, meta: {}, ...e });

// the payout the provider actually banked — so a clawback has something to pull back
if (RELEASED) {
  await service.rpc('credit_wallet', {
    p_user_id: test1Id, p_amount: PAYOUT, p_type: 'credit',
    p_description: 'Payout for booking ' + bId, p_reference_id: bId,
  });
}

// a short chat thread for the evidence bundle
await service.from('messages').insert([
  { booking_id: bId, sender_id: test1Id, body: 'On my way, will reach by 3pm.', created_at: t(95) },
  { booking_id: bId, sender_id: test2Id, body: 'Ok. Please bring the tools for the sink.', created_at: t(92) },
  { booking_id: bId, sender_id: test2Id, body: 'You started but left without finishing the job.', created_at: t(20) },
]);

console.log('SEEDED booking for the Step-8 browser test');
console.log('  shape:', RELEASED
  ? `paid / escrow ALREADY RELEASED — ₹${PAYOUT} is in the provider's wallet, ₹${FEE} kept as fee.`
    + '\n         Resolve it "Favour customer" to exercise the clawback settlement.'
  : `in_progress / escrow HELD — ₹${AMOUNT} still in escrow.`);
console.log('  provider:', sp.business_name, '(' + sp.id + ')');
console.log('  booking id:', bId);
console.log('  url: http://localhost:3000/bookings/' + bId);
