/* Seva — self-contained demo provider seed (Mumbai). Run AFTER the hardening migration.

   The old seed in 20260622131542 attached samples to (SELECT id FROM auth.users LIMIT 1),
   which inserts NOTHING on a fresh DB. Because service_providers.user_id is
   NOT NULL REFERENCES auth.users(id), a self-contained seed must create the backing
   auth.users rows too. These are passwordless placeholder accounts (encrypted_password '')
   used only to own the demo listings — they cannot sign in.

   The handle_new_user trigger auto-creates each provider's profiles row, and
   create_provider_working_hours auto-creates their weekly hours. Idempotent via ON CONFLICT.
*/

-- 1) Backing auth.users for the four demo providers.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change, email_change_token_new
) VALUES
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'ramesh.electrician@seva.demo', '',
   NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Ramesh Kadam"}'::jsonb, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'sunita.cleaning@seva.demo', '',
   NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Sunita Sharma"}'::jsonb, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated', 'imran.plumber@seva.demo', '',
   NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Imran Shaikh"}'::jsonb, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated', 'lata.cook@seva.demo', '',
   NOW(), NOW(), NOW(), '{"provider":"email","providers":["email"]}'::jsonb, '{"full_name":"Lata Iyer"}'::jsonb, '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- 2) The four demo service_providers (all Mumbai, approved + verified).
INSERT INTO service_providers (
  id, user_id, category_id, business_name, bio, experience_years, hourly_rate,
  rating, total_reviews, total_bookings, is_verified, is_available,
  city, state, address, latitude, longitude, phone, status
) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   (SELECT id FROM service_categories WHERE slug = 'electrician'),
   'Ramesh Kadam', 'Licensed electrician with 9 years experience across Andheri & Jogeshwari. Wiring, switchboards, fan & inverter installation, MCB and fault-finding. ISI-marked materials, 6-month workmanship warranty.',
   9, 350, 4.9, 128, 540, true, true, 'Mumbai', 'Maharashtra', 'Andheri West, Mumbai', 19.1364, 72.8296, '+91 98200 11111', 'approved'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222',
   (SELECT id FROM service_categories WHERE slug = 'house-cleaning'),
   'Sunita Sharma', 'Professional home cleaning in Bandra & Khar. Deep cleaning, kitchen & bathroom scrub, post-renovation and move-in/move-out. Brings own eco-friendly supplies, systematic room-by-room approach.',
   6, 250, 4.8, 205, 610, true, true, 'Mumbai', 'Maharashtra', 'Bandra East, Mumbai', 19.0607, 72.8362, '+91 98200 22222', 'approved'),
  ('aaaaaaaa-0000-4000-8000-000000000003', '33333333-3333-4333-8333-333333333333',
   (SELECT id FROM service_categories WHERE slug = 'plumber'),
   'Imran Shaikh', 'Plumber serving Kurla, Chembur & Ghatkopar. Leak repairs, geyser & tap fitting, bathroom installation and drainage. Emergency call-outs available.',
   11, 300, 4.7, 96, 430, true, true, 'Mumbai', 'Maharashtra', 'Kurla West, Mumbai', 19.0726, 72.8845, '+91 98200 33333', 'approved'),
  ('aaaaaaaa-0000-4000-8000-000000000004', '44444444-4444-4444-8444-444444444444',
   (SELECT id FROM service_categories WHERE slug = 'home-cook'),
   'Lata Iyer', 'Home cook & tiffin service in Powai & Vikhroli. Fresh South-Indian and Maharashtrian meals, daily tiffins for professionals and students, small-event catering.',
   7, 200, 4.85, 312, 720, true, true, 'Mumbai', 'Maharashtra', 'Powai, Mumbai', 19.1176, 72.9060, '+91 98200 44444', 'approved')
ON CONFLICT (id) DO NOTHING;
