#!/bin/bash
# CrossModel: Migrate from Docker PostgreSQL to AWS RDS
# Run this after RDS endpoint is available
set -e

EC2_IP="203.0.113.22"
SSH_KEY="/Users/example/.ssh/crossmodel-prod.pem"
RDS_ENDPOINT="$1"  # Pass RDS endpoint as first argument
RDS_USER="crossmodel_admin"
RDS_PASSWORD="change-me-in-local-env"
RDS_DB="crossmodel_db"

if [ -z "$RDS_ENDPOINT" ]; then
  echo "Usage: $0 <rds-endpoint>"
  echo "Example: $0 crossmodel-postgres.xxxx.us-east-1.rds.amazonaws.com"
  exit 1
fi

echo "=== Step 1: Dump Docker PostgreSQL data ==="
ssh -i $SSH_KEY -o StrictHostKeyChecking=no ubuntu@$EC2_IP \
  "docker exec admin-postgres-prod pg_dump -U admin -d admin_db --no-owner --no-acl -F c -f /tmp/crossmodel-backup.dump"
echo "Dump complete ✅"

echo "=== Step 2: Copy dump to EC2 /opt ==="
ssh -i $SSH_KEY -o StrictHostKeyChecking=no ubuntu@$EC2_IP \
  "cp /tmp/crossmodel-backup.dump /opt/crossmodel-backup.dump"

echo "=== Step 3: Install pgvector on RDS ==="
ssh -i $SSH_KEY -o StrictHostKeyChecking=no ubuntu@$EC2_IP \
  "docker exec admin-postgres-prod psql -h $RDS_ENDPOINT -U $RDS_USER -d $RDS_DB -c 'CREATE EXTENSION IF NOT EXISTS vector;' 2>/dev/null || true"

echo "=== Step 4: Run Prisma migrations on RDS ==="
ssh -i $SSH_KEY -o StrictHostKeyChecking=no ubuntu@$EC2_IP \
  "docker exec -e DATABASE_URL=postgresql://$RDS_USER:$RDS_PASSWORD@$RDS_ENDPOINT:5432/$RDS_DB admin-backend-prod npx prisma migrate deploy"
echo "Migrations applied ✅"

echo "=== Step 5: Restore data to RDS ==="
ssh -i $SSH_KEY -o StrictHostKeyChecking=no ubuntu@$EC2_IP \
  "docker exec admin-postgres-prod pg_restore -h $RDS_ENDPOINT -U $RDS_USER -d $RDS_DB --no-owner --no-acl -F c /tmp/crossmodel-backup.dump 2>/dev/null || true"
echo "Data restored ✅"

echo "=== Step 6: Update backend DATABASE_URL and restart ==="
ssh -i $SSH_KEY -o StrictHostKeyChecking=no ubuntu@$EC2_IP "
cd /opt/crossmodel
# Update .env with RDS URL
sed -i '/DATABASE_URL/d' .env 2>/dev/null || true
echo 'DATABASE_URL=postgresql://$RDS_USER:$RDS_PASSWORD@$RDS_ENDPOINT:5432/$RDS_DB' >> .env
# Update docker-compose to use RDS (remove postgres container, update DATABASE_URL)
docker compose -f docker-compose.prod.yml stop backend
docker compose -f docker-compose.prod.yml rm -f backend  
docker compose -f docker-compose.prod.yml up -d backend
"
echo "Backend restarted with RDS ✅"

echo ""
echo "=== Migration Complete! ==="
echo "RDS Endpoint: $RDS_ENDPOINT"
echo "Test: curl -s http://$EC2_IP:4000/api/auth/login -X POST -H 'Content-Type: application/json' -d '{\"email\":\"admin@example.com\",\"password\":\"Admin@123\"}'"
