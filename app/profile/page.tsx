'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { User, Phone, MapPin, Mail, Edit2, Save, X, Camera, Shield, Award, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';
import { toast } from 'sonner';
import Link from 'next/link';

export default function ProfilePage() {
  const { user, profile, refreshProfile } = useAuth();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    full_name: '',
    phone: '',
    city: '',
    state: '',
    address: '',
  });

  useEffect(() => {
    if (!user) {
      router.push('/auth/signin');
      return;
    }
    if (profile) {
      setForm({
        full_name: profile.full_name ?? '',
        phone: profile.phone ?? '',
        city: profile.city ?? '',
        state: profile.state ?? '',
        address: profile.address ?? '',
      });
    }
  }, [user, profile, router]);

  if (!user) return null;

  const handleSave = async () => {
    setSaving(true);
    // NOTE: after the security-hardening migration, authenticated users may UPDATE only
    // (full_name, phone, avatar_url, city, state, address) on profiles. Do NOT include
    // updated_at or protected columns here or the column-level grant will reject the write.
    const { error } = await supabase
      .from('profiles')
      .update(form)
      .eq('id', user.id);
    setSaving(false);

    if (error) {
      toast.error('Failed to save profile');
    } else {
      await refreshProfile();
      setEditing(false);
      toast.success('Profile updated!');
    }
  };

  const initials = (profile?.full_name ?? user.email ?? 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  const tierColors: Record<string, string> = {
    silver: 'from-slate-400 to-slate-600',
    gold: 'from-amber-400 to-amber-600',
    platinum: 'from-slate-300 to-slate-500',
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-3xl font-black text-white mb-8">My Profile</h1>

        {/* Profile Card */}
        <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl overflow-hidden mb-6">
          {/* Header Banner */}
          <div className="h-24 bg-gradient-to-r from-[#1a0f00] via-[#1a1200] to-[#001a0d]" />

          <div className="px-6 pb-6">
            {/* Avatar */}
            <div className="flex items-end justify-between -mt-12 mb-4">
              <div className="relative">
                <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-[#FF9933] to-[#138808] flex items-center justify-center text-3xl font-black text-white border-4 border-[#161616]">
                  {initials}
                </div>
                <button className="absolute -bottom-1 -right-1 w-7 h-7 bg-[#FF9933] rounded-lg flex items-center justify-center">
                  <Camera className="w-3.5 h-3.5 text-white" />
                </button>
              </div>

              {!editing ? (
                <button
                  onClick={() => setEditing(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:border-[#FF9933]/50 hover:text-white transition-all"
                >
                  <Edit2 className="w-4 h-4" /> Edit Profile
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => setEditing(false)} className="flex items-center gap-2 px-4 py-2 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl text-sm text-gray-300 hover:border-red-500/50">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-[#FF9933] rounded-xl text-sm text-white font-semibold hover:bg-[#e8872e] disabled:opacity-60">
                    <Save className="w-4 h-4" /> {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>

            {/* Name + Role */}
            <div className="mb-5">
              <h2 className="text-2xl font-black text-white">{profile?.full_name ?? 'User'}</h2>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-sm text-gray-400">{user.email}</span>
                <span className={`text-xs px-2.5 py-1 rounded-full font-semibold bg-gradient-to-r ${tierColors[profile?.wallet_tier ?? 'silver']} text-white capitalize`}>
                  {profile?.wallet_tier ?? 'Silver'} Member
                </span>
                <span className="text-xs px-2.5 py-1 rounded-full bg-[#138808]/10 border border-[#138808]/20 text-[#138808] capitalize">
                  {profile?.role ?? 'Customer'}
                </span>
              </div>
            </div>

            {/* Form Fields */}
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Full Name</label>
                {editing ? (
                  <input
                    value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                  />
                ) : (
                  <div className="flex items-center gap-2.5 text-sm text-gray-300">
                    <User className="w-4 h-4 text-[#FF9933]" />
                    {profile?.full_name ?? 'Not set'}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Phone</label>
                {editing ? (
                  <input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                    placeholder="+91 98765 43210"
                  />
                ) : (
                  <div className="flex items-center gap-2.5 text-sm text-gray-300">
                    <Phone className="w-4 h-4 text-[#FF9933]" />
                    {profile?.phone ?? 'Not set'}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">City</label>
                {editing ? (
                  <input
                    value={form.city}
                    onChange={(e) => setForm({ ...form, city: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                    placeholder="Mumbai"
                  />
                ) : (
                  <div className="flex items-center gap-2.5 text-sm text-gray-300">
                    <MapPin className="w-4 h-4 text-[#FF9933]" />
                    {profile?.city ?? 'Not set'}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">State</label>
                {editing ? (
                  <input
                    value={form.state}
                    onChange={(e) => setForm({ ...form, state: e.target.value })}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#FF9933]"
                    placeholder="Maharashtra"
                  />
                ) : (
                  <div className="flex items-center gap-2.5 text-sm text-gray-300">
                    <MapPin className="w-4 h-4 text-gray-500" />
                    {profile?.state ?? 'Not set'}
                  </div>
                )}
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Address</label>
                {editing ? (
                  <textarea
                    value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    rows={2}
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-[#FF9933] resize-none"
                    placeholder="Your full address"
                  />
                ) : (
                  <div className="flex items-start gap-2.5 text-sm text-gray-300">
                    <MapPin className="w-4 h-4 text-gray-500 mt-0.5 flex-shrink-0" />
                    {profile?.address ?? 'Not set'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Quick Links */}
        <div className="grid sm:grid-cols-3 gap-4">
          {[
            { href: '/bookings', icon: Award, label: 'My Bookings', desc: 'View all your bookings', color: '#FF9933' },
            { href: '/wallet', icon: Wallet, label: 'Seva Wallet', desc: `₹${(profile?.wallet_balance ?? 0).toLocaleString('en-IN')} balance`, color: '#138808' },
            { href: '/become-provider', icon: Shield, label: 'Become Provider', desc: 'Earn by providing services', color: '#054187' },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover group"
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 transition-colors" style={{ background: `${item.color}15` }}>
                <item.icon className="w-5 h-5" style={{ color: item.color }} />
              </div>
              <h3 className="font-bold text-white text-sm mb-1 group-hover:text-[#FF9933] transition-colors">{item.label}</h3>
              <p className="text-xs text-gray-500">{item.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
