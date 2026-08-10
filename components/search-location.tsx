'use client';

import { useEffect, useRef, useState } from 'react';
import { MapPin, Navigation, Loader2, X } from 'lucide-react';
import {
  anchorForPincode, isPincode, requestBrowserLocation,
  type CityAnchor, type SearchOrigin,
} from '@/lib/matching';

/* Where the customer is searching FROM — one control, shared by /services and /providers so the
   two pages cannot drift apart again (they already had two copies of the city picker, and one of
   them silently offered cities that could not rank).

   Two rules shape this:

   1. GPS PREFILLS, IT DOES NOT LOCK. People search for places they are not standing in — a
      parent's flat, an office, the house they are about to move into. So the device position is a
      starting point shown in an editable field, never a "home" the page decides for them. It is
      also only read WITHOUT PROMPTING when permission was already granted; a location prompt
      fired at page load is a demand made before the visitor knows what the page is for.

   2. Typed input is a PINCODE or a city, not an address to geocode. Ranking needs a coarse
      origin and nothing more (see lib/matching.ts) — so a pincode resolves to the same city
      anchor the dropdown offers, with no external lookup on the customer's critical path. The
      precise address is asked for once, at booking time, where it is actually needed. */

export default function SearchLocation({ anchors, origin, onOrigin, autoLocate = true, compact = false }: {
  anchors: CityAnchor[];
  origin: SearchOrigin | null;
  onOrigin: (next: SearchOrigin | null) => void;
  /** False when the page already has an explicit location intent — e.g. it arrived with ?city=.
   *  A prefill must never overrule a choice the customer already made. */
  autoLocate?: boolean;
  compact?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Prefill runs once, and only when we already have permission. A ref, not state, so it can
  // never re-trigger a search — this page has been round-tripped by a re-render loop before.
  const prefilled = useRef(false);
  /* A live mirror of the origin prop, readable from inside the async prefill AFTER its awaits.
     The closure's `origin` is the value at effect time and is therefore always stale by then —
     which is exactly how the prefill managed to overwrite a choice made while it was in flight. */
  const originRef = useRef(origin);
  originRef.current = origin;

  useEffect(() => {
    if (prefilled.current || origin || anchors.length === 0 || !autoLocate) return;
    prefilled.current = true;
    (async () => {
      try {
        // Safari has no permissions API for geolocation; absence just means "don't prefill".
        const status = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
        if (status?.state !== 'granted') return;
      } catch { return; }
      const pos = await requestBrowserLocation();
      if ('error' in pos) return;   // silent: they never asked for this, so don't report it
      /* Two awaits have passed. If ANYTHING set a location while we were waiting — the ?city=
         param, or the customer typing a pincode — that is a deliberate choice and this passive
         prefill must not overwrite it. Found in a browser check: arriving from the homepage with
         ?city=Kalyan ranked from Kalyan and then silently jumped to "your location". */
      if (originRef.current) return;
      onOrigin({ ...pos, label: 'your location' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors, origin, autoLocate]);

  const useMyLocation = async () => {
    setLocating(true);
    setNote(null);
    const pos = await requestBrowserLocation();
    setLocating(false);
    if ('error' in pos) {
      // Declined or unavailable is never a dead end — the pincode box and the city list both work.
      setNote(pos.error);
      return;
    }
    setTyped('');
    onOrigin({ ...pos, label: 'your location' });
  };

  const applyTyped = () => {
    const value = typed.trim();
    if (!value) return;

    if (isPincode(value)) {
      const anchor = anchorForPincode(value, anchors);
      if (!anchor) {
        setNote(`We don't have providers around ${value} yet. Pick a city to search from instead.`);
        return;
      }
      setNote(null);
      onOrigin({ lat: anchor.lat, lng: anchor.lng, label: `${value} · ${anchor.city}` });
      return;
    }

    // Not a pincode: accept a city name typed by hand, since people type "Thane" more readily
    // than they scroll a dropdown.
    const anchor = anchors.find((a) => a.city.toLowerCase() === value.toLowerCase());
    if (anchor) {
      setNote(null);
      onOrigin({ lat: anchor.lat, lng: anchor.lng, label: anchor.city });
      return;
    }
    setNote(`We can't search from "${value}". Enter a 6-digit pincode, or pick a city.`);
  };

  const pickCity = (city: string) => {
    setTyped('');
    if (!city) { setNote(null); onOrigin(null); return; }
    const anchor = anchors.find((a) => a.city === city);
    if (!anchor) { setNote(`We don't have enough providers in ${city} to search from yet.`); return; }
    setNote(null);
    onOrigin({ lat: anchor.lat, lng: anchor.lng, label: city });
  };

  return (
    <div className={compact ? '' : 'w-full'}>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 flex items-center gap-3 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 focus-within:border-[#FF9933]/60 transition-colors">
          <MapPin className="w-5 h-5 text-gray-500 flex-shrink-0" />
          <input
            type="text"
            inputMode="text"
            aria-label="Search location"
            placeholder="Pincode or city — e.g. 400053"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyTyped(); } }}
            onBlur={applyTyped}
            className="flex-1 bg-transparent text-white placeholder-gray-500 text-sm focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          className="flex items-center justify-center gap-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white hover:border-[#FF9933] transition-colors disabled:opacity-60"
        >
          {locating
            ? <><Loader2 className="w-4 h-4 animate-spin" />Finding you…</>
            : <><Navigation className="w-4 h-4 text-[#FF9933]" />Use my location</>}
        </button>
        <select
          value={anchors.some((a) => a.city === origin?.label) ? origin!.label : ''}
          onChange={(e) => pickCity(e.target.value)}
          aria-label="Search from a city"
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#FF9933] min-w-[150px]"
        >
          <option value="">Or pick a city</option>
          {anchors.map((a) => <option key={a.city} value={a.city}>{a.city} ({a.provider_count})</option>)}
        </select>
      </div>

      {/* What is actually in effect, and how to change it. The customer should never have to guess
          which of the three inputs won. */}
      {origin && (
        <p className="text-xs text-gray-400 mt-3 flex items-center gap-1.5 flex-wrap">
          <MapPin className="w-3.5 h-3.5 text-[#FF9933]" />
          Searching near <span className="text-white font-medium">{origin.label}</span>
          <button
            type="button"
            onClick={() => { setTyped(''); setNote(null); onOrigin(null); }}
            className="inline-flex items-center gap-1 text-gray-500 hover:text-white transition-colors"
          >
            <X className="w-3 h-3" />clear
          </button>
        </p>
      )}

      {note && (
        <p className="text-xs text-gray-400 mt-2 flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-gray-500" />{note}
        </p>
      )}
    </div>
  );
}
