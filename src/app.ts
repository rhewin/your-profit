import express from 'express';
import { TaskController } from './controllers/taskController';
import { db } from './db';
import { taskEvents } from './db/schema';
import { sql } from 'drizzle-orm';

export const app = express();
app.use(express.json());

// Log Requests
app.use((req, res, next) => {
    console.log(`>>> ${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
});

// Root Route
app.get('/', (req, res) => {
    res.send('API Server is Running');
});

// Routes
const router = express.Router();

router.post('/workspaces/:workspaceId/tasks', TaskController.create);
router.post('/workspaces/:workspaceId/tasks/:taskId/assign', TaskController.assign);
router.post('/workspaces/:workspaceId/tasks/:taskId/transition', TaskController.transition);
router.get('/workspaces/:workspaceId/tasks/:taskId', TaskController.get);
router.get('/workspaces/:workspaceId/tasks', TaskController.list);

// Health Check
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Events Endpoint
router.get('/events', async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const rawEvents = await db.select().from(taskEvents).orderBy(sql`${taskEvents.createdAt} DESC`).limit(limit).all();

    // Normalize to snake_case
    const events = rawEvents.map(e => ({
        id: e.id,
        task_id: e.taskId,
        event_type: e.eventType,
        payload: e.payload,
        created_at: e.createdAt
    }));

    res.json(events);
});

app.use('/v1', router);

// Catch-all 404
app.use((req, res) => {
    console.log(`!!! 404 NOT FOUND: ${req.method} ${req.url}`);
    res.status(404).json({
        error: 'Route not found',
        path: req.url,
        method: req.method,
        suggestion: 'Ensure you are using the /v1 prefix'
    });
});

export default app;
