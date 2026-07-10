# Custom Caddy image: stock caddy:2 plus the Cloudflare DNS module, needed for the
# `*.atlas.dltechnologies.co` wildcard cert via the ACME DNS-01 challenge. Built and
# pushed in CI alongside the backend/web images (ghcr.io/dennisofficial/atlas-caddy),
# then pulled by infra/docker-compose.prod.yml — deploy.sh ships no build context.
FROM caddy:2-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
