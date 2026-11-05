#!/bin/bash

# Deployment script for admin-dashboard on example-local-host
# This script pulls latest code, builds, and deploys the application

set -e  # Exit on error

echo "🚀 Starting deployment to example-local-host..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "docker-compose.prod.yml" ]; then
    print_error "docker-compose.prod.yml not found. Are you in the project root?"
    exit 1
fi

# Pull latest code from GitHub
print_status "Pulling latest code from GitHub..."
git pull origin main || {
    print_error "Failed to pull from GitHub"
    exit 1
}
print_success "Code updated"

# Stop existing containers
print_status "Stopping existing containers..."
docker compose -f docker-compose.prod.yml down || true
print_success "Containers stopped"

# Build new images
print_status "Building Docker images..."
docker compose -f docker-compose.prod.yml build
print_success "Images built"

# Start services
print_status "Starting services..."
docker compose -f docker-compose.prod.yml up -d
print_success "Services started"

# Wait for database to be ready
print_status "Waiting for database to be ready..."
sleep 15

# Run database migrations
print_status "Running database migrations..."
docker compose -f docker-compose.prod.yml exec -T backend npx prisma migrate deploy || {
    print_error "Migration failed"
    exit 1
}
print_success "Migrations completed"

# Seed database (only if needed)
print_status "Seeding database with demo data..."
docker compose -f docker-compose.prod.yml exec -T backend npm run seed || {
    print_error "Seeding failed (this is OK if data already exists)"
}
print_success "Database ready"

# Show running services
print_status "Checking service status..."
docker compose -f docker-compose.prod.yml ps

echo ""
print_success "Deployment complete!"
echo ""
echo "🌐 Access your application:"
echo "   Frontend:  http://example-local-host:8247"
echo "   Backend:   http://example-local-host:4000"
echo "   Adminer:   http://example-local-host:9521"
echo ""
echo "📊 View logs:"
echo "   docker compose -f docker-compose.prod.yml logs -f"
echo ""
echo "🔑 Default credentials:"
echo "   Email:    admin@example.com"
echo "   Password: Admin@123"
