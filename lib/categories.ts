/* Category presentation, in one place.
 *
 * The category LIST is data — `service_categories` is admin-managed (Step 15/Bucket B), so adding
 * a category is an insert, not a deploy. The list must therefore come from the DB.
 *
 * What genuinely belongs in code is the LOOK: an icon and a colour per category, since neither has
 * a column and neither should. So this module maps slug → presentation and nothing else, with a
 * neutral default so a category added tomorrow renders correctly today instead of disappearing.
 *
 * Why it exists: /services carried its own hardcoded array of 14 categories while the DB held 25.
 * Eleven categories — Laundry, Maid, Mason, Painter, Security, Tailor, Water Tanker, Mobile Repair,
 * Cycle Repair, Auto Rickshaw, Cow Dung — could not be filtered from the browse page at all, and
 * its labels had drifted from the DB names ("Farm Fresh" vs "Farm Fresh Delivery"). A hardcoded
 * mirror of an admin-editable table is a bug waiting for the next insert.
 */
import {
  Zap, Wrench, ChefHat, Sparkles, Heart, Car, Stethoscope, GraduationCap, Settings, Hammer,
  Leaf, Scissors, ShoppingBasket, Truck, Bike, Recycle, Shirt, Home, Construction, Smartphone,
  Paintbrush, ShieldCheck, Ruler, Droplets, Tag, type LucideIcon,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';

export type CategoryRow = { id: string; name: string; slug: string };

export type CategoryStyle = { icon: LucideIcon; color: string; gradient: string };

const STYLES: Record<string, CategoryStyle> = {
  electrician:        { icon: Zap,            color: '#FF9933', gradient: 'from-amber-500 to-orange-600' },
  plumber:            { icon: Wrench,         color: '#3b82f6', gradient: 'from-blue-500 to-cyan-600' },
  'home-cook':        { icon: ChefHat,        color: '#ef4444', gradient: 'from-red-500 to-orange-500' },
  'house-cleaning':   { icon: Sparkles,       color: '#22c55e', gradient: 'from-pink-500 to-rose-600' },
  caretaker:          { icon: Heart,          color: '#ec4899', gradient: 'from-purple-500 to-violet-600' },
  driver:             { icon: Car,            color: '#94a3b8', gradient: 'from-slate-500 to-slate-600' },
  doctor:             { icon: Stethoscope,    color: '#14b8a6', gradient: 'from-teal-500 to-cyan-600' },
  tutor:              { icon: GraduationCap,  color: '#a855f7', gradient: 'from-indigo-500 to-purple-600' },
  'appliance-repair': { icon: Settings,       color: '#6366f1', gradient: 'from-gray-500 to-slate-600' },
  carpenter:          { icon: Hammer,         color: '#f59e0b', gradient: 'from-yellow-500 to-amber-600' },
  gardening:          { icon: Leaf,           color: '#84cc16', gradient: 'from-lime-500 to-green-600' },
  beauty:             { icon: Scissors,       color: '#f43f5e', gradient: 'from-rose-500 to-pink-600' },
  'farm-fresh':       { icon: ShoppingBasket, color: '#10b981', gradient: 'from-green-500 to-emerald-600' },
  delivery:           { icon: Truck,          color: '#f97316', gradient: 'from-orange-500 to-amber-500' },
  // The eleven that the hardcoded list never offered.
  'auto-driver':      { icon: Bike,           color: '#eab308', gradient: 'from-yellow-500 to-orange-500' },
  'cow-dung':         { icon: Recycle,        color: '#a16207', gradient: 'from-amber-700 to-yellow-800' },
  'cycle-mechanic':   { icon: Bike,           color: '#0ea5e9', gradient: 'from-sky-500 to-blue-600' },
  laundry:            { icon: Shirt,          color: '#38bdf8', gradient: 'from-sky-400 to-cyan-500' },
  maid:               { icon: Home,           color: '#fb7185', gradient: 'from-rose-400 to-pink-500' },
  mason:              { icon: Construction,   color: '#78716c', gradient: 'from-stone-500 to-neutral-600' },
  'mobile-repair':    { icon: Smartphone,     color: '#8b5cf6', gradient: 'from-violet-500 to-purple-600' },
  painter:            { icon: Paintbrush,     color: '#e11d48', gradient: 'from-red-500 to-rose-600' },
  security:           { icon: ShieldCheck,    color: '#0891b2', gradient: 'from-cyan-600 to-teal-700' },
  tailor:             { icon: Ruler,          color: '#d946ef', gradient: 'from-fuchsia-500 to-purple-600' },
  'water-tanker':     { icon: Droplets,       color: '#06b6d4', gradient: 'from-cyan-500 to-blue-600' },
};

export const DEFAULT_CATEGORY_STYLE: CategoryStyle = {
  icon: Tag, color: '#94a3b8', gradient: 'from-slate-500 to-slate-600',
};

/** Presentation for a slug — never undefined, so an unknown/new category still renders. */
export const styleFor = (slug: string | null | undefined): CategoryStyle =>
  (slug && STYLES[slug]) || DEFAULT_CATEGORY_STYLE;

/**
 * A compact chip label from the full category name. DB names carry a qualifier for the admin's
 * benefit ("Home Cook / Tiffin", "Mobile Repair / Accessories") which is too long for a filter
 * chip. The full name is still what the card shows.
 */
export function chipLabel(name: string): string {
  const first = name.split('/')[0].trim();
  return first.length <= 20 ? first : first.split('&')[0].trim();
}

/** The categories that actually exist, newest schema wins. Public read — no auth needed. */
export async function fetchCategories(): Promise<CategoryRow[]> {
  const { data, error } = await supabase
    .from('service_categories').select('id, name, slug').order('name');
  if (error) {
    console.error('Failed to load categories:', error.message);
    return [];
  }
  return (data ?? []) as CategoryRow[];
}
