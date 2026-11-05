#!/bin/bash
# CrossModel EC2 Setup Script - runs on the server
set -e

echo "=== Installing Docker ==="
apt-get update -y
apt-get install -y ca-certificates curl gnupg git

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "=== Docker installed ==="
docker --version
docker compose version

echo "=== Cloning CrossModel repo ==="
cd /home/ubuntu
git clone https://github.com/example-org/crossmodel.git
cd crossmodel

echo "=== Creating .env file ==="
cat > .env << 'ENVEOF'
JWT_SECRET=crossmodel-aws-prod-jwt-secret-minimum-32-characters-long-2026
JWT_REFRESH_SECRET=crossmodel-aws-prod-refresh-secret-minimum-32-characters-2026
OPENAI_API_KEY=
XAI_GROK_API_KEY=
GOOGLE_GEMINI_API_KEY=
MOONSHOT_API_KEY=
COHERE_API_KEY=
TOGETHER_API_KEY=
FIREWORKS_API_KEY=
MCP_DIGBY_TOKEN=
ENVEOF

echo "=== Starting CrossModel with Docker Compose ==="
docker compose -f docker-compose.prod.yml up -d --build

echo "=== Waiting for containers to start ==="
sleep 10
docker ps

echo "=== CrossModel deployed! ==="
echo "Frontend: http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):8247"
echo "Backend:  http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):4000"
