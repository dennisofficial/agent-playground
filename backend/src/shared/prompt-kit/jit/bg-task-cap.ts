export const BG_TASK_CAP_NOTICE = [
  '[background task capped] A Bash task you started with run_in_background has been running past this turn’s',
  'maximum hold time and is STILL RUNNING — it was not killed. run_in_background is only for SHORT, finite work',
  '(a build, a migration, a test suite) that finishes on its own. Long-running processes — dev servers,',
  'file/test watchers, headless browsers, docker compose services — belong under atlas-svc: start them with',
  '`atlas-svc run …` (supervised, survives across turns) and check them with `atlas-svc ps`. If this task is',
  'stuck or no longer needed, stop it with TaskStop.',
].join(' ');
