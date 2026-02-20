# Task Workflow API

A specialized backend service for managing task lifecycles with strict role-based transitions, isolation, and concurrency control.

## Tech Stack
- **Runtime**: Node.js
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: SQLite (via better-sqlite3)
- **ORM**: Drizzle ORM
- **Validation**: Zod
- **Testing**: Vitest + Supertest

## Getting Started

### Prerequisites
- Node.js (v18+)
- npm

### Installation
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Application
To start the development server:
```bash
npm run dev
```
The API will be available at `http://localhost:3000/v1`.

### Health Check (Verification)
To verify the server is running correctly:
```bash
curl http://localhost:3000/v1/health
```

## API Features

### Core Requirements
- **Tenant Isolation**: All requests must include the `X-Tenant-Id` header.
- **Implicit Workspaces**: Workspaces are not separate entities. A workspace is created implicitly when the first task is associated with its ID (e.g., `ws_1`).
- **Role-Based Access**: Role is specified via `X-Role` header (`agent` or `manager`).
- **Concurrency Control**: Updates require the `If-Match-Version` header to prevent lost updates (Optimistic Locking).
- **Idempotency**: Task creation respects the `Idempotency-Key` header.
- **Outbox Pattern**: All state changes generate events stored in the database for reliable processing.

### Key Endpoints & Examples

#### 1. Create a Task
```bash
curl -X POST http://localhost:3000/v1/workspaces/ws_1/tasks \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: my_tenant" \
  -H "X-Role: manager" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title": "Implement authentication", "priority": "HIGH"}'
```

#### 2. Assign a Task
```bash
curl -X POST http://localhost:3000/v1/workspaces/ws_1/tasks/:taskId/assign \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: my_tenant" \
  -H "X-Role: manager" \
  -H "If-Match-Version: 1" \
  -d '{"assignee_id": "user_123"}'
```

#### 3. Transition Task State
```bash
curl -X POST http://localhost:3000/v1/workspaces/ws_1/tasks/:taskId/transition \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Id: my_tenant" \
  -H "X-Role: agent" \
  -H "X-User-Id: user_123" \
  -H "If-Match-Version: 2" \
  -d '{"to_state": "IN_PROGRESS"}'
```

#### 4. Get Task Details
```bash
curl -X GET http://localhost:3000/v1/workspaces/ws_1/tasks/:taskId \
  -H "X-Tenant-Id: my_tenant"
```

#### 5. List Tasks (with Filters)
```bash
curl -X GET "http://localhost:3000/v1/workspaces/ws_1/tasks?state=NEW&limit=10" \
  -H "X-Tenant-Id: my_tenant"
```

#### 6. List Outbox Events
```bash
curl -X GET "http://localhost:3000/v1/events?limit=50"
```

## Technical Implementation

### State Machine & Authorization
The system enforces strict state transitions and role-based access in the Domain layer (`src/domain/task.ts`):
- **Transitions**: Defined valid paths (e.g., `NEW` → `IN_PROGRESS` → `DONE`).
- **Roles**: 
    - `manager`: Can only `CANCEL` tasks.
    - `agent`: Can transition tasks they are specifically assigned to.

### Idempotency & Concurrency
Reliability is ensured at the Repository level (`src/repositories/taskRepository.ts`):
- **Idempotency**: Task creation uses a unique `Idempotency-Key`. The server stores the first response and returns it for subsequent requests with the same key.
- **Optimistic Locking**: All updates require the `If-Match-Version` header. The database checks if the record's version matches the provided version before applying changes, preventing "lost updates" in concurrent environments.

### Outbox Pattern
To ensure consistency between the database state and external event systems:
- All state changes (Creation, Assignment, Transitions) are performed within a single database transaction.
- Each transaction writes both the state change *and* a corresponding event record to the `task_events` table (the "Outbox"). 

## Project Structure
- `src/domain`: Core business logic and state machine rules.
- `src/repositories`: Data access layer with transaction management.
- `src/controllers`: API request handling and response normalization.
- `src/db`: Database schema and connection setup.
- `tests`: Comprehensive integration tests covering business rules.
