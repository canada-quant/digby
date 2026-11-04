import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

async function addActivities() {
  try {
    const users = await prisma.user.findMany({ take: 2 });
    const admin = users.find(u => u.role === 'ADMIN');
    const demo = users.find(u => u.role === 'USER');
    
    if (!admin || !demo) {
      console.error('❌ Users not found');
      process.exit(1);
    }

    console.log('📝 Found users:', admin.email, demo.email);

    const activities = [
      { userId: admin.id, action: 'login', resource: 'auth', metadata: { ip: '127.0.0.1' } },
      { userId: admin.id, action: 'create_user', resource: 'users', metadata: { targetUser: 'demo@example.com' } },
      { userId: demo.id, action: 'login', resource: 'auth', metadata: { ip: '127.0.0.1' } },
      { userId: demo.id, action: 'create_chat', resource: 'ai_chats', metadata: { title: 'First Chat' } },
      { userId: admin.id, action: 'update_user', resource: 'users', metadata: { field: 'role' } },
      { userId: demo.id, action: 'create_content', resource: 'content', metadata: { title: 'Welcome Post' } },
      { userId: admin.id, action: 'login', resource: 'auth', metadata: { ip: '127.0.0.1' } },
      { userId: demo.id, action: 'create_board', resource: 'kanban', metadata: { name: 'Project Board' } },
      { userId: admin.id, action: 'create_contact', resource: 'crm', metadata: { name: 'John Doe' } },
      { userId: demo.id, action: 'update', resource: 'users', metadata: { entity: 'profile' } },
    ];

    for (const activity of activities) {
      await prisma.activity.create({ data: activity });
    }
    
    console.log('✅ Created', activities.length, 'activities');
    
    // Verify
    const count = await prisma.activity.count();
    console.log('📊 Total activities in database:', count);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

addActivities();