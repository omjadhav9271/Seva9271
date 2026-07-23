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
  reputation_score: number; // Step 7: server-computed customer trust score (0–5); 0 = not yet computed
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
  reputation_score: number; // Step 7: server-computed trust score (0–5), separate from the star average
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

export type ReviewDirection = 'customer_to_provider' | 'provider_to_customer';

export type Review = {
  id: string;
  booking_id: string | null;
  customer_id: string;
  provider_id: string;
  reviewer_id: string | null;
  direction: ReviewDirection;
  rating: number;
  comment: string | null;
  // Multi-dimensional axes (§6.1). Customer→provider fills all four; provider→customer fills only
  // communication + punctuality (quality/price-fairness don't apply and stay null).
  rating_quality: number | null;
  rating_punctuality: number | null;
  rating_communication: number | null;
  rating_price_fairness: number | null;
  created_at: string;
  profiles?: Pick<Profile, 'full_name' | 'avatar_url'>;
};

// Step 7: one row per compute_reputation() run — the explainable audit trail behind
// reputation_score. Written only by the server; provider snapshots are publicly readable,
// customer snapshots only by the customer themselves (RLS).
export type ReputationSnapshot = {
  id: string;
  subject_type: 'provider' | 'customer';
  subject_id: string; // service_providers.id (provider) or auth.users.id (customer)
  score: number;
  breakdown: {
    review_score: number;   // Bayesian + time-decay + rater-weighted review component (0–5)
    review_count: number;
    ops_score: number;      // operational component (0–5)
    completion: number;     // completion rate 0–1 (providers; 1 when no data)
    cancellation: number;   // cancellation rate 0–1
    dispute: number;        // dispute rate 0–1
    params: {
      lambda: number;
      prior: number;
      confidence: number;
      w_reviews: number;
      w_ops: number;
    };
  };
  computed_at: string;
};

export type Message = {
  id: string;
  booking_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

export type Notification = {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  is_read: boolean;
  link: string | null;
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
