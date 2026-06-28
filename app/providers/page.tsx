'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Search, Star, MapPin, Clock, CheckCircle, Filter, Users } from 'lucide-react';

const allProviders = [
  { id: '1', name: 'Amit Sharma', category: 'Electrician', rating: 4.9, reviews: 156, rate: 350, exp: 8, city: 'Mumbai', verified: true, available: true, avatar: 'AS', gradient: 'from-amber-500 to-orange-600', bio: 'Expert electrician with 8+ years. Specializes in home wiring, switchboard repairs, and electrical installations.' },
  { id: '2', name: 'Priya Patel', category: 'House Cleaning', rating: 4.8, reviews: 203, rate: 250, exp: 5, city: 'Mumbai', verified: true, available: true, avatar: 'PP', gradient: 'from-pink-500 to-rose-600', bio: 'Professional house cleaner offering deep cleaning, organizing, and regular maintenance services.' },
  { id: '3', name: 'Ravi Kumar', category: 'Plumber', rating: 4.9, reviews: 89, rate: 300, exp: 10, city: 'Pune', verified: true, available: true, avatar: 'RK', gradient: 'from-blue-500 to-cyan-600', bio: 'Senior plumber handling all types of plumbing work — pipes, leaks, bathrooms, water heaters.' },
  { id: '4', name: 'Meena Devi', category: 'Home Cook', rating: 4.7, reviews: 312, rate: 200, exp: 7, city: 'Delhi', verified: true, available: false, avatar: 'MD', gradient: 'from-red-500 to-orange-500', bio: 'Home cook specializing in North Indian cuisine. Daily tiffin service available for hostelites and professionals.' },
  { id: '5', name: 'Suresh Farm', category: 'Farm Fresh', rating: 4.8, reviews: 145, rate: 0, exp: 15, city: 'Nashik', verified: true, available: true, avatar: 'SF', gradient: 'from-green-500 to-emerald-600', bio: 'Organic farm delivering fresh milk, fruits and vegetables directly to your doorstep.' },
  { id: '6', name: 'Rajesh Kadam', category: 'Delivery', rating: 4.6, reviews: 78, rate: 0, exp: 3, city: 'Mumbai', verified: true, available: true, avatar: 'RK', gradient: 'from-orange-500 to-amber-500', bio: 'Fast and reliable delivery service. Available for nearby gigs within 10km.' },
  { id: '7', name: 'Dr. Anita Singh', category: 'Home Doctor', rating: 4.9, reviews: 67, rate: 800, exp: 12, city: 'Bangalore', verified: true, available: true, avatar: 'AS', gradient: 'from-teal-500 to-cyan-600', bio: 'MBBS, MD. Home visit consultations for general medicine, fever, cold, and elderly care.' },
  { id: '8', name: 'Vikram Sharma', category: 'Carpenter', rating: 4.7, reviews: 134, rate: 400, exp: 12, city: 'Hyderabad', verified: true, available: true, avatar: 'VS', gradient: 'from-yellow-500 to-amber-600', bio: 'Expert carpenter. Furniture making, repairs, modular kitchen, wardrobes.' },
  { id: '9', name: 'Sita Ram', category: 'Caretaker', rating: 4.8, reviews: 56, rate: 350, exp: 6, city: 'Chennai', verified: true, available: false, avatar: 'SR', gradient: 'from-purple-500 to-violet-600', bio: 'Caring and experienced caretaker for elderly persons. Available for day/night shifts.' },
  { id: '10', name: 'Pooja Gupta', category: 'Tutor', rating: 4.9, reviews: 198, rate: 400, exp: 9, city: 'Noida', verified: true, available: true, avatar: 'PG', gradient: 'from-indigo-500 to-purple-600', bio: 'Experienced tutor for classes 6-12. Subjects: Math, Science, English.' },
  { id: '11', name: 'Arjun Rao', category: 'Appliance Repair', rating: 4.6, reviews: 93, rate: 300, exp: 7, city: 'Bangalore', verified: true, available: true, avatar: 'AR', gradient: 'from-gray-500 to-slate-600', bio: 'Expert in repairing washing machines, refrigerators, ACs, laptops, and WiFi routers.' },
  { id: '12', name: 'Kavita Krishnan', category: 'Beauty & Wellness', rating: 4.8, reviews: 167, rate: 500, exp: 8, city: 'Mumbai', verified: true, available: true, avatar: 'KK', gradient: 'from-rose-500 to-pink-600', bio: 'Home salon services — waxing, facials, threading, manicure, pedicure, and bridal makeup.' },
];

export default function ProvidersPage() {
  const [search, setSearch] = useState('');
  const [cityFilter, setCityFilter] = useState('');

  const filtered = allProviders.filter((p) => {
    const matchesSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.category.toLowerCase().includes(search.toLowerCase());
    const matchesCity = !cityFilter || p.city.toLowerCase() === cityFilter.toLowerCase();
    return matchesSearch && matchesCity;
  });

  const cities = Array.from(new Set(allProviders.map((p) => p.city)));

  return (
    <div className="min-h-screen bg-[#0d0d0d] pt-20">
      {/* Header */}
      <div className="bg-[#0a0a0a] border-b border-[#1e1e1e] py-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-[#FF9933]" />
            <h1 className="text-3xl font-black text-white">All Providers</h1>
          </div>
          <p className="text-gray-400 mb-6">Browse all verified service professionals on Seva</p>

          <div className="flex flex-col sm:flex-row gap-3 max-w-2xl">
            <div className="flex-1 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3">
              <Search className="w-5 h-5 text-gray-500" />
              <input
                type="text"
                placeholder="Search by name or category..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
              />
            </div>
            <select
              value={cityFilter}
              onChange={(e) => setCityFilter(e.target.value)}
              className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#FF9933] min-w-[150px]"
            >
              <option value="">All Cities</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <p className="text-gray-400 text-sm mb-6">
          Showing <span className="text-white font-semibold">{filtered.length}</span> providers
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((p) => (
            <Link
              key={p.id}
              href={`/providers/${p.id}`}
              className="group bg-[#161616] border border-[#2a2a2a] rounded-2xl p-5 seva-card-hover block"
            >
              <div className="flex items-start gap-4 mb-4">
                <div className="relative flex-shrink-0">
                  <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-lg font-black text-white`}>
                    {p.avatar}
                  </div>
                  {p.available && (
                    <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[#22c55e] border-2 border-[#161616]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between">
                    <h3 className="font-bold text-white group-hover:text-[#FF9933] transition-colors">{p.name}</h3>
                    {p.verified && <CheckCircle className="w-4 h-4 text-[#138808] flex-shrink-0" />}
                  </div>
                  <p className="text-xs text-[#FF9933] font-medium mt-0.5">{p.category}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <Star className="w-3 h-3 fill-[#FF9933] text-[#FF9933]" />
                    <span className="text-xs font-semibold text-white">{p.rating}</span>
                    <span className="text-xs text-gray-500">({p.reviews} reviews)</span>
                  </div>
                </div>
              </div>

              <p className="text-xs text-gray-400 leading-relaxed mb-4 line-clamp-2">{p.bio}</p>

              <div className="flex items-center gap-3 text-xs text-gray-500 mb-4">
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{p.city}</span>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{p.exp}y experience</span>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-[#222]">
                {p.rate > 0 ? (
                  <p className="text-sm font-bold text-white">₹{p.rate}<span className="text-xs font-normal text-gray-500">/hr</span></p>
                ) : (
                  <p className="text-sm font-bold text-[#138808]">Contact for pricing</p>
                )}
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${p.available ? 'bg-[#22c55e]/10 text-[#22c55e] border border-[#22c55e]/20' : 'bg-gray-800/50 text-gray-500'}`}>
                  {p.available ? 'Available' : 'Busy'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
