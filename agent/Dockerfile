# Build context must be the REPOSITORY ROOT so shared/ is reachable:
#   docker build -f agent/Dockerfile -t docker-harbor-agent:latest .
FROM node:20-alpine

WORKDIR /app

# Dependencies are installed at /app, not /app/agent, so that the shared/
# modules can resolve them too (Node walks up from /app/shared to /app).
COPY agent/package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

COPY shared/ ./shared/
COPY agent/ ./agent/

ENV NODE_ENV=production
# Agenten lyssnar aldrig på någon port -- all kommunikation är utgående.
CMD ["node", "agent/index.js"]
