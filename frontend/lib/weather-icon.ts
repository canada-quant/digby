/**
 * WMO weather code → lucide icon (Digby Frontier home meta line, 2026-10-06).
 *
 * The weather endpoint (Open-Meteo WMO codes) also ships an emoji `icon`; the
 * redesigned home renders a stroke icon instead so the meta line reads as one
 * typographic row. Pure — exported for the node vitest.
 */
import {
  Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun,
  type LucideIcon,
} from 'lucide-react';

export function weatherIconFor(code: number | null | undefined, isDay = true): LucideIcon {
  if (code == null || !Number.isFinite(code)) return isDay ? CloudSun : CloudMoon;
  if (code === 0) return isDay ? Sun : Moon;
  if (code === 1 || code === 2) return isDay ? CloudSun : CloudMoon;
  if (code === 3) return Cloud;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 57) return CloudDrizzle;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return CloudRain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return CloudSnow;
  if (code >= 95 && code <= 99) return CloudLightning;
  return Cloud;
}
