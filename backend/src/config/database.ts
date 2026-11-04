import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env';

// Prisma 7: the client connects through a driver adapter (no url in the
// schema — migrate/CLI config lives in prisma.config.ts).
// node-pg does NOT enable TLS from the URL the way Prisma 6's Rust engine
// did — RDS rejects plaintext ("no pg_hba.conf entry … no encryption",
// deploy 32632301857). sslmode=disable stays plaintext (local dev); with no
// sslmode in the URL we force encrypt-without-chain-verify (≈ sslmode=require,
// the old engine's effective behavior). INVARIANT: the URL must not carry
// sslmode=require/prefer — pg lets URL params OVERRIDE this explicit object,
// which would silently re-enable chain verification and fail against RDS.
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  ssl: /sslmode=disable/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});
