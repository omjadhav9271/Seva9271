'use client';

/* The signed-in home.
 *
 * `/` is behind AuthGate — only the four /auth routes are public — so everyone who reaches this
 * page is already a member. It used to be a logged-out acquisition page anyway: an "India's #1
 * Service Marketplace" badge, an eight-tile "Why Choose Seva?" explainer, and a closing "Join
 * thousands of satisfied customers" CTA, all aimed at converting people who had already converted.
 * Worse, its two pieces of evidence were invented — three hardcoded "Top Rated Providers" (Amit
 * Sharma 4.9, 156 reviews) and two statistics that were words wearing a number's clothes (`ID`,
 * `Escrow`) — directly beneath a comment insisting every claim here be literally true.
 *
 * So this page now answers the only two questions a member actually arrives with: what do I owe,
 * and what can I get. Everything it prints comes from lib/home.ts, which reads the database and
 * refuses the figures that RLS makes unknowable to a client. Colours, gradients and card styling
 * are unchanged.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { fetchCityAnchors, formatDistance, type CityAnchor } from '@/lib/matching';
import { statusConfig } from '@/lib/bookings';
import {
  fetchPlatformStats, fetchCustomerBand, fetchProviderBand, fetchAdminBand, fetchTopProviders,
  type PlatformStats, type CustomerBand, type ProviderBand, type AdminBand,
  type TopProviders, type HomeBooking,
} from '@/lib/home';
import {
  Search, MapPin, Star, Shield, Users, ArrowRight, Layers, Building2,
  CalendarClock, Wallet, AlertTriangle, FileCheck, Briefcase, ChevronRight,
} from 'lucide-react';

const popularTags = ['Electrician', 'Plumber', 'Cleaning', 'Cook', 'Tutor', 'Farm Fresh'];

const firstName = (full: string | null | undefined): string => {
  const n = (full ?? '').trim().split(/\s+/)[0];
  return n || 'there';
};

const inr = (n: number) => `₹${Number(n).toLocaleString('en-IN')}`;

/** A scheduled slot as a person reads it. Null date is legitimate — not every booking is dated. */
function whenLabel(date: string | null, time: string | null): string {
  if (!date) return 'Not scheduled';
  const d = new Date(date + 'T00:00:00');
  const day = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return time ? `${day}, ${time.slice(0, 5)}` : day;
}

/* ── shared card chrome ─────────────────────────────────────────────────────── */

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">{children}</div>;
}

function PanelHead({ title, count, href, cta }: {
  title: string; count?: number; href: string; cta: string;
}) {
  return (
    <div className="flex items-center justify-between mb-4 gap-3">
      <h2 className="font-semibold text-white flex items-center gap-2">
        {title}
        {typeof count === 'number' && count > 0 && (
          <span className="text-xs font-bold text-[#FF9933] bg-[#FF9933]/10 border border-[#FF9933]/20 rounded-full px-2 py-0.5">
            {count} need{count === 1 ? 's' : ''} you
          </span>
        )}
      </h2>
      <Link href={href} className="text-sm font-medium text-[#FF9933] hover:text-[#e8872e] transition-colors whitespace-nowrap flex items-center gap-1">
        {cta} <ChevronRight className="w-4 h-4" />
      </Link>
    </div>
  );
}

/** One booking row. The action label comes from lib/home, which derives it from actionsFor() —
 *  so this can never advertise a move the transition RPC would reject. */
function BookingRow({ b }: { b: HomeBooking }) {
  const cfg = statusConfig[b.status];
  const Icon = cfg?.icon ?? CalendarClock;
  return (
    <Link
      href={`/bookings/${b.id}`}
      className="flex items-center justify-between gap-3 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3 hover:border-[#FF9933]/40 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: cfg?.bg }}>
          <Icon className="w-4 h-4" style={{ color: cfg?.color }} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white truncate">{b.title}</p>
          <p className="text-xs text-gray-400 truncate">
            {b.category ? `${b.category} · ` : ''}{whenLabel(b.scheduledDate, b.scheduledTime)}
          </p>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        {b.action
          ? <span className="text-xs font-bold text-[#FF9933]">{b.action}</span>
          : <span className="text-xs text-gray-500">{cfg?.label ?? b.status}</span>}
        <p className="text-xs text-gray-500 mt-0.5">{inr(b.amount)}</p>
      </div>
    </Link>
  );
}

export default function Home() {
  const { user, profile } = useAuth();
  const router = useRouter();

  const [searchQuery, setSearchQuery] = useState('');
  const [city, setCity] = useState('');
  const [anchors, setAnchors] = useState<CityAnchor[]>([]);

  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [customer, setCustomer] = useState<CustomerBand | null>(null);
  const [provider, setProvider] = useState<ProviderBand | null>(null);
  const [admin, setAdmin] = useState<AdminBand | null>(null);
  const [top, setTop] = useState<TopProviders | null>(null);

  const isAdmin = profile?.role === 'admin';

  useEffect(() => {
    let on = true;
    fetchCityAnchors().then((l) => { if (on) setAnchors(l); });
    fetchPlatformStats().then((s) => { if (on) setStats(s); });
    return () => { on = false; };
  }, []);

  /* The bands depend on who is asking, so they wait for the session rather than firing on mount.
     Provider and admin reads are additive, not exclusive: `profiles.role` holds one value but a
     provider still books services, and /bookings has carried an "As Provider" tab for that same
     person since Step 5. */
  useEffect(() => {
    if (!user) return;
    let on = true;
    fetchCustomerBand(user.id).then((b) => { if (on) setCustomer(b); });
    fetchProviderBand().then((b) => { if (on) setProvider(b); });
    fetchTopProviders(profile?.city ?? null).then((t) => { if (on) setTop(t); });
    if (isAdmin) fetchAdminBand().then((b) => { if (on) setAdmin(b); });
    return () => { on = false; };
  }, [user, profile?.city, isAdmin]);

  /* Emits ?q= and ?city=, both of which /services honours. It used to emit ?location=, a parameter
     nothing has ever read — the customer's city was silently discarded on the front door of a
     location-matching product. */
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (searchQuery) params.set('q', searchQuery);
    if (city) params.set('city', city);
    router.push(`/providers?${params.toString()}`);
  };

  const statTiles = [
    { icon: Users, value: stats ? stats.providers.toLocaleString('en-IN') : '—', label: 'Verified providers', color: '#FF9933', bg: 'rgba(255,153,51,0.25)' },
    { icon: Layers, value: stats ? String(stats.categories) : '—', label: 'Service categories', color: '#FF9933', bg: 'rgba(255,153,51,0.25)' },
    { icon: Building2, value: stats ? String(stats.cities) : '—', label: 'Cities covered', color: '#138808', bg: 'rgba(19,136,8,0.3)' },
    { icon: MapPin, value: 'Bengaluru', label: 'Live now', color: '#138808', bg: 'rgba(19,136,8,0.3)' },
  ];

  return (
    <div className="min-h-screen bg-[#0d0d0d]">
      {/* Greeting + search. pt-24 because the navbar is transparent at scroll-top and sits over this. */}
      <section className="relative pt-24 pb-10 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-0 left-0 w-[600px] h-[600px] bg-[#FF9933]/8 rounded-full blur-[120px]" />
          <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-[#138808]/8 rounded-full blur-[120px]" />
          <div className="absolute inset-0" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.03) 1px, transparent 0)', backgroundSize: '40px 40px' }} />
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">🙏</span>
            <h1 className="text-3xl sm:text-4xl font-black text-white">
              Welcome back, <span className="text-[#138808]">{firstName(profile?.full_name)}</span>
            </h1>
          </div>
          <p className="text-gray-400 mb-8">What do you need done today?</p>

          <form onSubmit={handleSearch} className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-2xl p-2 mb-5 max-w-3xl hover:border-[#FF9933]/30 transition-colors">
            {/* min-w-0 on every flex-1 child: flex items default to min-width:auto, so without it
                these refuse to shrink and push the submit button out of its column. */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-2">
                <Search className="w-5 h-5 text-gray-500 flex-shrink-0" />
                <input
                  type="text"
                  placeholder="What service do you need?"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
                />
              </div>
              <div className="hidden sm:block w-px bg-[#2a2a2a] self-stretch" />
              <div className="flex items-center gap-3 flex-1 min-w-0 px-4 py-2">
                <MapPin className="w-5 h-5 text-gray-500 flex-shrink-0" />
                <select
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  aria-label="City to search from"
                  className="flex-1 min-w-0 bg-transparent text-white text-sm focus:outline-none [&>option]:bg-[#1a1a1a] [&>option]:text-white"
                >
                  {/* Empty is a real choice, not a placeholder: /providers then shows everything and
                      still offers "Use my location" once they arrive. */}
                  <option value="">Anywhere in India</option>
                  {anchors.map((a) => (
                    <option key={a.city} value={a.city}>{a.city} ({a.provider_count})</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="saffron-btn rounded-xl px-6 py-3 text-sm font-semibold whitespace-nowrap">
                Find providers
              </button>
            </div>
          </form>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-500">Popular:</span>
            {popularTags.map((tag) => (
              <Link
                key={tag}
                href={`/providers?q=${tag.toLowerCase()}`}
                className="text-sm px-3 py-1.5 border border-[#2a2a2a] rounded-lg text-gray-300 hover:border-[#FF9933]/50 hover:text-[#FF9933] transition-all duration-200"
              >
                {tag}
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Role bands — additive, in order of how much they demand of this person right now. */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-5">
        {isAdmin && admin && (
          <Panel>
            <PanelHead title="Moderation queue" href="/admin" cta="Open console" />
            <div className="grid sm:grid-cols-2 gap-4">
              <Link href="/admin/providers" className="flex items-center justify-between rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3 hover:border-[#FF9933]/40 transition-colors">
                <span className="flex items-center gap-3 text-sm text-gray-300">
                  <FileCheck className="w-4 h-4 text-[#FF9933]" /> Applications pending review
                </span>
                <span className="text-lg font-black text-white">{admin.pendingApplications}</span>
              </Link>
              <Link href="/admin/disputes" className="flex items-center justify-between rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3 hover:border-[#FF9933]/40 transition-colors">
                <span className="flex items-center gap-3 text-sm text-gray-300">
                  <AlertTriangle className="w-4 h-4 text-[#ef4444]" /> Open disputes
                </span>
                <span className="text-lg font-black text-white">{admin.openDisputes}</span>
              </Link>
            </div>
          </Panel>
        )}

        {provider && (
          <Panel>
            <PanelHead title="Your provider profile" count={provider.needsYou} href="/bookings" cta="All jobs" />
            <div className="grid sm:grid-cols-3 gap-3 mb-4">
              <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3">
                <p className="text-xs text-gray-500 mb-1">Reputation</p>
                <p className="text-lg font-black text-white">
                  {provider.reputationScore ? provider.reputationScore.toFixed(2) : '—'}
                  <span className="text-xs font-normal text-gray-500"> / 5</span>
                </p>
              </div>
              <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3">
                <p className="text-xs text-gray-500 mb-1">Reviews</p>
                <p className="text-lg font-black text-white">
                  {provider.totalReviews > 0
                    ? <>{provider.rating.toFixed(1)}<span className="text-xs font-normal text-gray-500"> ({provider.totalReviews})</span></>
                    : <span className="text-sm font-semibold text-[#3b82f6]">New on Seva</span>}
                </p>
              </div>
              <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-3">
                <p className="text-xs text-gray-500 mb-1">Status</p>
                <p className="text-sm font-bold capitalize" style={{ color: provider.status === 'approved' ? '#22c55e' : '#f59e0b' }}>
                  {provider.status}
                  {provider.status === 'approved' && (
                    <span className="text-xs font-normal text-gray-500">
                      {' · '}{provider.isAvailable ? 'available' : 'unavailable'}
                    </span>
                  )}
                </p>
              </div>
            </div>
            {provider.status !== 'approved' ? (
              <Link href="/become-provider" className="flex items-center justify-between rounded-xl border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-4 py-3 text-sm text-[#f59e0b] hover:border-[#f59e0b]/60 transition-colors">
                Your application is {provider.status}. See what happens next.
                <ArrowRight className="w-4 h-4" />
              </Link>
            ) : provider.incoming.length ? (
              <div className="space-y-2">
                {provider.incoming.map((b) => <BookingRow key={b.id} b={b} />)}
              </div>
            ) : (
              <p className="text-sm text-gray-500 px-1">No jobs in flight. New requests will land here.</p>
            )}
          </Panel>
        )}

        {!isAdmin && customer && (
          <Panel>
            <PanelHead title="Your bookings" count={customer.needsYou} href="/bookings" cta="All bookings" />
            {customer.open.length ? (
              <div className="space-y-2">
                {customer.open.map((b) => <BookingRow key={b.id} b={b} />)}
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] px-4 py-4">
                <p className="text-sm text-gray-400">Nothing booked right now.</p>
                <Link href="/services" className="saffron-btn rounded-xl px-5 py-2.5 text-sm font-semibold whitespace-nowrap self-start sm:self-auto">
                  Browse services
                </Link>
              </div>
            )}
          </Panel>
        )}
      </section>

      {/* Platform figures + genuinely top-rated people */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid lg:grid-cols-2 gap-5">
          <div className="grid grid-cols-2 gap-4">
            {statTiles.map((s) => (
              <div key={s.label} className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover">
                <div className="w-12 h-12 rounded-full flex items-center justify-center mb-3" style={{ background: s.bg }}>
                  <s.icon className="w-6 h-6" style={{ color: s.color }} />
                </div>
                <p className="text-2xl font-black text-white">{s.value}</p>
                <p className="text-sm text-gray-400 mt-0.5">{s.label}</p>
              </div>
            ))}
          </div>

          <Panel>
            {/* The heading says "near <city>" only when the query actually ranked from that city's
                anchor — see fetchTopProviders. The card this replaced said "Available Now" over
                three people who did not exist. */}
            <PanelHead
              title={top?.near ? `Top rated near ${top.near}` : 'Top rated on Seva'}
              href="/providers"
              cta="View all"
            />
            {top?.rows.length ? (
              <div className="space-y-4">
                {top.rows.map((p) => (
                  <Link key={p.id} href={`/providers/${p.id}`} className="flex items-center justify-between gap-3 group">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="relative flex-shrink-0">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-sm font-bold text-white">
                          {(p.businessName ?? '?').split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                        </div>
                        {p.isAvailable && (
                          <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white truncate group-hover:text-[#FF9933] transition-colors">{p.businessName}</p>
                        <p className="text-xs text-gray-400 truncate">
                          {p.category}
                          {p.distanceKm !== null && <> · {formatDistance(p.distanceKm)}</>}
                        </p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      {p.totalReviews > 0 ? (
                        <>
                          <div className="flex items-center gap-1 justify-end">
                            <Star className="w-3.5 h-3.5 fill-[#FF9933] text-[#FF9933]" />
                            <span className="text-sm font-semibold text-white">{p.rating.toFixed(1)}</span>
                          </div>
                          <p className="text-xs text-gray-500">{p.totalReviews} reviews</p>
                        </>
                      ) : (
                        <span className="text-xs font-medium text-[#3b82f6]">New on Seva</span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No providers to show yet.</p>
            )}
          </Panel>
        </div>
      </section>

      {/* One line to the directory — the full category grid lives on /services, not duplicated here. */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-20">
        <Link
          href="/services"
          className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border border-[#2a2a2a] bg-[#161616] p-6 seva-card-hover"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-[#FF9933]/20 flex items-center justify-center flex-shrink-0">
              <Briefcase className="w-6 h-6 text-[#FF9933]" />
            </div>
            <div>
              <p className="font-semibold text-white">Browse all {stats ? stats.categories : 25} categories</p>
              <p className="text-sm text-gray-400">From electricians and masons to tiffin cooks, tailors and water tankers.</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 saffron-btn rounded-xl px-6 py-3 text-sm font-semibold self-start sm:self-auto whitespace-nowrap">
            See services <ArrowRight className="w-4 h-4" />
          </span>
        </Link>
      </section>
    </div>
  );
}
