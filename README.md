# Task Workflow API

A robust **Task Workflow Service** built with Node.js and SQLite, demonstrating Clean Architecture, Idempotency, and the Outbox Pattern.

## Features

- **Clean Architecture**: Separation of concerns using layers and modules.
- **Idempotency**: Safe API operations with idempotency keys.
- **Concurrency Control**: Optimistic locking using versioning.
- **Outbox Pattern**: Reliable event publishing within database transactions.
- **Audit Trail**: Full history of task creation, assignment, and state changes.

## Technology Stack

- **Runtime**: Node.js (TypeScript)
- **Framework**: Express.js
- **Database**: SQLite (via `better-sqlite3`)
- **ORM**: Drizzle
- **Testing**: Vitest
