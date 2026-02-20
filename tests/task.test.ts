import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app';
import { sqlite, db } from '../src/db';
import { tasks, taskEvents, idempotencyKeys } from '../src/db/schema';
import { v4 as uuidv4 } from 'uuid';

describe('Task Workflow API', () => {
    const workspaceId = 'ws_1';
    const tenantId = 'tenant_1';

    beforeAll(() => {
        // Create all tables using raw SQL (no migration files needed)
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                title TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT 'MEDIUM',
                state TEXT NOT NULL DEFAULT 'NEW',
                assignee_id TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS task_events (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id),
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS idempotency_keys (
                key TEXT PRIMARY KEY,
                response_payload TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_workspace_state ON tasks(workspace_id, state);
            CREATE INDEX IF NOT EXISTS idx_tasks_workspace_assignee ON tasks(workspace_id, assignee_id);
            CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id);
            CREATE INDEX IF NOT EXISTS idx_events_created_at ON task_events(created_at);
        `);
    });

    beforeEach(async () => {
        // Clean DB between tests to prevent leakage
        await db.delete(taskEvents);
        await db.delete(idempotencyKeys);
        await db.delete(tasks);
    });

    afterAll(() => {
        sqlite.close();
    });

    // Requirement 1: Idempotent create
    it('should create a task successfully', async () => {
        const res = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Test Task', priority: 'HIGH' });

        expect(res.status).toBe(201);
        expect(res.body.state).toBe('NEW');
        expect(res.body.version).toBe(1);
    });

    it('should be idempotent on create', async () => {
        const key = uuidv4();
        const payload = { title: 'Idempotent Task' };

        const res1 = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('Idempotency-Key', key)
            .send(payload);

        expect(res1.status).toBe(201);

        const res2 = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('Idempotency-Key', key)
            .send(payload);

        expect(res2.status).toBe(201);
        expect(res2.body.task_id).toBe(res1.body.task_id);
    });

    // Requirement 2: Invalid transition returns 409
    it('should prevent invalid transitions (NEW -> DONE)', async () => {
        const createRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Transition Test' });

        const taskId = createRes.body.task_id;
        const version = createRes.body.version;

        // Try NEW -> DONE (invalid: not an allowed transition)
        const res = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/transition`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('If-Match-Version', version)
            .send({ to_state: 'DONE' });

        expect(res.status).toBe(409);
    });

    // Requirement 3: Agent cannot complete unassigned task
    it('should prevent agent from completing unassigned task', async () => {
        const createRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Agent Test' });

        const taskId = createRes.body.task_id;
        const version = createRes.body.version;

        // Agent tries to move NEW -> IN_PROGRESS but is not assigned
        const res = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/transition`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'agent')
            .set('X-User-Id', 'agent_1')
            .set('If-Match-Version', version)
            .send({ to_state: 'IN_PROGRESS' });

        expect(res.status).toBe(409);
    });

    // Requirement 4: Optimistic locking version conflict
    it('should handle optimistic locking version conflict', async () => {
        const createRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Concurrency Test' });

        const taskId = createRes.body.task_id;
        const version = createRes.body.version;

        // Request 1: Assign succeeds, bumps version to 2
        await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/assign`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('If-Match-Version', version)
            .send({ assignee_id: 'u_1' });

        // Request 2: Assign with stale (old) version -> 409 Conflict
        const res2 = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/assign`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('If-Match-Version', version)
            .send({ assignee_id: 'u_2' });

        expect(res2.status).toBe(409);
    });

    // Requirement 5: Outbox event created on transition
    it('should create outbox events on task creation', async () => {
        const createRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Outbox Test' });

        expect(createRes.status).toBe(201);

        const eventsRes = await request(app).get('/v1/events');
        expect(eventsRes.status).toBe(200);

        const events = eventsRes.body;
        const createdEvent = events.find(
            (e: any) => e.task_id === createRes.body.task_id && e.event_type === 'TaskCreated'
        );
        expect(createdEvent).toBeDefined();
    });

    // Additional: Manager can cancel a task
    it('should allow manager to cancel task', async () => {
        const createRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Cancel Test' });

        const taskId = createRes.body.task_id;
        const version = createRes.body.version;

        const res = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/transition`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('If-Match-Version', version)
            .send({ to_state: 'CANCELLED' });

        expect(res.status).toBe(200);
        expect(res.body.state).toBe('CANCELLED');
    });

    // Additional: Assign and transition by agent
    it('should allow assigned agent to transition task', async () => {
        const createRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .send({ title: 'Agent Transition Test' });

        const taskId = createRes.body.task_id;
        let version = createRes.body.version;

        // Manager assigns task to agent_1
        const assignRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/assign`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'manager')
            .set('If-Match-Version', version)
            .send({ assignee_id: 'agent_1' });

        expect(assignRes.status).toBe(200);
        version = assignRes.body.version;

        // Agent moves NEW -> IN_PROGRESS
        const transitionRes = await request(app)
            .post(`/v1/workspaces/${workspaceId}/tasks/${taskId}/transition`)
            .set('X-Tenant-Id', tenantId)
            .set('X-Role', 'agent')
            .set('X-User-Id', 'agent_1')
            .set('If-Match-Version', version)
            .send({ to_state: 'IN_PROGRESS' });

        expect(transitionRes.status).toBe(200);
        expect(transitionRes.body.state).toBe('IN_PROGRESS');
    });
});
