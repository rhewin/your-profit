import { db } from '../db';
import { tasks, taskEvents, idempotencyKeys } from '../db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { Task, TaskDomain, TaskState, UserRole } from '../domain/task';
import { v4 as uuidv4 } from 'uuid';

export class TaskRepository {

  async create(task: Omit<Task, 'createdAt' | 'updatedAt' | 'version' | 'id'> & { id: string }, idempotencyKey?: string) {
    return db.transaction((tx) => {
      // 1. Idempotency Check
      if (idempotencyKey) {
        const existing = tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, idempotencyKey)).get();
        if (existing) {
          return existing.responsePayload;
        }
      }

      // 2. Insert Task
      const newTask = {
        ...task,
        version: 1,
      };

      tx.insert(tasks).values(newTask).run();

      // 3. Outbox Event
      tx.insert(taskEvents).values({
        id: uuidv4(),
        taskId: task.id,
        eventType: 'TaskCreated',
        payload: newTask,
      }).run();

      const result = { task_id: task.id, state: task.state, version: 1 };

      // 4. Save Idempotency Key
      if (idempotencyKey) {
        tx.insert(idempotencyKeys).values({
          key: idempotencyKey,
          responsePayload: result,
        }).run();
      }

      return result;
    });
  }

  async assign(taskId: string, assigneeId: string, currentVersion: number) {
    return db.transaction((tx) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) throw new Error('TaskNotFound');

      if (task.version !== currentVersion) throw new Error('VersionMismatch');

      if (task.state === 'DONE' || task.state === 'CANCELLED') {
        throw new Error('InvalidState');
      }

      // Update
      const nextVersion = currentVersion + 1;
      tx.update(tasks)
        .set({
          assigneeId,
          version: nextVersion,
          updatedAt: Math.floor(Date.now() / 1000)
        })
        .where(and(eq(tasks.id, taskId), eq(tasks.version, currentVersion)))
        .run();

      // Outbox
      tx.insert(taskEvents).values({
        id: uuidv4(),
        taskId,
        eventType: 'TaskAssigned',
        payload: { assigneeId },
      }).run();

      return { task_id: taskId, state: task.state, version: nextVersion };
    });
  }

  async transition(taskId: string, toState: TaskState, currentVersion: number) {
    return db.transaction((tx) => {
        const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
        if (!task) throw new Error('TaskNotFound');

        if (task.version !== currentVersion) throw new Error('VersionMismatch');

        const nextVersion = currentVersion + 1;
        tx.update(tasks)
          .set({
            state: toState,
            version: nextVersion,
            updatedAt: Math.floor(Date.now() / 1000)
          })
          .where(and(eq(tasks.id, taskId), eq(tasks.version, currentVersion)))
          .run();

        // Outbox
        tx.insert(taskEvents).values({
          id: uuidv4(),
          taskId,
          eventType: 'TaskStateChanged',
          payload: { from: task.state, to: toState },
        }).run();

        return { task_id: taskId, state: toState, version: nextVersion };
      });
  }

  async findById(taskId: string, tenantId: string) {
    const task = await db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)))
      .get();

    if (!task) return null;

    const events = await db.select().from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(sql`${taskEvents.createdAt} DESC`)
      .limit(20)
      .all();

    return { ...task, timeline: events };
  }

  async list(workspaceId: string, tenantId: string, filters: { state?: string, assigneeId?: string, limit?: number, cursor?: string }) {
    const conditions = [
      eq(tasks.workspaceId, workspaceId),
      eq(tasks.tenantId, tenantId)
    ];

    if (filters.state) {
      conditions.push(eq(tasks.state, filters.state as any));
    }
    if (filters.assigneeId) {
      conditions.push(eq(tasks.assigneeId, filters.assigneeId));
    }

    // Cursor-based pagination (using createdAt as cursor - assuming Unix seconds)
    if (filters.cursor) {
      const cursorTimestamp = parseInt(filters.cursor);
      if (!isNaN(cursorTimestamp)) {
        conditions.push(sql`${tasks.createdAt} < ${cursorTimestamp}`);
      }
    }

    const limit = filters.limit || 20;

    return await db.select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(sql`${tasks.createdAt} DESC`)
      .limit(limit)
      .all();
  }
}
