
export type TaskState = 'NEW' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type UserRole = 'agent' | 'manager';

export interface Task {
  id: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  priority: TaskPriority;
  state: TaskState;
  assigneeId: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export class TaskDomain {
  static validateTransition(
    currentState: TaskState,
    toState: TaskState,
    role: UserRole,
    assigneeId: string | null,
    currentUserId: string // The ID of the user performing the action
  ): boolean {

    // 1. Common State Machine Rules
    const allowed: Record<TaskState, TaskState[]> = {
      NEW: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['DONE', 'CANCELLED'],
      DONE: [],
      CANCELLED: []
    };

    if (!allowed[currentState].includes(toState)) {
      return false;
    }

    // 2. Role-based Rules
    if (role === 'manager') {
       // Manager can only Cancel (from NEW or IN_PROGRESS)
       return toState === 'CANCELLED';
    }

    if (role === 'agent') {
      // Agent must be the assignee
      if (assigneeId !== currentUserId) {
        return false;
      }

      // agent can: move NEW -> IN_PROGRESS
      if (currentState === 'NEW' && toState === 'IN_PROGRESS') return true;

      // agent can: move IN_PROGRESS -> DONE
      if (currentState === 'IN_PROGRESS' && toState === 'DONE') return true;

      return false;
    }

    return false;
  }

  static canAssign(state: TaskState, role: UserRole): boolean {
    if (role !== 'manager') return false;
    return state === 'NEW' || state === 'IN_PROGRESS';
  }
}
