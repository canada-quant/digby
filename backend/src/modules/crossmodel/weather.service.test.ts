/**
 * Tests for weather.service.ts — location resolution + payload assembly.
 * Redis / Prisma / axios are mocked; no network or DB required.
 */

jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), setEx: jest.fn() },
}));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: { userMemory: { findUnique: jest.fn() } },
}));
// logger transitively imports config/env, whose Zod validation process.exit(1)s
// in a keyless test environment — mock it out like the other suites do.
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

import axios from 'axios';
import redisClient from '../../config/redis';
import prisma from '../../config/database';
import { getWeatherForUser, placeNameFromFacts } from './weather.service';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedRedis = redisClient as unknown as { get: jest.Mock; setEx: jest.Mock };
const mockedPrisma = prisma as unknown as { userMemory: { findUnique: jest.Mock } };

beforeEach(() => {
  jest.clearAllMocks();
  mockedRedis.get.mockResolvedValue(null);
  mockedRedis.setEx.mockResolvedValue('OK');
});

describe('placeNameFromFacts', () => {
  it('prefers the location fact and trims to city, region', () => {
    expect(placeNameFromFacts({ location: 'Vancouver, BC, Canada' })).toBe('Vancouver, BC');
    expect(placeNameFromFacts({ location: 'Austin' })).toBe('Austin');
  });

  it('falls back to the IANA timezone city', () => {
    expect(placeNameFromFacts({ timezone: 'America/Los_Angeles' })).toBe('Los Angeles');
    expect(placeNameFromFacts({ timezone: 'America/Vancouver' })).toBe('Vancouver');
  });

  it('rejects UTC/GMT pseudo-timezones and empty facts', () => {
    expect(placeNameFromFacts({ timezone: 'UTC' })).toBeNull();
    expect(placeNameFromFacts({ timezone: 'Etc/GMT+5' })).toBeNull();
    expect(placeNameFromFacts({})).toBeNull();
  });
});

describe('getWeatherForUser', () => {
  it('returns unavailable when the user has no location or timezone', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: {} });
    const result = await getWeatherForUser('u1');
    expect(result.available).toBe(false);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('geocodes the location fact and assembles the payload', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Vancouver, BC' } });
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { data: { results: [{ latitude: 49.25, longitude: -123.12, name: 'Vancouver', admin1: 'British Columbia', country: 'Canada' }] } };
      }
      return {
        data: {
          current: { temperature_2m: 15.9, apparent_temperature: 15.2, weather_code: 2, wind_speed_10m: 8.2, relative_humidity_2m: 82, is_day: 1 },
          daily: { temperature_2m_max: [21.0], temperature_2m_min: [11.2] },
        },
      };
    });

    const result = await getWeatherForUser('u1');
    expect(result.available).toBe(true);
    expect(result.location).toEqual({ name: 'Vancouver', region: 'British Columbia', country: 'Canada' });
    expect(result.current).toMatchObject({
      tempC: 16, tempF: 61, description: 'Partly cloudy', icon: '⛅', isDay: true, humidity: 82,
    });
    expect(result.today).toEqual({ maxC: 21, minC: 11, maxF: 70, minF: 52 });
    // Payload cached per user
    expect(mockedRedis.setEx).toHaveBeenCalledWith(expect.stringContaining('user:weather:u1'), expect.any(Number), expect.any(String));
    // CRITICAL: Open-Meteo's search only matches bare place names — the query
    // must be the CITY segment only, never the full "Vancouver, BC" string
    // (which returns zero results and would negative-cache for 7 days).
    // axios ≥1.20 types the mock call tuple's config as {} — cast for params access (OSV-1 bump, ticket 15e2de3d)
    const geoCall = mockedAxios.get.mock.calls.find(([url]) => String(url).includes('geocoding-api')) as any;
    expect(geoCall?.[1]?.params?.name).toBe('Vancouver');
  });

  it('disambiguates same-named cities using the region hint (abbreviations expanded)', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Vancouver, BC' } });
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { data: { results: [
          // Open-Meteo ranks by population/relevance — WA first here on purpose
          { latitude: 45.64, longitude: -122.66, name: 'Vancouver', admin1: 'Washington', country: 'United States' },
          { latitude: 49.25, longitude: -123.12, name: 'Vancouver', admin1: 'British Columbia', country: 'Canada' },
        ] } };
      }
      return {
        data: {
          current: { temperature_2m: 10, apparent_temperature: 9, weather_code: 0, wind_speed_10m: 5, relative_humidity_2m: 70, is_day: 1 },
          daily: { temperature_2m_max: [12], temperature_2m_min: [7] },
        },
      };
    });

    const result = await getWeatherForUser('u5');
    expect(result.available).toBe(true);
    // "BC" hint must expand to "british columbia" and beat the first-ranked WA hit
    expect(result.location).toEqual({ name: 'Vancouver', region: 'British Columbia', country: 'Canada' });
  });

  it('disambiguates a 3-part location where the region segment carries whitespace', async () => {
    // placeNameFromFacts trims "Vancouver, BC, Canada" → "Vancouver, BC" (2 segments),
    // then geocode() splits on comma. Without a trim on the region hint the segment
    // would be " BC" (leading space), missing the case-sensitive REGION_ABBREVIATIONS
    // key "bc" and falling back to the first (wrong) candidate. This locks in the trim.
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Vancouver, BC, Canada' } });
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { data: { results: [
          { latitude: 45.64, longitude: -122.66, name: 'Vancouver', admin1: 'Washington', country: 'United States' },
          { latitude: 49.25, longitude: -123.12, name: 'Vancouver', admin1: 'British Columbia', country: 'Canada' },
        ] } };
      }
      return {
        data: {
          current: { temperature_2m: 10, apparent_temperature: 9, weather_code: 0, wind_speed_10m: 5, relative_humidity_2m: 70, is_day: 1 },
          daily: { temperature_2m_max: [12], temperature_2m_min: [7] },
        },
      };
    });

    const result = await getWeatherForUser('u7');
    expect(result.available).toBe(true);
    expect(result.location?.region).toBe('British Columbia');
    // geocode query must still be the bare city, not "Vancouver, BC"
    // axios ≥1.20 types the mock call tuple's config as {} — cast for params access (OSV-1 bump, ticket 15e2de3d)
    const geoCall = mockedAxios.get.mock.calls.find(([url]) => String(url).includes('geocoding-api')) as any;
    expect(geoCall?.[1]?.params?.name).toBe('Vancouver');
  });

  it('falls back to the top-ranked candidate when the hint matches nothing', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Springfield, Oz' } });
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { data: { results: [
          { latitude: 39.8, longitude: -89.65, name: 'Springfield', admin1: 'Illinois', country: 'United States' },
          { latitude: 37.21, longitude: -93.29, name: 'Springfield', admin1: 'Missouri', country: 'United States' },
        ] } };
      }
      return {
        data: {
          current: { temperature_2m: 20, apparent_temperature: 20, weather_code: 1, wind_speed_10m: 3, relative_humidity_2m: 50, is_day: 0 },
          daily: { temperature_2m_max: [25], temperature_2m_min: [15] },
        },
      };
    });

    const result = await getWeatherForUser('u6');
    expect(result.available).toBe(true);
    expect(result.location?.region).toBe('Illinois');
    expect(result.current?.icon).toBe('🌙'); // is_day: 0 → night icon for "Mostly clear"
  });

  it('falls back to the parent segment when a small suburb returns no results', async () => {
    // "Oak Bay, Victoria, BC" → placeNameFromFacts trims to "Oak Bay, Victoria".
    // Open-Meteo has no entry for the suburb "Oak Bay", so the first query returns
    // nothing; geocode() must retry with the parent segment "Victoria" rather than
    // reporting the user as unavailable.
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Oak Bay, Victoria, BC' } });
    mockedAxios.get.mockImplementation(async (url: string, cfg?: any) => {
      if (String(url).includes('geocoding-api')) {
        if (cfg?.params?.name === 'Oak Bay') return { data: { results: [] } };
        if (cfg?.params?.name === 'Victoria') {
          return { data: { results: [{ latitude: 48.43, longitude: -123.37, name: 'Victoria', admin1: 'British Columbia', country: 'Canada' }] } };
        }
        return { data: { results: [] } };
      }
      return {
        data: {
          current: { temperature_2m: 12, apparent_temperature: 11, weather_code: 0, wind_speed_10m: 4, relative_humidity_2m: 75, is_day: 1 },
          daily: { temperature_2m_max: [14], temperature_2m_min: [8] },
        },
      };
    });

    const result = await getWeatherForUser('u8');
    expect(result.available).toBe(true);
    expect(result.location?.name).toBe('Victoria');
    // Both segments must have been attempted, in order.
    const geoNames = mockedAxios.get.mock.calls
      .filter(([url]) => String(url).includes('geocoding-api'))
      .map(([, cfg]) => (cfg as any)?.params?.name);
    expect(geoNames).toEqual(['Oak Bay', 'Victoria']);
  });

  it('returns unavailable (and caches the miss) when geocoding finds nothing', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Nowhereville Xyz' } });
    mockedAxios.get.mockResolvedValue({ data: { results: [] } });
    const result = await getWeatherForUser('u2');
    expect(result.available).toBe(false);
  });

  it('serves from the per-user cache without hitting APIs', async () => {
    const cached = { available: true, location: { name: 'Vancouver' } };
    mockedRedis.get.mockResolvedValue(JSON.stringify(cached));
    const result = await getWeatherForUser('u3');
    expect(result).toEqual(cached);
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(mockedPrisma.userMemory.findUnique).not.toHaveBeenCalled();
  });

  it('never throws on forecast failure — degrades to unavailable', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { location: 'Vancouver' } });
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return { data: { results: [{ latitude: 49.25, longitude: -123.12, name: 'Vancouver' }] } };
      }
      throw new Error('open-meteo down');
    });
    const result = await getWeatherForUser('u4');
    expect(result.available).toBe(false);
  });
});
