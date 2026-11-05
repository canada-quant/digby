#!/bin/bash

# Server setup script for example-local-host
# This script sets up the server environment for the first time

set -e  # Exit on error

echo "🔧 Setting up example-local-host server..."

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}==>${NC} $1"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if Docker is installed
print_status "Checking Docker installation..."
if ! command -v docker &> /dev/null; then
    print_error "Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    print_success "Docker installed"
else
    print_success "Docker is already installed"
fi

# Check if Docker Compose is installed
print_status "Checking Docker Compose installation..."
if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose not found. Installing..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    print_success "Docker Compose installed"
else
    print_success "Docker Compose is already installed"
fi

# Check if Git is installed
print_status "Checking Git installation..."
if ! command -v git &> /dev/null; then
    print_error "Git not found. Installing..."
    sudo apt-get update
    sudo apt-get install -y git
    print_success "Git installed"
else
    print_success "Git is already installed"
fi

# Create project directory
print_status "Creating project directory..."
mkdir -p ~/admin-dashboard
cd ~/admin-dashboard
print_success "Project directory created"

# Check if repository exists
if [ -d ".git" ]; then
    print_status "Repository already exists, pulling latest..."
    git pull origin main
else
    print_status "Cloning repository from GitHub..."
    # Remove directory if it exists but isn't a git repo
    cd ..
    rm -rf admin-dashboard
    git clone https://github.com/example-org/admin-dashboard.git
    cd admin-dashboard
fi
print_success "Repository ready"

# Generate JWT secrets
print_status "Generating secure JWT secrets..."
JWT_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)

# Create .env file for production
print_status "Creating production environment file..."
cat > .env.prod << EOF
# Generated on $(date)
JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET
EOF
print_success "Environment file created"

# Make deploy script executable
chmod +x deploy.sh

echo ""
print_success "Server setup complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Run: ./deploy.sh"
echo "   2. Access: http://example-local-host:8247"
echo ""
echo "🔐 JWT secrets have been generated and saved to .env.prod"
