#!/bin/sh
cd /home/paul/crossmodel
git config user.email "example-user@example.com"
git config user.name "Digby Autopilot"
git add -A
git commit -m "fix: adding membersd to project"
git push origin main
