/* Seva — security hardening + fixes. Run AFTER the two existing migrations. */

-- 1) BUG: category seed had icon/color columns swapped from the 3rd row on.
UPDATE service_categories SET icon='ChefHat',        color='#ef4444', bg_color='#2d1515' WHERE slug='home-cook';
UPDATE service_categories SET icon='Sparkles',       color='#22c55e', bg_color='#0f2d0f' WHERE slug='house-cleaning';
UPDATE service_categories SET icon='Heart',          color='#ec4899', bg_color='#2d0f1f' WHERE slug='caretaker';
UPDATE service_categories SET icon='Car',            color='#94a3b8', bg_color='#1e293b' WHERE slug='driver';
UPDATE service_categories SET icon='Stethoscope',    color='#14b8a6', bg_color='#0d2626' WHERE slug='doctor';
UPDATE service_categories SET icon='GraduationCap',  color='#a855f7', bg_color='#1f0d2d' WHERE slug='tutor';
UPDATE service_categories SET icon='Settings',       color='#6366f1', bg_color='#1a1a3e' WHERE slug='appliance-repair';
UPDATE service_categories SET icon='Hammer',         color='#f59e0b', bg_color='#2d1f00' WHERE slug='carpenter';
UPDATE service_categories SET icon='Leaf',           color='#84cc16', bg_color='#1a2d00' WHERE slug='gardening';
UPDATE service_categories SET icon='Scissors',       color='#f43f5e', bg_color='#2d0f15' WHERE slug='beauty';
UPDATE service_categories SET icon='ShoppingBasket', color='#10b981', bg_color='#0a2d1a' WHERE slug='farm-fresh';
UPDATE service_categories SET icon='Truck',          color='#f97316', bg_color='#2d1500' WHERE slug='delivery';

-- 2) MONEY: users must NOT write their own wallet ledger.
--    Ledger is append-only, server-side only (service role / SECURITY DEFINER RPC).
DROP POLICY IF EXISTS "insert_own_transaction" ON wallet_transactions;
DROP POLICY IF EXISTS "update_own_transaction" ON wallet_transactions;
DROP POLICY IF EXISTS "delete_own_transaction" ON wallet_transactions;
-- keep "select_own_transactions" so users can view their history.

-- 3) PROFILE: block editing protected columns (wallet_balance, role, wallet_tier).
REVOKE UPDATE ON profiles FROM authenticated;
GRANT  UPDATE (full_name, phone, avatar_url, city, state, address) ON profiles TO authenticated;

-- 4) PROVIDER: block self-setting rating / verification / status / bookings counts.
REVOKE UPDATE ON service_providers FROM authenticated;
GRANT  UPDATE (business_name, bio, experience_years, hourly_rate, is_available,
               city, state, address, latitude, longitude, documents, gallery)
       ON service_providers TO authenticated;

-- 5) REVIEWS: only for a COMPLETED booking between the two parties; one per booking.
--    NOTE: if existing reviews have NULL booking_id, clear/fix them before SET NOT NULL.
ALTER TABLE reviews ALTER COLUMN booking_id SET NOT NULL;
ALTER TABLE reviews ADD CONSTRAINT uniq_review_per_booking UNIQUE (booking_id);
DROP POLICY IF EXISTS "insert_own_review" ON reviews;
CREATE POLICY "insert_review_for_completed_booking" ON reviews
FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = customer_id
  AND EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.id = reviews.booking_id
      AND b.customer_id = auth.uid()
      AND b.provider_id = reviews.provider_id
      AND b.status = 'completed'
  )
);

-- 6) PRIVACY: stop exposing everyone's phone to anonymous visitors.
--    Expose only safe columns via a view; provider names come from service_providers.business_name.
DROP POLICY IF EXISTS "public_select_profiles" ON profiles;
CREATE OR REPLACE VIEW public_profiles AS
  SELECT id, full_name, avatar_url, city, state FROM profiles;
GRANT SELECT ON public_profiles TO anon, authenticated;
-- NOTE: if any anon page reads full profile rows, point it at public_profiles or business_name.
