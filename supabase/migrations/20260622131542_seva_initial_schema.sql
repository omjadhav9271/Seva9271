
-- Profiles table extending auth.users
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  full_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  city TEXT,
  state TEXT,
  address TEXT,
  role TEXT DEFAULT 'customer' CHECK (role IN ('customer', 'provider', 'admin')),
  wallet_balance NUMERIC DEFAULT 0,
  wallet_tier TEXT DEFAULT 'silver' CHECK (wallet_tier IN ('silver', 'gold', 'platinum')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_own_profile" ON profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "insert_own_profile" ON profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "update_own_profile" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "delete_own_profile" ON profiles FOR DELETE TO authenticated USING (auth.uid() = id);

-- Allow public to view provider profiles
CREATE POLICY "public_select_profiles" ON profiles FOR SELECT TO anon USING (true);

-- Service categories
CREATE TABLE IF NOT EXISTS service_categories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  color TEXT,
  bg_color TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone_can_read_categories" ON service_categories FOR SELECT USING (true);

-- Insert service categories
INSERT INTO service_categories (name, slug, description, icon, color, bg_color) VALUES
  ('Electrician', 'electrician', 'Wiring, repairs, installations', 'Zap', '#FF9933', '#3d2800'),
  ('Plumber', 'plumber', 'Pipes, leaks, bathroom fixes', 'Wrench', '#3b82f6', '#1e293b'),
  ('Home Cook / Tiffin', 'home-cook', 'Fresh meals, tiffin service', '#ef4444', '#2d1515', 'ChefHat'),
  ('House Cleaning', 'house-cleaning', 'Deep cleaning, maintenance', '#22c55e', '#0f2d0f', 'Sparkles'),
  ('Caretaker / Elderly Care', 'caretaker', 'Elderly care, companionship', '#ec4899', '#2d0f1f', 'Heart'),
  ('Driver / Car Rental', 'driver', 'Personal driver, car rental', '#94a3b8', '#1e293b', 'Car'),
  ('Home-Visit Doctor', 'doctor', 'Medical consultation at home', '#14b8a6', '#0d2626', 'Stethoscope'),
  ('Tutor / Coaching', 'tutor', 'Academic tutoring, skills', '#a855f7', '#1f0d2d', 'GraduationCap'),
  ('Appliance Repair', 'appliance-repair', 'Washing machine, laptop, WiFi', '#6366f1', '#1a1a3e', 'Settings'),
  ('Carpenter & Handyman', 'carpenter', 'Furniture, repairs, installation', '#f59e0b', '#2d1f00', 'Hammer'),
  ('Gardening & Pest Control', 'gardening', 'Garden care, pest solutions', '#84cc16', '#1a2d00', 'Leaf'),
  ('Beauty & Wellness', 'beauty', 'Salon at home, spa services', '#f43f5e', '#2d0f15', 'Scissors'),
  ('Farm Fresh Delivery', 'farm-fresh', 'Milk, fruits, vegetables from farmers', '#10b981', '#0a2d1a', 'ShoppingBasket'),
  ('Delivery Service', 'delivery', 'Gig delivery, earn by delivering', '#f97316', '#2d1500', 'Truck')
ON CONFLICT (slug) DO NOTHING;

-- Service providers
CREATE TABLE IF NOT EXISTS service_providers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  category_id UUID REFERENCES service_categories(id),
  business_name TEXT,
  bio TEXT,
  experience_years INT DEFAULT 0,
  hourly_rate NUMERIC DEFAULT 0,
  rating NUMERIC DEFAULT 0,
  total_reviews INT DEFAULT 0,
  total_bookings INT DEFAULT 0,
  is_verified BOOLEAN DEFAULT false,
  is_available BOOLEAN DEFAULT true,
  city TEXT,
  state TEXT,
  address TEXT,
  latitude NUMERIC,
  longitude NUMERIC,
  documents JSONB DEFAULT '[]',
  gallery JSONB DEFAULT '[]',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE service_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone_can_read_providers" ON service_providers FOR SELECT USING (true);
CREATE POLICY "insert_own_provider" ON service_providers FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_provider" ON service_providers FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_provider" ON service_providers FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Bookings
CREATE TABLE IF NOT EXISTS bookings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE NOT NULL,
  category_id UUID REFERENCES service_categories(id),
  service_type TEXT DEFAULT 'one-time' CHECK (service_type IN ('one-time', 'weekly', 'monthly', 'yearly', 'renewable')),
  scheduled_date DATE,
  scheduled_time TIME,
  duration_hours NUMERIC DEFAULT 1,
  hourly_rate NUMERIC DEFAULT 0,
  total_amount NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  payment_method TEXT DEFAULT 'wallet' CHECK (payment_method IN ('wallet', 'upi', 'cod')),
  payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'refunded')),
  notes TEXT,
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_bookings" ON bookings FOR SELECT TO authenticated USING (auth.uid() = customer_id OR auth.uid() IN (SELECT user_id FROM service_providers WHERE id = bookings.provider_id));
CREATE POLICY "insert_own_booking" ON bookings FOR INSERT TO authenticated WITH CHECK (auth.uid() = customer_id);
CREATE POLICY "update_own_booking" ON bookings FOR UPDATE TO authenticated USING (auth.uid() = customer_id OR auth.uid() IN (SELECT user_id FROM service_providers WHERE id = bookings.provider_id));
CREATE POLICY "delete_own_booking" ON bookings FOR DELETE TO authenticated USING (auth.uid() = customer_id);

-- Wallet transactions
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'reward')),
  amount NUMERIC NOT NULL,
  description TEXT,
  reference_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_transactions" ON wallet_transactions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_transaction" ON wallet_transactions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_transaction" ON wallet_transactions FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_transaction" ON wallet_transactions FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE NOT NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone_can_read_reviews" ON reviews FOR SELECT USING (true);
CREATE POLICY "insert_own_review" ON reviews FOR INSERT TO authenticated WITH CHECK (auth.uid() = customer_id);
CREATE POLICY "update_own_review" ON reviews FOR UPDATE TO authenticated USING (auth.uid() = customer_id) WITH CHECK (auth.uid() = customer_id);
CREATE POLICY "delete_own_review" ON reviews FOR DELETE TO authenticated USING (auth.uid() = customer_id);

-- Favorites
CREATE TABLE IF NOT EXISTS favorites (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  provider_id UUID REFERENCES service_providers(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider_id)
);

ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_favorites" ON favorites FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_favorite" ON favorites FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_favorite" ON favorites FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_favorite" ON favorites FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info' CHECK (type IN ('info', 'success', 'warning', 'error')),
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_own_notifications" ON notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "insert_own_notification" ON notifications FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "update_own_notification" ON notifications FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "delete_own_notification" ON notifications FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Function to handle new user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Insert sample providers for demo
INSERT INTO service_providers (user_id, category_id, business_name, bio, experience_years, hourly_rate, rating, total_reviews, total_bookings, is_verified, is_available, city, state, status)
SELECT 
  (SELECT id FROM auth.users LIMIT 1),
  sc.id,
  CASE sc.slug
    WHEN 'electrician' THEN 'Amit Sharma'
    WHEN 'house-cleaning' THEN 'Priya Patel'
    WHEN 'plumber' THEN 'Ravi Kumar'
    ELSE 'Demo Provider'
  END,
  'Experienced professional with excellent track record',
  FLOOR(RANDOM() * 10 + 2)::INT,
  FLOOR(RANDOM() * 500 + 200)::NUMERIC,
  4.8 + RANDOM() * 0.2,
  FLOOR(RANDOM() * 200 + 50)::INT,
  FLOOR(RANDOM() * 500 + 100)::INT,
  true,
  true,
  'Mumbai',
  'MH',
  'approved'
FROM service_categories sc
WHERE EXISTS (SELECT 1 FROM auth.users LIMIT 1)
AND sc.slug IN ('electrician', 'house-cleaning', 'plumber')
ON CONFLICT DO NOTHING;
