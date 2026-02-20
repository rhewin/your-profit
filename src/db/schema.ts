import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// --- Tasks Table ---
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(), // UUID
  tenantId: text('tenant_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  title: text('title').notNull(), // Max 120 chars check in app logic
  priority: text('priority', { enum: ['LOW', 'MEDIUM', 'HIGH'] }).default('MEDIUM').notNull(),
  state: text('state', { enum: ['NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED'] }).default('NEW').notNull(),
  assigneeId: text('assignee_id'), // Nullable
  version: integer('version').default(1).notNull(), // Optimistic locking
  createdAt: integer('created_at').default(sql`(unixepoch())`).notNull(),
  updatedAt: integer('updated_at').default(sql`(unixepoch())`).notNull(),
}, (table) => ({
  workspaceStateIdx: index('idx_tasks_workspace_state').on(table.workspaceId, table.state),
  workspaceAssigneeIdx: index('idx_tasks_workspace_assignee').on(table.workspaceId, table.assigneeId),
}));

// --- Outbox / Audit Events Table ---
export const taskEvents = sqliteTable('task_events', {
  id: text('id').primaryKey(), // UUID
  taskId: text('task_id').notNull().references(() => tasks.id),
  eventType: text('event_type').notNull(), // TaskCreated, TaskAssigned, TaskStateChanged
  payload: text('payload', { mode: 'json' }).notNull(), // JSON snapshot/delta
  createdAt: integer('created_at').default(sql`(unixepoch())`).notNull(),
}, (table) => ({
  taskIdIdx: index('idx_events_task_id').on(table.taskId),
  createdAtIdx: index('idx_events_created_at').on(table.createdAt),
}));

// --- Idempotency Keys Table ---
export const idempotencyKeys = sqliteTable('idempotency_keys', {
  key: text('key').primaryKey(),
  responsePayload: text('response_payload', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull(),
});
