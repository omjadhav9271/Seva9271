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

// Step 9: one uploaded ID document. The file itself lives in the PRIVATE 'kyc-docs' Storage
// bucket at <user_id>/<uuid>.<ext>; this is the metadata stored in kyc_documents. Never public —
// the owner and admins reach it through short-lived signed URLs.
export type KycDocument = {
  path: string;            // storage object key within the 'kyc-docs' bucket
  label: string;           // which slot it fills, e.g. 'Photo ID'
  name: string | null;     // original filename, for the admin's reference
  mime: string | null;
  uploaded_at: string;
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
  // Step 9 — onboarding / verification. All server-written: kyc_status and status are set by
  // submit_provider_application (→ 'submitted'/pending) and review_provider_application
  // (→ 'verified'/approved or 'rejected'). None of these carry a SELECT grant to `authenticated`:
  // a provider reads their own via the my_provider_profile view, admins via the service-role
  // route /api/admin/provider-applications.
  kyc_status: KycStatus;
  kyc_documents: KycDocument[];   // Step 9 legacy; superseded by the provider_documents table
  rejection_reason: string | null;
  applied_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  // Step 9.5: 1 identity-verified · 2 credential/experience-verified · 3 background-verified.
  // Server-computed from verified documents — never client-writable.
  trust_tier: number;
  // Step 10: public pricing. NOTE floor_price is deliberately NOT here — it has no select grant
  // and must never reach a client. The owner reads it via ProviderPricing / my_provider_profile.
  pricing_mode: PricingMode;
  list_price: number | null;
  auto_accept_threshold: number | null;
  max_counter_rounds: number;
  // Joined fields
  profiles?: Profile;
  service_categories?: ServiceCategory;
};

export type KycStatus = 'unsubmitted' | 'submitted' | 'verified' | 'rejected';

/* ── Step 9.5: category-aware KYC ─────────────────────────────────────────────
   Requirements live in data (category_kyc_requirements), so adding a category or a document
   type is an insert, not a deploy. Documents are RPC-written and server-verified. */

// Bucket C (14): 'live_capture' means the form must open the camera — an uploaded file is not
// accepted for this slot. The form keys on this, not on a hardcoded doc_code.
export type CaptureMethod = 'digilocker' | 'api_number' | 'upload' | 'vendor' | 'live_capture';

// 'required' blocks approval · 'badge' never blocks, it unlocks a trust tier ·
// 'payout' is required before the first payout, not before going live.
export type RequirementKind = 'required' | 'badge' | 'payout' | 'optional';

export type DocumentStatus = 'pending' | 'verified' | 'rejected' | 'expired';

export type KycDocumentType = {
  code: string;
  label: string;
  description: string | null;
  capture_method: CaptureMethod;
  carries_expiry: boolean;
  is_sensitive: boolean;
  retention_days: number | null;
};

export type CategoryKycRequirement = {
  id: string;
  category_id: string;
  doc_code: string;
  requirement: RequirementKind;
  unlocks_tier: number | null;
  note: string | null;
  kyc_document_types?: KycDocumentType;
};

export type ProviderDocument = {
  id: string;
  provider_id: string;
  doc_code: string;
  file_path: string | null;
  reference_number: string | null;   // masked — last 4 only
  verification_status: DocumentStatus;
  verified_source: 'digilocker' | 'api' | 'admin' | 'vendor' | null;
  issued_at: string | null;
  expires_at: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  verified_at: string | null;
  verified_by: string | null;
};

// One row of provider_document_checklist(): what this category asks for, plus what's supplied.
export type DocumentChecklistItem = {
  doc_code: string;
  label: string;
  description: string | null;
  requirement: RequirementKind;
  capture_method: CaptureMethod;
  carries_expiry: boolean;
  unlocks_tier: number | null;
  note: string | null;
  document_id: string | null;
  verification_status: DocumentStatus | null;
  expires_at: string | null;
  file_path: string | null;
};

// CAPABILITY, never reputation. compute_reputation must not read this (§7.3 — the moat).
export type ProviderExperience = {
  id: string;
  provider_id: string;
  employer_name: string;
  role: string | null;
  from_date: string | null;
  to_date: string | null;
  source: 'epfo' | 'employer_ref' | 'rpl' | 'self_declared';
  verified: boolean;
  verified_at: string | null;
  created_at: string;
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
  // 'upi' is the only method offered to customers (Bucket C item 18). 'cod' has been blocked for
  // new bookings since Step 5.5 and 'wallet' since Bucket C — both remain in the type because
  // legacy rows still carry them. The wallet itself is alive and well: it is the PROVIDER payout
  // ledger (escrow releases into it, disputes claw back from it), never a way to pay for a job.
  payment_method: 'wallet' | 'upi' | 'cod';
  payment_status: 'pending' | 'paid' | 'refunded';
  notes: string | null;
  address: string | null;
  created_at: string;
  updated_at: string;
};

/* ── Step 10: structured bargaining ───────────────────────────────────────────
   Pricing lives on the provider (a provider today IS one listing). `floor_price` is the
   provider's reservation price: it carries NO select grant, is never returned by an RPC, and is
   readable only by its owner through the my_provider_profile view. It is deliberately absent
   from the public ServiceProvider shape below. */

export type PricingMode = 'fixed' | 'negotiable';

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'countered' | 'expired';

export type Offer = {
  id: string;
  booking_id: string;
  round: number;
  made_by: string;
  actor_role: 'customer' | 'provider';
  amount: number;
  status: OfferStatus;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
};

// What a provider sets on themselves. Read via my_provider_profile — floor_price included,
// because that view is filtered to auth.uid().
export type ProviderPricing = {
  pricing_mode: PricingMode;
  list_price: number | null;
  floor_price: number | null;
  auto_accept_threshold: number | null;
  max_counter_rounds: number;
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
    // Step 8: rate of disputes RESOLVED AGAINST the subject (fault-based). Snapshots computed
    // before Step 8 carry the old `dispute` key (raw disputed-rate) instead — read with fallback.
    dispute_fault_rate?: number;
    dispute?: number;       // legacy pre-Step-8 key
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

// Step 8: one dispute per problem, one OPEN dispute per booking (partial unique index).
// Written only by raise_dispute / resolve_dispute; readable by the booking parties + admins.
export type DisputeReason =
  | 'work_not_done' | 'poor_quality' | 'overcharged' | 'no_show' | 'damage'
  | 'payment_not_received' | 'customer_behaviour' | 'other';

export type DisputeOutcome = 'favor_customer' | 'favor_provider' | 'partial' | 'no_fault';

export type Dispute = {
  id: string;
  booking_id: string;
  raised_by: string;
  raiser_role: 'customer' | 'provider';
  reason: DisputeReason;
  description: string | null;
  status: 'open' | 'under_review' | 'resolved';
  outcome: DisputeOutcome | null;
  fault_party: 'customer' | 'provider' | 'none' | null;
  refund_amount: number | null;
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

// Step 8.5: evidence a party attaches to an OPEN dispute (images/video/audio/pdf). The file lives
// in the private 'dispute-evidence' Storage bucket at <dispute_id>/<uuid>.<ext>; this row is its
// metadata. RLS: a party reads only their OWN rows, the admin reads all; insert only by a party
// while the dispute is unresolved; append-only (no updates).
export type EvidenceKind = 'image' | 'video' | 'audio' | 'file';

export type DisputeEvidence = {
  id: string;
  dispute_id: string;
  booking_id: string;
  uploaded_by: string;
  uploader_role: 'customer' | 'provider';
  file_path: string;
  mime_type: string | null;
  kind: EvidenceKind;
  caption: string | null;
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
