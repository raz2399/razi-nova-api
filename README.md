# Razi-Nova API

Backend for Razi-Nova shift management system.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | / | Health check |
| POST | /api/shift/save | Save clerk shift progress |
| GET | /api/shift/load | Load clerk shift (crash recovery) |
| GET | /api/shifts/today | All shifts today (manager dashboard) |
| POST | /api/shift/event | Log a shift event |
| DELETE | /api/shift/clear | Mark shift complete |
| GET | /api/shifts/history | Historical shift records |

## Deploy to Railway

1. Connect this repo to Railway
2. Add PostgreSQL database
3. Set DATABASE_URL environment variable (Railway does this automatically)
4. Deploy
