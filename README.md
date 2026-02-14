# Work Along - Backend Server

Express.js backend server with PostgreSQL authentication.

## Setup

1. Make sure PostgreSQL is running:
```bash
brew services start postgresql@16
```

2. Verify database setup:
```bash
psql -U workalong -d users
```

3. Install dependencies (if not already done):
```bash
npm install
```

## Running the Server

Start the server:
```bash
npm start
```

Or with auto-reload during development:
```bash
npm run dev
```

The server will run on **http://localhost:3001**

## API Endpoints

### Authentication

- **POST** `/api/auth/signup` - Create new account
  ```json
  {
    "email": "user@example.com",
    "password": "password123",
    "name": "John Doe",
    "company": "Optional Company"
  }
  ```

- **POST** `/api/auth/signin` - Sign in
  ```json
  {
    "email": "user@example.com",
    "password": "password123"
  }
  ```

- **GET** `/api/auth/me` - Get current user (requires Authorization header)
  ```
  Authorization: Bearer <session-id>
  ```

- **POST** `/api/auth/signout` - Sign out (requires Authorization header)

### Health Check

- **GET** `/api/health` - Check server status

## Database Schema

### Users Table
```sql
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Sessions Table
```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT
);
```

## Configuration

Edit `config.js` to change settings:
- Port: Default 3001
- Database credentials
- Session settings

## Security Features

- ✅ Password hashing with bcrypt (10 rounds)
- ✅ Session-based authentication
- ✅ Session expiration (7 days)
- ✅ Automatic cleanup of expired sessions
- ✅ CORS enabled for localhost:3000
- ✅ SQL injection protection (parameterized queries)

## Troubleshooting

### Database connection errors
- Make sure PostgreSQL is running
- Verify credentials in `config.js`
- Check database exists: `psql -l`

### Port already in use
- Change port in `config.js`
- Or kill the process using port 3001:
  ```bash
  lsof -ti:3001 | xargs kill
  ```

# workalong-be
