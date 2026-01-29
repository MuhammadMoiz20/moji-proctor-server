# Moji Proctor Server

Online Signals server for Moji Proctor. Receives and stores integrity signals from VS Code extensions.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your GitHub OAuth credentials

# Start database and server
docker-compose up -d
```

The server will be available at `http://localhost:3000`.

## API Endpoints

### Health
- `GET /health` - Health check

### Authentication
- `POST /api/auth/device/start` - Start GitHub OAuth Device Flow
- `POST /api/auth/device/complete` - Poll for authorization completion
- `POST /api/auth/refresh` - Refresh access token

### Events
- `POST /api/events/batch` - Upload batch of signals (requires auth)

### Instructor Dashboard
- `GET /api/instructor/assignments` - List all assignments
- `GET /api/instructor/assignments/:id/students` - List students for assignment
- `GET /api/instructor/assignments/:id/students/:studentId/timeline` - Get student timeline
- `GET /api/instructor/assignments/:id/summary` - Get assignment summary

## Schema

See `prisma/schema.prisma` for the database schema.

## Development

```bash
# Run with hot reload
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Run tests
npm test

# Run migrations
npx prisma migrate dev

# Reset database
npx prisma migrate reset
```

## Production Deployment

1. Set strong `JWT_SECRET` and `DATABASE_URL` in environment
2. Configure proper `CORS_ORIGIN` (don't use `*`)
3. Set up GitHub OAuth app
4. Deploy with Docker:
   ```bash
   docker build -t moji-proctor-server .
   docker run -p 3000:3000 --env-file .env moji-proctor-server
   ```
