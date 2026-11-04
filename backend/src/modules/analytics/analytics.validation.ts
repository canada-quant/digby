import { z } from 'zod';

// Date range query schema
export const dateRangeSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  days: z.string().transform(Number).optional().default(30),
});

// Track event schema
export const trackEventSchema = z.object({
  event: z.string().min(1, 'Event name is required'),
  properties: z.record(z.string(), z.any()).optional(),
});

export type DateRangeQuery = z.infer<typeof dateRangeSchema>;
export type TrackEventInput = z.infer<typeof trackEventSchema>;
