'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface LocationData {
  lat: number;
  lng: number;
  city?: string;
  state?: string;
  address?: string;
  loading: boolean;
  error: string | null;
}

interface LocationContextType {
  location: LocationData;
  requestLocation: () => void;
  setLocation: (loc: Partial<LocationData>) => void;
}

const LocationContext = createContext<LocationContextType>({
  location: { lat: 0, lng: 0, loading: false, error: null },
  requestLocation: () => {},
  setLocation: () => {},
});

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const [location, setLocationState] = useState<LocationData>({
    lat: 19.076, // Mumbai default
    lng: 72.877,
    city: 'Mumbai',
    state: 'Maharashtra',
    loading: false,
    error: null,
  });

  const setLocation = useCallback((loc: Partial<LocationData>) => {
    setLocationState(prev => ({ ...prev, ...loc }));
  }, []);

  const requestLocation = useCallback(() => {
    if (typeof window === 'undefined') return;
    setLocationState(prev => ({ ...prev, loading: true, error: null }));

    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setLocationState(prev => ({
            ...prev,
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            loading: false,
            error: null,
          }));
        },
        (err) => {
          setLocationState(prev => ({
            ...prev,
            loading: false,
            error: err.code === 1 ? 'Location permission denied' : 'Location unavailable',
          }));
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    } else {
      setLocationState(prev => ({ ...prev, loading: false, error: 'Geolocation not supported' }));
    }
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  return (
    <LocationContext.Provider value={{ location, requestLocation, setLocation }}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation() {
  return useContext(LocationContext);
}
