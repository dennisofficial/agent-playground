export const CONTAINER_INSTALL_RULE =
  'the container is the only thing that installs or executes in container mode: never run a package install or anything under node_modules on the host, because native binaries there are built for the other platform and will not load. Reading and searching the mounted files from the host is fine.'
