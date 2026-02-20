import { Request, Response } from 'express';
import { TaskRepository } from '../repositories/taskRepository';
import { TaskDomain, TaskState, UserRole } from '../domain/task';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

const taskRepo = new TaskRepository();

// Validation Schemas
const createTaskSchema = z.object({
  title: z.string().min(1).max(120),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
});

const assignTaskSchema = z.object({
  assignee_id: z.string().min(1),
});

const transitionTaskSchema = z.object({
  to_state: z.enum(['IN_PROGRESS', 'DONE', 'CANCELLED']),
});

export class TaskController {

  private static mapTask(task: any) {
    return {
      task_id: task.id,
      tenant_id: task.tenantId,
      workspace_id: task.workspaceId,
      title: task.title,
      priority: task.priority,
      state: task.state,
      assignee_id: task.assigneeId,
      version: task.version,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      timeline: task.timeline ? task.timeline.map((e: any) => ({
        id: e.id,
        task_id: e.taskId,
        event_type: e.eventType,
        payload: e.payload,
        created_at: e.createdAt
      })) : undefined
    };
  }

  static async create(req: Request, res: Response) {
    try {
      const tenantId = req.headers['x-tenant-id'] as string;
      const role = req.headers['x-role'] as string;
      const idempotencyKey = req.headers['idempotency-key'] as string;
      const workspaceId = req.params.workspaceId as string;

      if (!tenantId) return res.status(400).json({ error: 'X-Tenant-Id header required' });

      const body = createTaskSchema.parse(req.body);

      const task = await taskRepo.create({
        id: uuidv4(),
        tenantId,
        workspaceId,
        title: body.title,
        priority: body.priority,
        state: 'NEW',
        assigneeId: null,
      }, idempotencyKey);

      res.status(201).json(task);
    } catch (e: any) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues });
      res.status(500).json({ error: e.message });
    }
  }

  static async assign(req: Request, res: Response) {
    try {
      const role = req.headers['x-role'] as UserRole;
      const tenantId = req.headers['x-tenant-id'] as string;
      const ifMatchVersion = parseInt(req.headers['if-match-version'] as string);
      const taskId = req.params.taskId as string;
      const workspaceId = req.params.workspaceId as string;

      if (!tenantId) return res.status(400).json({ error: 'X-Tenant-Id header required' });
      if (isNaN(ifMatchVersion)) return res.status(400).json({ error: 'If-Match-Version header required' });

      const body = assignTaskSchema.parse(req.body);

      if (role !== 'manager') {
          return res.status(403).json({ error: 'Only manager can assign tasks' });
      }

      // Check task existence and workspace/tenant isolation
      const task = await taskRepo.findById(taskId, tenantId);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (task.workspaceId !== workspaceId) return res.status(404).json({ error: 'Task not found in this workspace' });

      const result = await taskRepo.assign(taskId, body.assignee_id, ifMatchVersion);
      res.json(result);

    } catch (e: any) {
      if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues });
      if (e.message === 'TaskNotFound') return res.status(404).json({ error: 'Task not found' });
      if (e.message === 'VersionMismatch') return res.status(409).json({ error: 'Version mismatch' });
      if (e.message === 'InvalidState') return res.status(409).json({ error: 'Task state allows assignment only in NEW or IN_PROGRESS' });

      res.status(500).json({ error: e.message });
    }
  }

  static async transition(req: Request, res: Response) {
    try {
      const role = req.headers['x-role'] as UserRole;
      const tenantId = req.headers['x-tenant-id'] as string;
      const currentUserId = req.headers['x-user-id'] as string;
      const ifMatchVersion = parseInt(req.headers['if-match-version'] as string);
      const taskId = req.params.taskId as string;
      const workspaceId = req.params.workspaceId as string;

      if (!tenantId) return res.status(400).json({ error: 'X-Tenant-Id header required' });
      if (isNaN(ifMatchVersion)) return res.status(400).json({ error: 'If-Match-Version header required' });

      const body = transitionTaskSchema.parse(req.body);

      // Retrieve task to Validated Transitions
      const task = await taskRepo.findById(taskId, tenantId);
      if (!task) return res.status(404).json({ error: 'Task not found' });

      // Workspace check
      if (task.workspaceId !== workspaceId) {
          return res.status(404).json({ error: 'Task not found in this workspace' });
      }

      // Clean Arch check
      const isValid = TaskDomain.validateTransition(
        task.state as TaskState,
        body.to_state as TaskState,
        role,
        task.assigneeId,
        currentUserId
      );

      if (!isValid) {
        return res.status(409).json({ error: 'Invalid transition or unauthorized' });
      }

      const result = await taskRepo.transition(taskId, body.to_state as TaskState, ifMatchVersion);
      res.json(result);

    } catch (e: any) {
       if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues });
       if (e.message === 'VersionMismatch') return res.status(409).json({ error: 'Version mismatch' });
       res.status(500).json({ error: e.message });
    }
  }

  static async get(req: Request, res: Response) {
    const tenantId = req.headers['x-tenant-id'] as string;
    const workspaceId = req.params.workspaceId as string;
    const taskId = req.params.taskId as string;

    if (!tenantId) return res.status(400).json({ error: 'X-Tenant-Id header required' });

    const task = await taskRepo.findById(taskId, tenantId);
    if (!task || task.workspaceId !== workspaceId) {
        return res.status(404).json({ error: 'Task not found' });
    }

    res.json(TaskController.mapTask(task));
  }

  static async list(req: Request, res: Response) {
    const tenantId = req.headers['x-tenant-id'] as string;
    const workspaceId = req.params.workspaceId as string;
    const { state, assignee_id, limit, cursor } = req.query;

    if (!tenantId) return res.status(400).json({ error: 'X-Tenant-Id header required' });

    const results = await taskRepo.list(workspaceId, tenantId, {
        state: state as string,
        assigneeId: assignee_id as string,
        limit: limit ? parseInt(limit as string) : 20,
        cursor: cursor as string
    });

    res.json(results.map(t => TaskController.mapTask(t)));
  }
}
