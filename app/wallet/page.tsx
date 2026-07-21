'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Wallet, ArrowUpRight, ArrowDownLeft, Plus, Minus, TrendingUp,
  Award, Shield, Clock, ChevronRight, RefreshCw, CreditCard, Smartphone
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { supabase, WalletTransaction } from '@/lib/supabase';
import { toast } from 'sonner';

const tierInfo = {
  silver: {
    label: 'Silver',
    range: '₹0 – ₹9,999',
    gradient: 'from-slate-400 to-slate-600',
    perks: ['Basic features', 'Standard support', 'Normal booking'],
    nextTier: 'gold',
    nextAmount: 10000,
    color: '#94a3b8',
  },
  gold: {
    label: 'Gold',
    range: '₹10,000 – ₹49,999',
    gradient: 'from-amber-400 to-amber-600',
    perks: ['Priority booking', 'Enhanced support', '5% cashback on bookings'],
    nextTier: 'platinum',
    nextAmount: 50000,
    color: '#f59e0b',
  },
  platinum: {
    label: 'Platinum',
    range: '₹50,000+',
    gradient: 'from-slate-300 to-slate-500',
    perks: ['VIP treatment', '24/7 premium support', 'Personal account manager', '10% cashback'],
    nextTier: null,
    nextAmount: null,
    color: '#e2e8f0',
  },
};

export default function WalletPage() {
  const { user, profile, refreshProfile } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<'overview' | 'topup' | 'withdraw'>('overview');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [txLoading, setTxLoading] = useState(true);

  useEffect(() => {
    if (!user) router.push('/auth/signin');
  }, [user, router]);

  // Real wallet: refresh the balance and pull this user's ledger (RLS scopes it to them).
  // Providers see payout credits here; the balance moves only via the server-only credit_wallet.
  useEffect(() => {
    if (!user) return;
    let active = true;
    (async () => {
      await refreshProfile();
      const { data } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (!active) return;
      if (data) setTransactions(data as WalletTransaction[]);
      setTxLoading(false);
    })();
    return () => { active = false; };
  }, [user, refreshProfile]);

  if (!user) return null;

  const balance = profile?.wallet_balance ?? 0;
  const tier = profile?.wallet_tier ?? 'silver';
  const tierData = tierInfo[tier];
  const monthlyReward = ((balance * 0.08) / 12).toFixed(0);
  const progress = tier === 'platinum' ? 100 : tier === 'gold'
    ? ((balance - 10000) / (50000 - 10000)) * 100
    : (balance / 10000) * 100;

  const handleTopUp = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt < 100) {
      toast.error('Minimum top-up is ₹100');
      return;
    }
    setLoading(true);
    await new Promise(r => setTimeout(r, 1500));
    setLoading(false);
    toast.success(`₹${amt.toLocaleString('en-IN')} added to wallet!`);
    setAmount('');
    setTab('overview');
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        <h1 className="text-3xl font-black text-white mb-8 flex items-center gap-3">
          <Wallet className="w-8 h-8 text-[#FF9933]" />
          Seva Wallet
        </h1>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left — Balance Card + Tier */}
          <div className="lg:col-span-2 space-y-5">
            {/* Balance Card */}
            <div className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${tierData.gradient} p-6 text-white`}>
              <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 80% 20%, white 0%, transparent 50%)' }} />
              <div className="relative">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <p className="text-sm opacity-80 mb-1">Available Balance</p>
                    <p className="text-4xl font-black">₹{balance.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-white/20 backdrop-blur rounded-xl px-3 py-1.5">
                    <p className="text-xs font-semibold uppercase tracking-wide">{tierData.label}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 bg-white/20 rounded-full h-2">
                    <div
                      className="bg-white rounded-full h-2 transition-all"
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  </div>
                  {tierData.nextAmount && (
                    <p className="text-xs opacity-70 whitespace-nowrap">
                      ₹{(tierData.nextAmount - balance).toLocaleString('en-IN')} to {tierInfo[tierData.nextTier as keyof typeof tierInfo]?.label}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-4 text-sm opacity-80">
                  <span className="flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5" />8% APR rewards</span>
                  <span className="flex items-center gap-1"><Award className="w-3.5 h-3.5" />{tierData.label} member</span>
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="grid grid-cols-3 gap-4">
              <button
                onClick={() => setTab('topup')}
                className="bg-[#161616] border border-[#2a2a2a] hover:border-[#FF9933]/50 rounded-2xl p-4 text-center transition-all group seva-card-hover"
              >
                <div className="w-10 h-10 rounded-xl bg-[#FF9933]/10 flex items-center justify-center mx-auto mb-2 group-hover:bg-[#FF9933]/20 transition-colors">
                  <Plus className="w-5 h-5 text-[#FF9933]" />
                </div>
                <p className="text-sm font-semibold text-white">Add Money</p>
              </button>
              <button
                onClick={() => setTab('withdraw')}
                className="bg-[#161616] border border-[#2a2a2a] hover:border-[#138808]/50 rounded-2xl p-4 text-center transition-all group seva-card-hover"
              >
                <div className="w-10 h-10 rounded-xl bg-[#138808]/10 flex items-center justify-center mx-auto mb-2 group-hover:bg-[#138808]/20 transition-colors">
                  <Minus className="w-5 h-5 text-[#138808]" />
                </div>
                <p className="text-sm font-semibold text-white">Withdraw</p>
              </button>
              <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-4 text-center">
                <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center mx-auto mb-2">
                  <TrendingUp className="w-5 h-5 text-blue-400" />
                </div>
                <p className="text-xs text-gray-400">Monthly Reward</p>
                <p className="text-sm font-bold text-blue-400">+₹{monthlyReward}</p>
              </div>
            </div>

            {/* Top-up Panel */}
            {tab === 'topup' && (
              <div className="bg-[#161616] border border-[#FF9933]/20 rounded-2xl p-6">
                <h3 className="font-bold text-white mb-4 flex items-center gap-2">
                  <Plus className="w-5 h-5 text-[#FF9933]" />Add Money to Wallet
                </h3>

                <div className="grid grid-cols-4 gap-2 mb-4">
                  {[200, 500, 1000, 2000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setAmount(String(amt))}
                      className={`py-2.5 rounded-xl text-sm font-semibold transition-all ${amount === String(amt) ? 'bg-[#FF9933] text-white' : 'bg-[#1e1e1e] border border-[#2a2a2a] text-gray-300 hover:border-[#FF9933]/50'}`}
                    >
                      ₹{amt}
                    </button>
                  ))}
                </div>

                <div className="relative mb-4">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-semibold">₹</span>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Enter amount"
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-8 pr-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#FF9933]"
                  />
                </div>

                <div className="space-y-2 mb-5">
                  {[
                    { icon: Smartphone, label: 'UPI (GPay, PhonePe, Paytm)', value: 'upi' },
                    { icon: CreditCard, label: 'Debit/Credit Card', value: 'card' },
                  ].map((pm) => (
                    <div key={pm.value} className="flex items-center gap-3 bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl px-4 py-3 cursor-pointer hover:border-[#FF9933]/50 transition-colors">
                      <pm.icon className="w-4 h-4 text-[#FF9933]" />
                      <span className="text-sm text-gray-300">{pm.label}</span>
                    </div>
                  ))}
                </div>

                <button onClick={handleTopUp} disabled={loading} className="saffron-btn w-full rounded-xl py-3 font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
                  {loading ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'Add Money'}
                </button>
              </div>
            )}

            {/* Withdraw Panel */}
            {tab === 'withdraw' && (
              <div className="bg-[#161616] border border-[#138808]/20 rounded-2xl p-6">
                <h3 className="font-bold text-white mb-4 flex items-center gap-2">
                  <Minus className="w-5 h-5 text-[#138808]" />Withdraw to Bank
                </h3>
                <p className="text-sm text-gray-400 mb-4">Withdrawals are processed within 2-3 business days.</p>
                <div className="relative mb-4">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-semibold">₹</span>
                  <input
                    type="number"
                    placeholder="Amount to withdraw"
                    className="w-full bg-[#1e1e1e] border border-[#2a2a2a] rounded-xl pl-8 pr-4 py-3 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#138808]"
                  />
                </div>
                <button className="w-full py-3 bg-[#138808] hover:bg-[#0d6006] text-white font-semibold rounded-xl transition-colors">
                  Request Withdrawal
                </button>
              </div>
            )}

            {/* Transactions */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h3 className="font-bold text-white mb-4">Recent Transactions</h3>
              {txLoading ? (
                <p className="text-sm text-gray-500 py-6 text-center">Loading transactions…</p>
              ) : transactions.length === 0 ? (
                <p className="text-sm text-gray-500 py-6 text-center">No transactions yet.</p>
              ) : (
                <div className="space-y-3">
                  {transactions.map((tx) => (
                    <div key={tx.id} className="flex items-center gap-4 p-3 rounded-xl hover:bg-[#1e1e1e] transition-colors">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
                        tx.type === 'credit' ? 'bg-[#138808]/15' :
                        tx.type === 'reward' ? 'bg-blue-500/15' : 'bg-red-900/20'
                      }`}>
                        {tx.type === 'credit' ? <ArrowDownLeft className="w-4 h-4 text-[#22c55e]" /> :
                         tx.type === 'reward' ? <TrendingUp className="w-4 h-4 text-blue-400" /> :
                         <ArrowUpRight className="w-4 h-4 text-red-400" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{tx.description}</p>
                        <p className="text-xs text-gray-500">{formatTime(tx.created_at)}</p>
                      </div>
                      <p className={`text-sm font-bold flex-shrink-0 ${
                        tx.type === 'debit' ? 'text-red-400' : tx.type === 'reward' ? 'text-blue-400' : 'text-[#22c55e]'
                      }`}>
                        {tx.type === 'debit' ? '-' : '+'}₹{Number(tx.amount).toLocaleString('en-IN')}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right — Tier Info */}
          <div className="space-y-5">
            {/* Current Tier */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h3 className="font-bold text-white mb-4">Your Tier Benefits</h3>
              <div className={`w-16 h-16 rounded-2xl bg-gradient-to-br ${tierData.gradient} flex items-center justify-center mx-auto mb-3`}>
                <span className="text-2xl font-black text-white">{tier[0].toUpperCase()}</span>
              </div>
              <p className="text-center font-bold text-white text-lg mb-1">{tierData.label} Member</p>
              <p className="text-center text-xs text-gray-400 mb-4">{tierData.range}</p>
              <div className="space-y-2">
                {tierData.perks.map((perk) => (
                  <div key={perk} className="flex items-center gap-2">
                    <Shield className="w-3.5 h-3.5 text-[#FF9933] flex-shrink-0" />
                    <span className="text-sm text-gray-300">{perk}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* All Tiers */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h3 className="font-bold text-white mb-4">All Tiers</h3>
              <div className="space-y-3">
                {(Object.entries(tierInfo) as [string, typeof tierInfo.silver][]).map(([key, t]) => (
                  <div key={key} className={`flex items-center gap-3 p-3 rounded-xl transition-all ${tier === key ? 'bg-[#FF9933]/10 border border-[#FF9933]/20' : 'hover:bg-[#1e1e1e]'}`}>
                    <div className={`w-8 h-8 rounded-full bg-gradient-to-br ${t.gradient} flex items-center justify-center text-xs font-black text-white flex-shrink-0`}>
                      {t.label[0]}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-white">{t.label}</p>
                      <p className="text-xs text-gray-500">{t.range}</p>
                    </div>
                    {tier === key && <span className="text-xs text-[#FF9933] font-medium">Current</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Reward Calculator */}
            <div className="bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5">
              <h3 className="font-bold text-white mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-[#FF9933]" />Monthly Rewards
              </h3>
              <p className="text-3xl font-black text-[#FF9933]">+₹{monthlyReward}</p>
              <p className="text-xs text-gray-400 mt-1">At 8% APR on ₹{balance.toLocaleString('en-IN')} balance</p>
              <div className="mt-3 p-3 bg-[#1e1e1e] rounded-xl">
                <p className="text-xs text-gray-500">Annual projection</p>
                <p className="text-sm font-bold text-white">+₹{(balance * 0.08).toFixed(0)}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
