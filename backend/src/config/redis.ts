import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { env } from './env';
import logger from '../utils/logger';

const redisClient: RedisClientType = createClient({
  url: env.REDIS_URL,
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  logger.info('✅ Redis connected');
});

// Connect to Redis
export const connectRedis = async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};

// Graceful shutdown
process.on('beforeExit', async () => {
  await redisClient.quit();
});

export default redisClient;
