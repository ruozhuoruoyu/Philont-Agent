import { expect, test, type APIRequestContext, type WebSocket } from '@playwright/test';

const launcherBase = process.env.PHILONT_E2E_BASE_URL ?? 'http://127.0.0.1:20267';
const agentBase = process.env.PHILONT_E2E_AGENT_URL ?? 'http://127.0.0.1:21266';

async function waitForAgent(request: APIRequestContext): Promise<void> {
  await expect.poll(async () => {
    try {
      const response = await request.get(`${agentBase}/api/memory/stats`);
      return response.status();
    } catch {
      return 0;
    }
  }, { timeout: 30_000, intervals: [250, 500, 1_000] }).toBe(200);
}

test('clean launcher setup, browser chat, stable navigation, and restart persistence', async ({ page, request }) => {
  const sockets: Array<{ socket: WebSocket; closed: boolean }> = [];
  page.on('websocket', (socket) => {
    const tracked = { socket, closed: false };
    socket.on('close', () => { tracked.closed = true; });
    sockets.push(tracked);
  });

  await page.goto('/');

  // A clean PHILONT_HOME must present the first-run setup instead of silently
  // falling back to an unconfigured mock model.
  await expect(page.getByRole('button', { name: /Save & Launch|保存并启动/ })).toBeVisible();

  // Configure through the launcher's public control plane. The UI deliberately
  // does not offer "mock" as a user provider, but CI needs a deterministic,
  // secret-free agent after proving that the first-run wizard appeared.
  const configured = await request.put(`${launcherBase}/api/launcher/config`, {
    data: {
      values: {
        LLM_PROVIDER: 'mock',
        ANTHROPIC_API_KEY: 'ci-only-not-a-real-key',
        PHILONT_PORT: '21266',
        PHILONT_AUTONOMOUS: '0',
        PHILONT_DEEP_EXPLORE: '0',
      },
    },
  });
  expect(configured.ok()).toBeTruthy();
  expect((await configured.json()).configured).toBe(true);

  const started = await request.post(`${launcherBase}/api/launcher/start`);
  expect(started.ok()).toBeTruthy();
  await waitForAgent(request);

  await page.reload();
  await expect(page.locator('agent-chat .status.on')).toContainText(/Connected|已连接/);
  await expect.poll(() => sockets.length).toBe(1);

  const input = page.locator('agent-chat input[placeholder]');
  await input.fill('platform smoke');
  await page.locator('agent-chat .send-btn').click();
  await expect(page.locator('agent-chat .message.user .bubble')).toContainText('platform smoke');
  await expect(page.locator('agent-chat .message.assistant .bubble')).toContainText('Mock response to:');

  // Navigation is not a conversation boundary. Chat remains mounted, so these
  // view changes must neither close nor create a WebSocket.
  await page.getByRole('button', { name: /Memory|记忆/ }).click();
  await expect(page.locator('memory-dashboard')).toBeVisible();
  await page.getByRole('button', { name: /Autonomy|自主/ }).click();
  await expect(page.locator('autonomous-dashboard')).toBeVisible();
  await page.getByRole('button', { name: /Chat|聊天/ }).click();
  await expect(page.locator('agent-chat')).toBeVisible();
  expect(sockets).toHaveLength(1);
  expect(sockets[0].closed).toBe(false);

  // Restart the supervised child. The browser reconnects, and the session that
  // ended with the old socket must be visible from the reopened SQLite store.
  const restarted = await request.post(`${launcherBase}/api/launcher/restart`);
  expect(restarted.ok()).toBeTruthy();
  await waitForAgent(request);
  await expect(page.locator('agent-chat .status.on')).toContainText(/Connected|已连接/);
  await expect.poll(async () => {
    const response = await request.get(`${agentBase}/api/memory/sessions`);
    if (!response.ok()) return 0;
    const body = await response.json();
    return Array.isArray(body.sessions) ? body.sessions.length : 0;
  }, { timeout: 20_000 }).toBeGreaterThan(0);
});
