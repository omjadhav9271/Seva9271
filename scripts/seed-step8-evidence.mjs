/* One-off seed for the Step-8.5 EVIDENCE browser test. Creates a disputable booking for test2
   (customer) with test1's real provider, then opens a dispute directly (service role can't call
   raise_dispute, which needs auth.uid()), plus a chat thread + timeline — so /bookings/[id] shows
   the "Your evidence" panel immediately and the admin bundle has content. Also writes two sample
   image files to upload. Prints ids, the booking url, and the image paths.

   Run:  node scripts/seed-step8-evidence.mjs
   Undo: node scripts/seed-step8-evidence.mjs --clean   (deletes tagged bookings + their storage) */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TAG = 'STEP8-EVIDENCE-SEED';
const BUCKET = 'dispute-evidence';
const SCRATCH = 'C:/Users/omjad/AppData/Local/Temp/claude/D--Resume-Projects-Seva9271/5ca469b5-b7fd-4af5-8254-5abf9f07c2cd/scratchpad';

const uidOf = async (email) => {
  const { data, error } = await service.auth.admin.listUsers();
  if (error) throw new Error('listUsers: ' + error.message);
  const u = data.users.find((x) => x.email === email);
  if (!u) throw new Error('no user ' + email);
  return u.id;
};
const test1Id = await uidOf('test1@gmail.com');
const test2Id = await uidOf('test2@gmail.com');

if (process.argv.includes('--clean')) {
  const { data: bks } = await service.from('bookings').select('id, provider_id, customer_id, created_at').eq('notes', TAG);
  const rows = bks ?? [];
  const ids = rows.map((b) => b.id);
  if (!ids.length) { console.log('nothing to clean.'); process.exit(0); }
  // remove storage objects under each dispute folder
  const { data: disp } = await service.from('disputes').select('id').in('booking_id', ids);
  for (const d of disp ?? []) {
    const { data: objs } = await service.storage.from(BUCKET).list(d.id);
    if (objs?.length) await service.storage.from(BUCKET).remove(objs.map((o) => `${d.id}/${o.name}`));
  }
  const { data: wt } = await service.from('wallet_transactions').select('user_id, type, amount').in('reference_id', ids);
  const net = {};
  for (const t of wt ?? []) { const del = t.type === 'debit' ? -Number(t.amount) : Number(t.amount); net[t.user_id] = (net[t.user_id] || 0) + del; }
  for (const [uid, delta] of Object.entries(net)) {
    const { data: p } = await service.from('profiles').select('wallet_balance').eq('id', uid).maybeSingle();
    await service.from('profiles').update({ wallet_balance: Number(p?.wallet_balance || 0) - delta }).eq('id', uid);
  }
  for (const id of ids) await service.from('notifications').delete().like('link', `/bookings/${id}%`);
  await service.from('wallet_transactions').delete().in('reference_id', ids);
  await service.from('bookings').delete().in('id', ids); // cascades disputes + dispute_evidence
  const since = rows.map((b) => b.created_at).sort()[0];
  for (const pid of [...new Set(rows.map((b) => b.provider_id))]) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'provider').eq('subject_id', pid).gte('computed_at', since);
    await service.rpc('compute_reputation', { p_subject_type: 'provider', p_subject_id: pid });
  }
  for (const cid of [...new Set(rows.map((b) => b.customer_id))]) {
    await service.from('reputation_snapshots').delete().eq('subject_type', 'customer').eq('subject_id', cid).gte('computed_at', since);
    await service.rpc('compute_reputation', { p_subject_type: 'customer', p_subject_id: cid });
  }
  console.log(`cleaned ${ids.length} seeded booking(s) + storage; wallet + reputation restored.`);
  process.exit(0);
}

// --- tiny solid-colour PNG generator (no deps) ---
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; }
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) { raw[p++] = 0; for (let x = 0; x < width; x++) { raw[p++] = r; raw[p++] = g; raw[p++] = b; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const custImg = `${SCRATCH}/customer-evidence.png`;
const provImg = `${SCRATCH}/provider-evidence.png`;
writeFileSync(custImg, png(320, 200, [255, 153, 51]));   // saffron
writeFileSync(provImg, png(320, 200, [19, 136, 8]));     // green

// --- booking + open dispute ---
const { data: sp } = await service.from('service_providers').select('id, business_name').eq('user_id', test1Id).limit(1).maybeSingle();
const { data: cat } = await service.from('service_categories').select('id').limit(1).maybeSingle();
const { data: bk } = await service.from('bookings').insert({
  customer_id: test2Id, provider_id: sp.id, category_id: cat?.id ?? null, service_type: 'one-time',
  scheduled_date: '2026-07-25', scheduled_time: '14:00', duration_hours: 2, hourly_rate: 400,
  total_amount: 800, price_charged: 800, payment_method: 'upi', status: 'disputed', payment_status: 'held', notes: TAG,
}).select('id').single();
const bId = bk.id;
await service.from('payment_transactions').insert({
  booking_id: bId, razorpay_order_id: 'order_ev_' + Date.now(), razorpay_payment_id: 'pay_ev_' + Date.now(), amount: 80000, status: 'captured',
});
const t = (min) => new Date(Date.now() - min * 60000).toISOString();
for (const e of [
  { from_status: null, to_status: 'requested', actor_id: test2Id, actor_role: 'customer', created_at: t(180) },
  { from_status: 'requested', to_status: 'accepted', actor_id: test1Id, actor_role: 'provider', created_at: t(150) },
  { from_status: 'accepted', to_status: 'en_route', actor_id: test1Id, actor_role: 'provider', created_at: t(90) },
  { from_status: 'en_route', to_status: 'arrived', actor_id: test1Id, actor_role: 'provider', created_at: t(70) },
  { from_status: 'arrived', to_status: 'in_progress', actor_id: test1Id, actor_role: 'provider', created_at: t(55) },
]) await service.from('booking_events').insert({ booking_id: bId, meta: {}, ...e });
await service.from('messages').insert([
  { booking_id: bId, sender_id: test1Id, body: 'Reached, starting now.', created_at: t(60) },
  { booking_id: bId, sender_id: test2Id, body: 'You left without finishing — I have photos.', created_at: t(20) },
]);
const { data: d } = await service.from('disputes').insert({
  booking_id: bId, raised_by: test2Id, raiser_role: 'customer', reason: 'work_not_done',
  description: 'Provider left the job unfinished. Attaching photos as evidence.', status: 'open',
}).select('id').single();
await service.from('booking_events').insert({ booking_id: bId, from_status: 'in_progress', to_status: 'disputed', actor_id: test2Id, actor_role: 'customer', meta: { dispute_id: d.id, reason: 'work_not_done' } });

console.log('SEEDED Step-8.5 evidence test');
console.log('  provider :', sp.business_name);
console.log('  booking  :', bId);
console.log('  dispute  :', d.id, '(open)');
console.log('  url      : http://localhost:3000/bookings/' + bId);
console.log('  customer image:', custImg);
console.log('  provider image:', provImg);
