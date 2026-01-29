# Multi-stage Dockerfile for Moji Proctor Server

FROM node:20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy source and build
COPY src ./src
RUN npm run build
RUN npx prisma generate

# Production stage
FROM node:20-alpine AS runtime

WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache openssl

# Copy built files and prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S moji -u 1001
RUN chown -R moji:nodejs /app
USER moji

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {if(r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start server
CMD ["node", "dist/index.js"]
