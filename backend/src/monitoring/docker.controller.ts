import { Controller, Get, Post, Body, Param, Query, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Container inventory and control. Reachable only with an admin credential:
 * '/api/docker/' is in GlobalAuthGuard's ALWAYS_ENFORCED_PREFIXES, so it is
 * enforced regardless of GLOBAL_AUTH_MODE.
 *
 * The dashboard's own /api/docker/* routes proxy here rather than shelling out
 * to docker themselves, which is what let us drop the /var/run/docker.sock mount
 * from the dashboard container.
 *
 * Arguments go through execFile (never a shell string) and every caller-supplied
 * value is validated against an allowlist below — a rejected id is refused, not
 * silently rewritten.
 */
const SAFE_CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_TAIL = /^\d+$/;
const SAFE_SINCE = /^\d+[smhd]$/;
const ALLOWED_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause'];

const PS_FORMAT =
  '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}","status":"{{.Status}}","state":"{{.State}}","ports":"{{.Ports}}","created":"{{.CreatedAt}}"}';

@Controller('docker')
export class DockerController {
  private readonly logger = new Logger(DockerController.name);

  @Get('containers')
  async getContainers() {
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '-a', '--format', PS_FORMAT],
        { timeout: 10000 },
      );
      const containers = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return { success: true, containers };
    } catch (error) {
      this.logger.warn(`Docker not available: ${error.message}`);
      return { success: false, containers: [], error: 'Docker not available' };
    }
  }

  @Get('logs/:containerId')
  async getContainerLogs(
    @Param('containerId') containerId: string,
    @Query('tail') tail?: string,
    @Query('since') since?: string,
  ) {
    if (!SAFE_CONTAINER_ID.test(containerId) || containerId.length > 128) {
      return { success: false, logs: '', error: 'Invalid container ID format' };
    }

    const args = ['logs', containerId, '--tail', tail && SAFE_TAIL.test(tail) ? tail : '100'];
    if (since && SAFE_SINCE.test(since)) args.push('--since', since);

    try {
      const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return { success: true, logs: `${stdout}${stderr}` };
    } catch (error) {
      return { success: false, logs: '', error: error.message };
    }
  }

  @Post('action')
  async containerAction(@Body() body: { containerId: string; action: string }) {
    const containerId = body?.containerId ?? '';

    if (!SAFE_CONTAINER_ID.test(containerId) || containerId.length > 128) {
      return { success: false, error: 'Invalid container ID format' };
    }
    if (!ALLOWED_ACTIONS.includes(body?.action)) {
      return {
        success: false,
        error: `Invalid action. Allowed: ${ALLOWED_ACTIONS.join(', ')}`,
      };
    }

    try {
      await execFileAsync('docker', [body.action, containerId], { timeout: 30000 });
      this.logger.log(`Container ${containerId}: ${body.action}`);
      return { success: true, message: `Container ${containerId} ${body.action}ed` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}
