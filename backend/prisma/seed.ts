import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const hashedPassword = await bcrypt.hash('Admin@123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      password: hashedPassword,
      firstName: 'Admin',
      lastName: 'User',
      role: 'ADMIN',
      accounts: {
        create: {
          type: 'local',
          provider: 'email',
        },
      },
    },
  });

  console.log('✅ Admin user created:', admin.email);

  // Create demo user
  const demoPassword = await bcrypt.hash('Demo@123', 10);

  const demo = await prisma.user.upsert({
    where: { email: 'demo@example.com' },
    update: {},
    create: {
      email: 'demo@example.com',
      password: demoPassword,
      firstName: 'Demo',
      lastName: 'User',
      role: 'USER',
      accounts: {
        create: {
          type: 'local',
          provider: 'email',
        },
      },
    },
  });

  console.log('✅ Demo user created:', demo.email);

  // Create sample activities
  const activities = [
    { userId: admin.id, action: 'login', resource: 'auth', metadata: { ip: '127.0.0.1' } },
    { userId: admin.id, action: 'create_user', resource: 'users', metadata: { targetUser: 'demo@example.com' } },
    { userId: demo.id, action: 'login', resource: 'auth', metadata: { ip: '127.0.0.1' } },
    { userId: demo.id, action: 'create_chat', resource: 'ai_chats', metadata: { title: 'First Chat' } },
    { userId: admin.id, action: 'update_user', resource: 'users', metadata: { field: 'role', userId: demo.id } },
    { userId: demo.id, action: 'create_content', resource: 'content', metadata: { title: 'Welcome Post' } },
    { userId: admin.id, action: 'login', resource: 'auth', metadata: { ip: '127.0.0.1' } },
    { userId: demo.id, action: 'create_board', resource: 'kanban', metadata: { name: 'Project Board' } },
    { userId: admin.id, action: 'create_contact', resource: 'crm', metadata: { name: 'John Doe' } },
    { userId: demo.id, action: 'update', resource: 'users', metadata: { entity: 'profile' } },
  ];

  for (const activity of activities) {
    await prisma.activity.create({
      data: activity,
    });
  }

  console.log(`✅ Created ${activities.length} sample activities`);
  console.log('✅ Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });