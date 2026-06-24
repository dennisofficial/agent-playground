/**
 * Manual escape hatch: reclaim ORPHANED Atlas sandbox Docker artifacts — `atlas-sbx-*-net` networks and
 * `atlas-sbx-*-dind` volumes whose owning container no longer exists. The running app reaps these via
 * `SandboxManager.reapOrphanedArtifacts()` (on every `reapStopped` pass); this script applies the SAME
 * rule out-of-band for hosts where strays accumulated before the teardown fix, or where the soft-cap
 * reaper never fires (no `MAX_CONCURRENT_SANDBOXES`).
 *
 * Self-contained (just dockerode) so it can run as a one-shot on the host without booting the app.
 * Connects over `DOCKER_SOCKET_PATH ?? DOCKER_SOCKET_PATH` (else dockerode's default socket).
 *
 *   Preview:  pnpm reap -- --dry-run
 *   Reap:     pnpm reap
 */
import Docker from 'dockerode';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const socketPath = process.env.DOCKER_SOCKET_PATH;
  const docker = socketPath ? new Docker({ socketPath }) : new Docker();

  // Live container names (the artifact's name stem must NOT match one, or it's still in use).
  const containers = await docker.listContainers({ all: true });
  const live = new Set(containers.flatMap((c) => (c.Names ?? []).map((n) => n.replace(/^\//, ''))));
  const isOrphan = (name: string, suffix: string): boolean =>
    name.startsWith('atlas-sbx-') && name.endsWith(suffix) && !live.has(name.slice(0, -suffix.length));

  const nets = (await docker.listNetworks()).filter((n) => isOrphan(n.Name, '-net'));
  const vols = ((await docker.listVolumes()).Volumes ?? []).filter((v) => isOrphan(v.Name, '-dind'));

  if (!nets.length && !vols.length) {
    console.log('No orphaned atlas-sbx artifacts found.');
    return;
  }

  for (const n of nets) {
    if (dryRun) {
      console.log(`[dry-run] would remove network ${n.Name}`);
      continue;
    }
    try {
      await docker.getNetwork(n.Id).remove();
      console.log(`removed network ${n.Name}`);
    } catch (err) {
      console.warn(`skip network ${n.Name}: ${String(err)}`);
    }
  }
  for (const v of vols) {
    if (dryRun) {
      console.log(`[dry-run] would remove volume ${v.Name}`);
      continue;
    }
    try {
      await docker.getVolume(v.Name).remove();
      console.log(`removed volume ${v.Name}`);
    } catch (err) {
      console.warn(`skip volume ${v.Name}: ${String(err)}`);
    }
  }

  console.log(`${dryRun ? 'Would reap' : 'Reaped'} ${nets.length} network(s) + ${vols.length} volume(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
