import { setupLogger } from '@core/setup-logger';
import { EnvService } from '@core/config/env/env.service';
import { ChannelRegistryService } from '@harness/channel/channel-registry.service';
import { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import { ConductorService } from '@harness/conductor/conductor.service';
import { EmployeeRegistry } from '@harness/employees/employee.registry';
import { TaskStore } from '@harness/memory/task-store';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { NestFactory } from '@nestjs/core';
import { createElement } from 'react';
import { loadInk, render } from './ink';
import type { TuiChatSurface } from './tui-chat-surface';
import { TuiModule } from './tui.module';
import { App, type AppDeps } from './ui/App';
import { buildCommands } from './ui/commands';
import { sessionDump } from './ui/transcript';

/**
 * Boot the harness headless (standalone context — no HTTP server), then attach the Ink renderer.
 * Order matters: Nest bootstraps (and may log) BEFORE Ink takes the alternate screen; once Ink owns
 * the terminal, Nest logging is silenced so nothing tears the live frame. On exit, Ink restores the
 * primary screen and the captured transcript is printed to real scrollback (the alternate buffer
 * has none), where it's copyable and pipeable.
 */
async function bootstrap() {
  const logger = setupLogger();
  const app = await NestFactory.createApplicationContext(TuiModule, {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  await loadInk();

  const employees = app.get(EmployeeRegistry);
  const surface = app.get<TuiChatSurface>(CHAT_SURFACE);
  const deps: AppDeps = {
    bus: app.get(ConductorEventsBus),
    surface,
    commands: buildCommands({
      conductor: app.get(ConductorService),
      tasks: app.get(TaskStore),
      registry: app.get(ChannelRegistryService),
      employees,
      surface,
      project: app.get(EnvService).get('ZERO_PROJECT'),
    }),
    banner:
      `#dev — ${employees
        .list()
        .map((b) => `${b.name} (${b.role})`)
        .join(' · ')}\n` +
      '/as <name> · @Name to address a bot · /room <name> + /dm <bot> to move rooms · /rooms · /debug logs · ↑/↓/wheel + PgUp/PgDn scroll · /exit',
  };

  // Ink owns the terminal from here — silence Nest logging so nothing tears the live frame.
  app.useLogger(false);
  const interactive = process.stdout.isTTY;
  const instance = render(createElement(App, { deps }), {
    alternateScreen: interactive,
  });

  await instance.waitUntilExit();
  // Graceful teardown: aborts in-flight workers, flushes channel/cursor write-behinds (see
  // ConductorService.onApplicationShutdown), closes the DB pool.
  await app.close();
  if (sessionDump.text) process.stdout.write(`${sessionDump.text}\n`);
  process.exit(0);
}
void bootstrap();
