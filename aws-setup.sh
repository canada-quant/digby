#!/bin/bash
set -e

PROFILE="crossmodel-prod"
VPC_ID="vpc-8da913e8"
EC2_SG="sg-0123456789abcdef0"

echo "=== Step 1: Add ingress rules to EC2 security group ==="

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG \
  --profile $PROFILE \
  --protocol tcp --port 22 --cidr 0.0.0.0/0 2>&1 || true

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG \
  --profile $PROFILE \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 2>&1 || true

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG \
  --profile $PROFILE \
  --protocol tcp --port 443 --cidr 0.0.0.0/0 2>&1 || true

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG \
  --profile $PROFILE \
  --protocol tcp --port 4000 --cidr 0.0.0.0/0 2>&1 || true

aws ec2 authorize-security-group-ingress \
  --group-id $EC2_SG \
  --profile $PROFILE \
  --protocol tcp --port 3000 --cidr 0.0.0.0/0 2>&1 || true

echo "EC2 SG ingress rules added ✅"

echo "=== Step 2: Create RDS security group ==="

RDS_SG=$(aws ec2 create-security-group \
  --group-name crossmodel-rds-sg \
  --description "CrossModel RDS PostgreSQL from EC2 only" \
  --vpc-id $VPC_ID \
  --profile $PROFILE \
  --query 'GroupId' --output text 2>&1)

echo "RDS SG: $RDS_SG"

aws ec2 authorize-security-group-ingress \
  --group-id $RDS_SG \
  --profile $PROFILE \
  --protocol tcp \
  --port 5432 \
  --source-group $EC2_SG 2>&1

echo "RDS SG ingress rule added ✅"

echo "=== Step 3: Create RDS subnet group ==="

aws rds create-db-subnet-group \
  --db-subnet-group-name crossmodel-subnet-group \
  --db-subnet-group-description "CrossModel RDS subnet group" \
  --subnet-ids subnet-e935a8e5 subnet-c4857f9d subnet-a323fbd4 \
  --profile $PROFILE 2>&1 || true

echo "RDS subnet group created ✅"

echo "=== Step 4: Launch RDS PostgreSQL 16 ==="

aws rds create-db-instance \
  --db-instance-identifier crossmodel-postgres \
  --db-instance-class db.t3.medium \
  --engine postgres \
  --engine-version 16.6 \
  --master-username admin \
  --master-user-password "change-me-in-local-env" \
  --db-name crossmodel_db \
  --allocated-storage 20 \
  --storage-type gp3 \
  --vpc-security-group-ids $RDS_SG \
  --db-subnet-group-name crossmodel-subnet-group \
  --no-multi-az \
  --no-publicly-accessible \
  --backup-retention-period 7 \
  --profile $PROFILE 2>&1

echo "RDS instance launching... (takes ~5 mins) ✅"

echo "=== Step 5: Launch EC2 t3.large ==="

AMI_ID=$(aws ec2 describe-images \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text \
  --profile $PROFILE)

echo "Latest Ubuntu 22.04 AMI: $AMI_ID"

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type t3.large \
  --key-name crossmodel-prod \
  --security-group-ids $EC2_SG \
  --subnet-id subnet-a1c9d389 \
  --associate-public-ip-address \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=crossmodel-prod}]' \
  --profile $PROFILE \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "EC2 Instance launched: $INSTANCE_ID ✅"

echo "=== Waiting for EC2 to get public IP ==="
sleep 10

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --profile $PROFILE \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo ""
echo "=========================================="
echo "INFRASTRUCTURE DEPLOYED ✅"
echo "=========================================="
echo "EC2 Instance ID : $INSTANCE_ID"
echo "EC2 Public IP   : $PUBLIC_IP"
echo "RDS SG          : $RDS_SG"
echo "SSH command     : ssh -i /Users/example/.ssh/crossmodel-prod.pem ubuntu@$PUBLIC_IP"
echo "=========================================="
echo "RDS is still provisioning (~5 mins)"
echo "Run this to get RDS endpoint when ready:"
echo "aws rds describe-db-instances --db-instance-identifier crossmodel-postgres --profile crossmodel-prod --query 'DBInstances[0].Endpoint.Address' --output text"
