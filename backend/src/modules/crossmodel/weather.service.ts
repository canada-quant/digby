/**
 * Weather Service — location + current conditions for the home screen.
 *
 * Uses Open-Meteo (https://open-meteo.com) — free, no API key:
 *   - Geocoding:  https://geocoding-api.open-meteo.com/v1/search
 *   - Forecast:   https://api.open-meteo.com/v1/forecast
 *
 * Location resolution order:
 *   1. `userMemory.facts.location` (free text, e.g. "Vancouver, BC") → geocoded
 *   2. `userMemory.facts.timezone` (e.g. "America/Vancouver") → city name from
 *      the last IANA segment → geocoded
 *   3. Neither → { available: false } (the UI simply hides the weather line)
 *
 * Caching (Redis):
 *   - `user:weather:${userId}` — assembled payload, 30 min TTL (weather moves slowly)
 *   - `weather:geo:${slug}`    — geocode result per location string, 7 day TTL
 *
 * All failures degrade to { available: false } — the home screen must never
 * error because a third-party weather API hiccupped.
 */

import axios from 'axios';
import redisClient from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../utils/logger';

const WEATHER_CACHE_KEY = (userId: string) => `user:weather:${userId}`;
const WEATHER_CACHE_TTL = 30 * 60;            // 30 min
const GEO_CACHE_KEY = (slug: string) => `weather:geo:${slug}`;
const GEO_CACHE_TTL = 7 * 24 * 60 * 60;       // 7 days (successful geocode — stable)
// 2026-07-10: Negative (MISS) geocode results get a MUCH shorter TTL. A 7-day
// negative cache means a user whose valid location simply isn't in Open-Meteo's
// index (small suburb) — or who fixes a typo to a place the API doesn't have —
// would be locked out of weather for a week. A 90-min TTL lets recovery happen
// quickly (e.g. after the user updates their location fact to a nearby city)
// while still sparing the API from a hit on every home-screen load.
const GEO_NEG_CACHE_TTL = 90 * 60;            // 90 min for negative (MISS) results
const HTTP_TIMEOUT_MS = 8000;

export interface WeatherPayload {
  available: boolean;
  location?: {
    name: string;       // "Vancouver"
    region?: string;    // "British Columbia"
    country?: string;   // "Canada"
  };
  current?: {
    tempC: number;
    tempF: number;
    apparentC: number;
    code: number;          // WMO weather code
    description: string;   // "Partly cloudy"
    icon: string;          // emoji for compact display
    windKph: number;
    humidity: number;
    isDay: boolean;
  };
  today?: {
    maxC: number;
    minC: number;
    maxF: number;
    minF: number;
  };
  updatedAt?: string;
}

interface GeoResult {
  latitude: number;
  longitude: number;
  name: string;
  admin1?: string;
  country?: string;
}

// ── WMO weather code → human description + emoji ──────────────────────────────
// https://open-meteo.com/en/docs — WMO Weather interpretation codes (WW)
const WMO_CODES: Record<number, { label: string; day: string; night: string }> = {
  0:  { label: 'Clear sky',            day: '☀️', night: '🌙' },
  1:  { label: 'Mostly clear',         day: '🌤️', night: '🌙' },
  2:  { label: 'Partly cloudy',        day: '⛅', night: '☁️' },
  3:  { label: 'Overcast',             day: '☁️', night: '☁️' },
  45: { label: 'Fog',                  day: '🌫️', night: '🌫️' },
  48: { label: 'Icy fog',              day: '🌫️', night: '🌫️' },
  51: { label: 'Light drizzle',        day: '🌦️', night: '🌧️' },
  53: { label: 'Drizzle',              day: '🌦️', night: '🌧️' },
  55: { label: 'Heavy drizzle',        day: '🌧️', night: '🌧️' },
  56: { label: 'Freezing drizzle',     day: '🌧️', night: '🌧️' },
  57: { label: 'Freezing drizzle',     day: '🌧️', night: '🌧️' },
  61: { label: 'Light rain',           day: '🌦️', night: '🌧️' },
  63: { label: 'Rain',                 day: '🌧️', night: '🌧️' },
  65: { label: 'Heavy rain',           day: '🌧️', night: '🌧️' },
  66: { label: 'Freezing rain',        day: '🌧️', night: '🌧️' },
  67: { label: 'Freezing rain',        day: '🌧️', night: '🌧️' },
  71: { label: 'Light snow',           day: '🌨️', night: '🌨️' },
  73: { label: 'Snow',                 day: '🌨️', night: '🌨️' },
  75: { label: 'Heavy snow',           day: '❄️', night: '❄️' },
  77: { label: 'Snow grains',          day: '🌨️', night: '🌨️' },
  80: { label: 'Light showers',        day: '🌦️', night: '🌧️' },
  81: { label: 'Showers',              day: '🌧️', night: '🌧️' },
  82: { label: 'Heavy showers',        day: '🌧️', night: '🌧️' },
  85: { label: 'Snow showers',         day: '🌨️', night: '🌨️' },
  86: { label: 'Snow showers',         day: '🌨️', night: '🌨️' },
  95: { label: 'Thunderstorm',         day: '⛈️', night: '⛈️' },
  96: { label: 'Thunderstorm w/ hail', day: '⛈️', night: '⛈️' },
  99: { label: 'Thunderstorm w/ hail', day: '⛈️', night: '⛈️' },
};

function describeWmo(code: number, isDay: boolean): { description: string; icon: string } {
  const entry = WMO_CODES[code] || { label: 'Unknown', day: '🌡️', night: '🌡️' };
  return { description: entry.label, icon: isDay ? entry.day : entry.night };
}

const cToF = (c: number) => Math.round(c * 9 / 5 + 32);

// ── Location resolution ────────────────────────────────────────────────────────

/**
 * Derive a geocodable place name from the user's memory facts.
 * Prefers the free-text `location` fact; falls back to the IANA timezone city.
 * Exported for unit tests.
 */
export function placeNameFromFacts(facts: Record<string, string>): string | null {
  const location = String(facts.location || '').trim();
  if (location) {
    // Geocoding works best on "City" or "City, Region" — strip long trailing
    // descriptions ("lives in Vancouver with family" → keep as-is; the search
    // API tolerates noise poorly, so take the first comma-separated pieces).
    return location.split(/[,;·]/).slice(0, 2).join(',').trim().substring(0, 80) || null;
  }
  const tz = String(facts.timezone || '').trim();
  if (tz.includes('/')) {
    const city = tz.split('/').pop()!.replace(/_/g, ' ').trim();
    if (city && !/^(UTC|GMT)/i.test(city)) return city;
  }
  return null;
}

/**
 * Common US-state + Canadian-province abbreviations, so a "Vancouver, BC" or
 * "Austin, TX" region hint can be matched against Open-Meteo's full admin1
 * names ("British Columbia", "Texas").
 */
const REGION_ABBREVIATIONS: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado',
  ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho',
  il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana',
  me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota',
  ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada',
  nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina',
  nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas',
  ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia',
  wi: 'wisconsin', wy: 'wyoming', dc: 'district of columbia',
  bc: 'british columbia', ab: 'alberta', sk: 'saskatchewan', mb: 'manitoba', on: 'ontario',
  qc: 'quebec', ns: 'nova scotia', nb: 'new brunswick', pe: 'prince edward island',
  nl: 'newfoundland and labrador', yt: 'yukon', nt: 'northwest territories', nu: 'nunavut',
};

async function geocode(place: string): Promise<GeoResult | null> {
  const slug = place.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return null;

  try {
    const cached = await redisClient.get(GEO_CACHE_KEY(slug));
    if (cached) {
      const parsed = JSON.parse(cached);
      return parsed === 'MISS' ? null : parsed as GeoResult;
    }
  } catch { /* cache miss path below */ }

  // Open-Meteo's search endpoint only matches bare place names — "Vancouver, BC"
  // returns ZERO results (verified live). So: query the city segment alone and
  // use the remaining segment as a region hint to pick among the candidates.
  const [cityRaw, regionRaw] = place.split(',').map(s => s.trim());
  const city = cityRaw || place;
  const regionHint = (regionRaw || '').toLowerCase();
  const expandedHint = REGION_ABBREVIATIONS[regionHint] || regionHint;

  const queryCandidates = async (name: string): Promise<any[]> => {
    const resp = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
      params: { name, count: 5, language: 'en', format: 'json' },
      timeout: HTTP_TIMEOUT_MS,
    });
    const results: any[] = Array.isArray(resp.data?.results) ? resp.data.results : [];
    return results.filter(r => typeof r?.latitude === 'number' && typeof r?.longitude === 'number');
  };

  try {
    let candidates = await queryCandidates(city);
    // Small suburbs ("Oak Bay, Victoria, BC") often aren't in Open-Meteo's index,
    // so the first segment returns nothing. Fall back to the region/parent segment
    // ("Victoria") as the city before giving up — better a nearby city than
    // "unavailable" for a user who has a valid location fact.
    if (candidates.length === 0 && regionRaw && regionRaw.toLowerCase() !== city.toLowerCase()) {
      candidates = await queryCandidates(regionRaw);
    }
    if (candidates.length === 0) {
      // Cache negative results too — a bad location fact shouldn't re-hit the API every load —
      // but with a short TTL (90 min) so a corrected/updated location recovers quickly.
      try { await redisClient.setEx(GEO_CACHE_KEY(slug), GEO_NEG_CACHE_TTL, JSON.stringify('MISS')); } catch { /* ok */ }
      return null;
    }

    const matchesHint = (r: any): boolean => {
      if (!expandedHint) return false;
      const admin1 = String(r.admin1 || '').toLowerCase();
      const country = String(r.country || '').toLowerCase();
      const cc = String(r.country_code || '').toLowerCase();
      return admin1 === expandedHint || country === expandedHint || cc === regionHint
        || admin1.startsWith(expandedHint) || country.startsWith(expandedHint);
    };
    // Prefer the candidate matching the region hint; otherwise Open-Meteo's
    // first result (ranked by population/relevance).
    const hit = candidates.find(matchesHint) || candidates[0];

    const geo: GeoResult = {
      latitude: hit.latitude,
      longitude: hit.longitude,
      name: hit.name || city,
      admin1: hit.admin1 || undefined,
      country: hit.country || undefined,
    };
    try { await redisClient.setEx(GEO_CACHE_KEY(slug), GEO_CACHE_TTL, JSON.stringify(geo)); } catch { /* ok */ }
    return geo;
  } catch (err: any) {
    // Don't log the place string itself — it derives from the user's free-text
    // memory location fact (possible PII), and warn-level logs persist to
    // app_error_logs and feed the nightly autopilot analyzer.
    logger.warn(`weather.service: geocode failed (${place.length}-char place): ${err.message}`);
    return null;
  }
}

// ── Forecast ──────────────────────────────────────────────────────────────────

async function fetchForecast(geo: GeoResult): Promise<WeatherPayload | null> {
  try {
    const resp = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: geo.latitude,
        longitude: geo.longitude,
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day',
        daily: 'temperature_2m_max,temperature_2m_min',
        forecast_days: 1,
        timezone: 'auto',
      },
      timeout: HTTP_TIMEOUT_MS,
    });
    const cur = resp.data?.current;
    const daily = resp.data?.daily;
    if (!cur || typeof cur.temperature_2m !== 'number') return null;

    const isDay = cur.is_day === 1;
    const { description, icon } = describeWmo(Number(cur.weather_code ?? -1), isDay);
    const maxC = Number(daily?.temperature_2m_max?.[0] ?? cur.temperature_2m);
    const minC = Number(daily?.temperature_2m_min?.[0] ?? cur.temperature_2m);

    return {
      available: true,
      location: { name: geo.name, region: geo.admin1, country: geo.country },
      current: {
        tempC: Math.round(cur.temperature_2m),
        tempF: cToF(cur.temperature_2m),
        apparentC: Math.round(cur.apparent_temperature ?? cur.temperature_2m),
        code: Number(cur.weather_code ?? -1),
        description,
        icon,
        windKph: Math.round(cur.wind_speed_10m ?? 0),
        humidity: Math.round(cur.relative_humidity_2m ?? 0),
        isDay,
      },
      today: {
        maxC: Math.round(maxC),
        minC: Math.round(minC),
        maxF: cToF(maxC),
        minF: cToF(minC),
      },
      updatedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    logger.warn(`weather.service: forecast failed for ${geo.name}: ${err.message}`);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

const UNAVAILABLE: WeatherPayload = { available: false };

/**
 * Get location + current weather for a user. Cached 30 min per user.
 * Never throws — returns { available: false } on any failure.
 */
export async function getWeatherForUser(userId: string): Promise<WeatherPayload> {
  try {
    const cached = await redisClient.get(WEATHER_CACHE_KEY(userId));
    if (cached) return JSON.parse(cached) as WeatherPayload;
  } catch { /* fall through to fresh fetch */ }

  try {
    const memory = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
    const facts = (memory?.facts as Record<string, string>) || {};
    const place = placeNameFromFacts(facts);
    if (!place) {
      // Short negative cache: the user may add a location fact at any time
      try { await redisClient.setEx(WEATHER_CACHE_KEY(userId), 10 * 60, JSON.stringify(UNAVAILABLE)); } catch { /* ok */ }
      return UNAVAILABLE;
    }

    const geo = await geocode(place);
    if (!geo) {
      try { await redisClient.setEx(WEATHER_CACHE_KEY(userId), WEATHER_CACHE_TTL, JSON.stringify(UNAVAILABLE)); } catch { /* ok */ }
      return UNAVAILABLE;
    }

    const payload = await fetchForecast(geo);
    if (!payload) return UNAVAILABLE; // transient forecast failure — don't negative-cache long

    try { await redisClient.setEx(WEATHER_CACHE_KEY(userId), WEATHER_CACHE_TTL, JSON.stringify(payload)); } catch { /* ok */ }
    return payload;
  } catch (err: any) {
    logger.warn(`weather.service: getWeatherForUser failed for ${userId}: ${err.message}`);
    return UNAVAILABLE;
  }
}

export default { getWeatherForUser };
