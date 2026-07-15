import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type Profile = {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
  role: 'customer' | 'provider' | 'admin';
  wallet_balance: number;
  wallet_tier: 'silver' | 'gold' | 'platinum';
  created_at: string;
  updated_at: string;
};

export type ServiceCategory = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  bg_color: string | null;
  created_at: string;
};

export type ServiceProvider = {
  id: string;
  user_id: string;
  category_id: string | null;
  business_name: string | null;
  bio: string | null;
  experience_years: number;
  hourly_rate: number;
  rating: number;
  total_reviews: number;
  total_bookings: number;
  is_verified: boolean;
  is_available: boolean;
  city: string | null;
  state: string | null;
  address: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  created_at: string;
  updated_at: string;
  // Joined fields
  profiles?: Profile;
  service_categories?: ServiceCategory;
};

export type Booking = {
  id: string;
  customer_id: string;
  provider_id: string;
  category_id: string | null;
  service_type: 'one-time' | 'weekly' | 'monthly' | 'yearly' | 'renewable';
  scheduled_date: string | null;
  scheduled_time: string | null;
  duration_hours: number;
  hourly_rate: number;
  total_amount: number;
  price_agreed: number | null;
  price_charged: number | null;
  status:
    | 'requested'
    | 'accepted'
    | 'en_route'
    | 'arrived'
    | 'in_progress'
    | 'completed'
    | 'confirmed'
    | 'paid'
    | 'reviewed'
    | 'cancelled'
    | 'disputed'
    | 'expired';
  payment_method: 'wallet' | 'upi' | 'cod';
  payment_status: 'pending' | 'paid' | 'refunded';
  notes: string | null;
  address: string | null;
  created_at: string;
  updated_at: string;
};

export type Review = {
  id: string;
  booking_id: string | null;
  customer_id: string;
  provider_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
  profiles?: Pick<Profile, 'full_name' | 'avatar_url'>;
};

export type Message = {
  id: string;
  booking_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

export type WalletTransaction = {
  id: string;
  user_id: string;
  type: 'credit' | 'debit' | 'reward';
  amount: number;
  description: string | null;
  reference_id: string | null;
  created_at: string;
};
