/*
# Seva Indian Services Expansion & KYC System

## Overview
This migration expands the Seva platform to support 25+ Indian-context service categories
and adds a comprehensive KYC (Know Your Customer) verification system for providers.

## New Service Categories (11 added, total 25)
Adding services specifically for Indian market: painter, mason, laundry, security guard,
maid, washerman, auto driver, cycle mechanic, mobile repair, water tanker, cow dung
and other Indian-context services.

## New Tables
- `provider_kyc` - Stores Indian KYC documents (Aadhaar, PAN, Voter ID, etc.)
- `provider_working_hours` - Stores provider availability schedule
- `provider_services` - Junction table for providers offering multiple services

## Modified Tables
- `service_categories` - Adding 11 new categories with proper icon mappings
- `service_providers` - Adding work_address, phone, working_hours, opening_hours, closing_hours columns

## Security
- All new tables have RLS enabled with appropriate policies
- Provider KYC is scoped to provider owner only
- Working hours are scoped to provider owner only
- Provider services are publicly readable
*/

-- ============================================
-- 1. FIX EXISTING SERVICE CATEGORIES (swap icon and color where they were reversed)
-- ============================================

UPDATE service_categories SET icon = 'Zap', color = '#FF9933', bg_color = '#3d2800' WHERE slug = 'electrician';
UPDATE service_categories SET icon = 'Wrench', color = '#3b82f6', bg_color = '#1e293b' WHERE slug = 'plumber';
UPDATE service_categories SET icon = 'ChefHat', color = '#ef4444', bg_color = '#2d1515' WHERE slug = 'home-cook';
UPDATE service_categories SET icon = 'Sparkles', color = '#22c55e', bg_color = '#0f2d0f' WHERE slug = 'house-cleaning';
UPDATE service_categories SET icon = 'Heart', color = '#ec4899', bg_color = '#2d0f1f' WHERE slug = 'caretaker';
UPDATE service_categories SET icon = 'Car', color = '#94a3b8', bg_color = '#1e293b' WHERE slug = 'driver';
UPDATE service_categories SET icon = 'Stethoscope', color = '#14b8a6', bg_color = '#0d2626' WHERE slug = 'doctor';
UPDATE service_categories SET icon = 'GraduationCap', color = '#a855f7', bg_color = '#1f0d2d' WHERE slug = 'tutor';
UPDATE service_categories SET icon = 'Settings', color = '#6366f1', bg_color = '#1a1a3e' WHERE slug = 'appliance-repair';
UPDATE service_categories SET icon = 'Hammer', color = '#f59e0b', bg_color = '#2d1f00' WHERE slug = 'carpenter';
UPDATE service_categories SET icon = 'Leaf', color = '#84cc16', bg_color = '#1a2d00' WHERE slug = 'gardening';
UPDATE service_categories SET icon = 'Scissors', color = '#f43f5e', bg_color = '#2d0f15' WHERE slug = 'beauty';
UPDATE service_categories SET icon = 'ShoppingBasket', color = '#10b981', bg_color = '#0a2d1a' WHERE slug = 'farm-fresh';
UPDATE service_categories SET icon = 'Truck', color = '#f97316', bg_color = '#2d1500' WHERE slug = 'delivery';

-- ============================================
-- 2. ADD NEW SERVICE CATEGORIES (11 more for Indian context)
-- ============================================

INSERT INTO service_categories (name, slug, description, icon, color, bg_color) VALUES
  ('Painter', 'painter', 'Wall painting, waterproofing, texture paint', 'PaintBucket', '#f59e0b', '#2d1f00'),
  ('Mason / Labour', 'mason', 'Building work, plaster, brick work', 'HardHat', '#d97706', '#2d2000'),
  ('Laundry & Ironing', 'laundry', 'Wash, dry, iron, home pickup', 'Shirt', '#06b6d4', '#0d2d35'),
  ('Security Guard', 'security', 'Building security, night guard', 'Shield', '#64748b', '#1a1a2e'),
  ('Maid / House Help', 'maid', 'Daily house help, dish washing, dusting', 'Home', '#f472b6', '#2d0f20'),
  ('Auto Rickshaw / Bike Taxi', 'auto-driver', 'Auto ride, bike taxi, school drop', 'Bike', '#f59e0b', '#2d1f00'),
  ('Cycle Repair / Bicycle', 'cycle-mechanic', 'Cycle repair, puncture, new cycles', 'CircleDot', '#22c55e', '#0f2d0f'),
  ('Mobile Repair / Accessories', 'mobile-repair', 'Phone repair, screen, charging, accessories', 'Smartphone', '#6366f1', '#1a1a3e'),
  ('Water Tanker / RO', 'water-tanker', 'Drinking water, tanker, RO repair', 'Droplets', '#0ea5e9', '#0d1f2d'),
  ('Cow Dung / Gobar', 'cow-dung', 'Gobar gas, organic manure, dung cake', 'Flame', '#a16207', '#2d2200'),
  ('Tailor / Stitching', 'tailor', 'Clothing alterations, stitching, saree', 'Scissors', '#d946ef', '#2d0f2d')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  color = EXCLUDED.color,
  bg_color = EXCLUDED.bg_color;

-- ============================================
-- 3. ADD NEW COLUMNS TO SERVICE_PROVIDERS
-- ============================================

ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS work_address TEXT;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS opening_hours TEXT DEFAULT '09:00';
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS closing_hours TEXT DEFAULT '18:00';
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS working_days TEXT[] DEFAULT ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

-- ============================================
-- 4. PROVIDER KYC TABLE (Indian Context)
-- ============================================

CREATE TABLE IF NOT EXISTS provider_kyc (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  -- Identity Documents
  aadhaar_number TEXT,
  aadhaar_verified BOOLEAN DEFAULT FALSE,
  pan_number TEXT,
  pan_verified BOOLEAN DEFAULT FALSE,
  voter_id TEXT,
  voter_id_verified BOOLEAN DEFAULT FALSE,
  -- Address Proof
  address_proof_type TEXT CHECK (address_proof_type IN ('aadhaar', 'voter', 'passport', 'electricity_bill', 'rent_agreement')),
  address_proof_number TEXT,
  -- Photo Verification
  photo_url TEXT,
  -- Background Check
  background_check_status TEXT DEFAULT 'pending' CHECK (background_check_status IN ('pending', 'in_progress', 'verified', 'rejected')),
  background_check_notes TEXT,
  -- Police Verification
  police_verification_status TEXT DEFAULT 'pending' CHECK (police_verification_status IN ('pending', 'submitted', 'verified', 'rejected')),
  police_verification_doc TEXT,
  -- Emergency Contact
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  emergency_contact_relation TEXT,
  -- Created / Updated
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider_id)
);

ALTER TABLE provider_kyc ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_kyc_select_own" ON provider_kyc;
CREATE POLICY "provider_kyc_select_own" ON provider_kyc FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_kyc.provider_id AND user_id = auth.uid())
);

DROP POLICY IF EXISTS "provider_kyc_insert_own" ON provider_kyc;
CREATE POLICY "provider_kyc_insert_own" ON provider_kyc FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_kyc.provider_id AND user_id = auth.uid())
);

DROP POLICY IF EXISTS "provider_kyc_update_own" ON provider_kyc;
CREATE POLICY "provider_kyc_update_own" ON provider_kyc FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_kyc.provider_id AND user_id = auth.uid())
) WITH CHECK (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_kyc.provider_id AND user_id = auth.uid())
);

-- ============================================
-- 5. PROVIDER WORKING HOURS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS provider_working_hours (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  day_of_week TEXT NOT NULL CHECK (day_of_week IN ('Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun')),
  is_open BOOLEAN DEFAULT TRUE,
  open_time TEXT DEFAULT '09:00',
  close_time TEXT DEFAULT '18:00',
  UNIQUE(provider_id, day_of_week)
);

ALTER TABLE provider_working_hours ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_hours_select" ON provider_working_hours;
CREATE POLICY "provider_hours_select" ON provider_working_hours FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "provider_hours_update_own" ON provider_working_hours;
CREATE POLICY "provider_hours_update_own" ON provider_working_hours FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_working_hours.provider_id AND user_id = auth.uid())
) WITH CHECK (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_working_hours.provider_id AND user_id = auth.uid())
);

DROP POLICY IF EXISTS "provider_hours_insert_own" ON provider_working_hours;
CREATE POLICY "provider_hours_insert_own" ON provider_working_hours FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_working_hours.provider_id AND user_id = auth.uid())
);

-- ============================================
-- 6. FUNCTION TO AUTO-CREATE WORKING HOURS
-- ============================================

CREATE OR REPLACE FUNCTION public.create_provider_working_hours()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO provider_working_hours (provider_id, day_of_week, is_open, open_time, close_time)
  SELECT
    NEW.id,
    d.day,
    CASE WHEN d.day = 'Sun' THEN FALSE ELSE TRUE END,
    COALESCE(NEW.opening_hours, '09:00'),
    COALESCE(NEW.closing_hours, '18:00')
  FROM (VALUES ('Mon'), ('Tue'), ('Wed'), ('Thu'), ('Fri'), ('Sat'), ('Sun')) AS d(day)
  ON CONFLICT (provider_id, day_of_week) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS create_working_hours_on_provider ON service_providers;
CREATE TRIGGER create_working_hours_on_provider
  AFTER INSERT ON service_providers
  FOR EACH ROW EXECUTE FUNCTION public.create_provider_working_hours();

-- ============================================
-- 7. PROVIDER SERVICES (JUNCTION TABLE)
-- ============================================

CREATE TABLE IF NOT EXISTS provider_services (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
  price_estimate NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider_id, category_id)
);

ALTER TABLE provider_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_services_select" ON provider_services;
CREATE POLICY "provider_services_select" ON provider_services FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "provider_services_insert_own" ON provider_services;
CREATE POLICY "provider_services_insert_own" ON provider_services FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_services.provider_id AND user_id = auth.uid())
);

DROP POLICY IF EXISTS "provider_services_delete_own" ON provider_services;
CREATE POLICY "provider_services_delete_own" ON provider_services FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM service_providers WHERE id = provider_services.provider_id AND user_id = auth.uid())
);

-- ============================================
-- 8. FUNCTION TO UPDATE PROVIDER RATING
-- ============================================

CREATE OR REPLACE FUNCTION public.update_provider_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE service_providers
  SET
    rating = (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE provider_id = NEW.provider_id),
    total_reviews = (SELECT COUNT(*) FROM reviews WHERE provider_id = NEW.provider_id)
  WHERE id = NEW.provider_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS update_provider_rating_trigger ON reviews;
CREATE TRIGGER update_provider_rating_trigger
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_provider_rating();

-- ============================================
-- 9. INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_providers_city ON service_providers(city);
CREATE INDEX IF NOT EXISTS idx_providers_available ON service_providers(is_available);
CREATE INDEX IF NOT EXISTS idx_providers_status ON service_providers(status);
CREATE INDEX IF NOT EXISTS idx_providers_category ON service_providers(category_id);
CREATE INDEX IF NOT EXISTS idx_providers_rating ON service_providers(rating DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_provider ON reviews(provider_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_provider ON bookings(provider_id);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_provider_kyc_provider ON provider_kyc(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_hours_provider ON provider_working_hours(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_services_provider ON provider_services(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_services_category ON provider_services(category_id);

-- ============================================
-- 10. SEED CATEGORIES INTO LISTING
-- ============================================

-- Ensure all 25 categories have consistent data
UPDATE service_categories SET
  description = CASE slug
    WHEN 'electrician' THEN 'Wiring, repairs, installations, MCB, inverter'
    WHEN 'plumber' THEN 'Pipes, leaks, bathroom fixes, geyser, water tank'
    WHEN 'home-cook' THEN 'Fresh meals, tiffin, dabbawala, catering for events'
    WHEN 'house-cleaning' THEN 'Deep cleaning, maintenance, bathroom, kitchen scrub'
    WHEN 'caretaker' THEN 'Elderly care, patient care, child care, companionship'
    WHEN 'driver' THEN 'Personal driver, car rental, school drop, airport pick'
    WHEN 'doctor' THEN 'Home visit doctor, nurse, physiotherapy, elderly care'
    WHEN 'tutor' THEN 'Academic tutoring, languages, music, dance, computer skills'
    WHEN 'appliance-repair' THEN 'Washing machine, fridge, AC, laptop, mobile, WiFi'
    WHEN 'carpenter' THEN 'Furniture, repairs, installation, modular kitchen'
    WHEN 'gardening' THEN 'Garden care, pest control, landscaping, plant care'
    WHEN 'beauty' THEN 'Salon at home, bridal makeup, spa, threading, waxing'
    WHEN 'farm-fresh' THEN 'Milk, fruits, vegetables direct from farmers to home'
    WHEN 'delivery' THEN 'Gig delivery, food, courier, parcel, same-day delivery'
    WHEN 'painter' THEN 'Wall painting, waterproofing, texture paint, distemper'
    WHEN 'mason' THEN 'Building work, plaster, brick work, RCC, foundation'
    WHEN 'laundry' THEN 'Wash, dry, iron, steam press, home pickup & delivery'
    WHEN 'security' THEN 'Building security, night guard, apartment security, CCTV'
    WHEN 'maid' THEN 'Daily house help, dish washing, dusting, mopping, kitchen help'
    WHEN 'auto-driver' THEN 'Auto ride, bike taxi, school drop, short distance rides'
    WHEN 'cycle-mechanic' THEN 'Cycle repair, puncture, chain, brake, new cycle delivery'
    WHEN 'mobile-repair' THEN 'Phone repair, screen, charging, battery, accessories'
    WHEN 'water-tanker' THEN 'Drinking water, tanker, RO repair, water purifier'
    WHEN 'cow-dung' THEN 'Gobar gas, organic manure, dung cake, vermicompost'
    WHEN 'tailor' THEN 'Clothing alterations, stitching, saree fall, zip repair'
  END,
  bg_color = CASE slug
    WHEN 'electrician' THEN 'rgba(40,30,8,0.9)'
    WHEN 'plumber' THEN 'rgba(10,20,40,0.9)'
    WHEN 'home-cook' THEN 'rgba(40,8,8,0.9)'
    WHEN 'house-cleaning' THEN 'rgba(8,30,15,0.9)'
    WHEN 'caretaker' THEN 'rgba(35,8,25,0.9)'
    WHEN 'driver' THEN 'rgba(18,22,28,0.9)'
    WHEN 'doctor' THEN 'rgba(6,28,26,0.9)'
    WHEN 'tutor' THEN 'rgba(25,8,40,0.9)'
    WHEN 'appliance-repair' THEN 'rgba(15,15,40,0.9)'
    WHEN 'carpenter' THEN 'rgba(35,28,6,0.9)'
    WHEN 'gardening' THEN 'rgba(18,28,6,0.9)'
    WHEN 'beauty' THEN 'rgba(35,8,15,0.9)'
    WHEN 'farm-fresh' THEN 'rgba(6,28,20,0.9)'
    WHEN 'delivery' THEN 'rgba(38,20,6,0.9)'
    WHEN 'painter' THEN 'rgba(35,28,6,0.9)'
    WHEN 'mason' THEN 'rgba(35,28,6,0.9)'
    WHEN 'laundry' THEN 'rgba(8,30,35,0.9)'
    WHEN 'security' THEN 'rgba(20,20,35,0.9)'
    WHEN 'maid' THEN 'rgba(35,8,20,0.9)'
    WHEN 'auto-driver' THEN 'rgba(35,28,6,0.9)'
    WHEN 'cycle-mechanic' THEN 'rgba(8,30,15,0.9)'
    WHEN 'mobile-repair' THEN 'rgba(15,15,40,0.9)'
    WHEN 'water-tanker' THEN 'rgba(6,20,35,0.9)'
    WHEN 'cow-dung' THEN 'rgba(35,28,6,0.9)'
    WHEN 'tailor' THEN 'rgba(35,8,35,0.9)'
  END;
