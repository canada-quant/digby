import { describe, expect, it } from 'vitest';
import { CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun, Cloud, CloudFog, CloudDrizzle } from 'lucide-react';
import { weatherIconFor } from './weather-icon';

describe('weatherIconFor', () => {
  it('maps the WMO groups (day / night aware for clear + partly cloudy)', () => {
    expect(weatherIconFor(0, true)).toBe(Sun);
    expect(weatherIconFor(0, false)).toBe(Moon);
    expect(weatherIconFor(2, true)).toBe(CloudSun);
    expect(weatherIconFor(1, false)).toBe(CloudMoon);
    expect(weatherIconFor(3)).toBe(Cloud);
    expect(weatherIconFor(45)).toBe(CloudFog);
    expect(weatherIconFor(53)).toBe(CloudDrizzle);
    expect(weatherIconFor(63)).toBe(CloudRain);
    expect(weatherIconFor(81)).toBe(CloudRain);
    expect(weatherIconFor(75)).toBe(CloudSnow);
    expect(weatherIconFor(96)).toBe(CloudLightning);
  });

  it('unknown / missing codes degrade to a neutral icon, never throw', () => {
    expect(weatherIconFor(undefined)).toBe(CloudSun);
    expect(weatherIconFor(12345)).toBe(Cloud);
  });
});
