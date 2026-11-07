ARG NODE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

FROM ${NODE_IMAGE} AS egress-gateway

ARG AIBRAIN_EGRESS_UID=10002
ARG AIBRAIN_EGRESS_GID=10002

RUN groupadd --system --gid "${AIBRAIN_EGRESS_GID}" aibrain-egress \
  && useradd --system --uid "${AIBRAIN_EGRESS_UID}" --gid aibrain-egress \
    --home-dir /nonexistent --no-create-home aibrain-egress \
  && install -d -m 0755 -o root -g root /usr/local/share/aibrain

COPY --chown=root:root infra/hetzner/egress/gateway.mts /usr/local/share/aibrain/egress-gateway.mts
COPY --chown=root:root infra/hetzner/ingress/gateway.mts /usr/local/share/aibrain/ingress-gateway.mts
RUN chmod 0444 /usr/local/share/aibrain/egress-gateway.mts /usr/local/share/aibrain/ingress-gateway.mts

ARG AIBRAIN_REVISION=development
LABEL org.opencontainers.image.title="AiBrain Egress Gateway" \
      org.opencontainers.image.vendor="GraphikAI" \
      org.opencontainers.image.revision="${AIBRAIN_REVISION}"

USER aibrain-egress:aibrain-egress
EXPOSE 8080
ENTRYPOINT ["node", "/usr/local/share/aibrain/egress-gateway.mts"]

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS horaria-dependencies
# The slim build base may detect OpenSSL 1.1, while the final runtime uses 3.0.
ENV PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x
WORKDIR /horaria
COPY modules/horaria/backend/package.json modules/horaria/backend/package-lock.json ./
COPY modules/horaria/backend/prisma ./prisma
RUN npm ci --ignore-scripts && npm run build \
  && test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Tenant artwork mappings remain in source but never enter a reusable image.
RUN node -e "require('node:fs').writeFileSync('config/profile-artwork.json', '[]\\n')"
RUN npm run build && npm run build:automation-worker && npm run build:weekly-token-budget && npm run build:container-app-server-acceptance && npm run build:presentation-runtime && node scripts/build-container-presentation-tool-acceptance.mjs && node scripts/build-modtime-operator-tools.mjs && node scripts/build-trinalum-operator-tools.mjs && node scripts/build-container-xls-passive-acceptance.mjs && node scripts/build-outlook-desktop-operator.mjs && node scripts/build-g03-source-sync-operator.mjs && node scripts/support/build.mjs

# Public native runtime. The signed Debian snapshot keeps native dependencies
# independent of the former private registry. Security/isolation wrappers below
# are identical to the application runtime; no host or tenant data is included.
FROM ${NODE_IMAGE} AS native-runtime
ARG AIBRAIN_UID=10001
ARG AIBRAIN_GID=10001
RUN rm -f /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian/20260820T000000Z bookworm main' \
    'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://snapshot.debian.org/archive/debian-security/20260820T000000Z bookworm-security main' \
    > /etc/apt/sources.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates tini bubblewrap chromium chromium-sandbox \
    libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils qpdf restic \
    python3 python3-venv python3-openpyxl python3-pil catdoc unrtf \
    fonts-dejavu-core fonts-liberation fonts-crosextra-carlito \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid "${AIBRAIN_GID}" aibrain \
  && useradd --uid "${AIBRAIN_UID}" --gid aibrain --no-create-home --home-dir /var/lib/aibrain/data/app-home aibrain \
  && install -d -m 0755 -o root -g root /usr/local/share/aibrain /srv/aibrain/publish-rw \
  && install -d -m 0750 -o aibrain -g aibrain /var/lib/aibrain/data /var/lib/aibrain-restores

FROM native-runtime AS runtime
USER root
WORKDIR /
ARG AIBRAIN_UID=10001
ARG AIBRAIN_GID=10001

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    CHAT_RUNTIME=codex \
    CODEX_BIN=/usr/local/bin/aibrain-codex-worker \
    CODEX_HOME_ROOT=/var/lib/aibrain/data/users \
    CODEX_WORKSPACE_ROOT=/var/lib/aibrain/data/users \
    CODEX_APPROVAL_POLICY=never \
    AIBRAIN_BROWSER_INTERACTIVE_APPROVALS=disabled \
    CODEX_SANDBOX=workspace-write \
    AIBRAIN_INSTALLATION_CONFIG=/etc/aibrain/installation.json \
    AIBRAIN_CHROME_BIN=/usr/local/bin/aibrain-chrome \
    AIBRAIN_SOFFICE_BIN=/usr/local/bin/aibrain-soffice \
    AIBRAIN_PDFINFO_BIN=/usr/local/bin/aibrain-pdfinfo \
    AIBRAIN_PDFTOPPM_BIN=/usr/local/bin/aibrain-pdftoppm \
    AIBRAIN_PDFTOTEXT_BIN=/usr/local/bin/aibrain-pdftotext \
    AIBRAIN_QPDF_BIN=/usr/local/bin/aibrain-qpdf \
    AIBRAIN_CODEX_EXPECTED_VERSION=0.162.1 \
    AIBRAIN_INTERNAL_AGENT_CONTEXT_ROOT=/usr/local/share/aibrain/internal-agent-context \
    HOME=/var/lib/aibrain/data/app-home \
    XDG_CACHE_HOME=/var/lib/aibrain/data/server/xdg/cache \
    XDG_CONFIG_HOME=/var/lib/aibrain/data/server/xdg/config \
    XDG_DATA_HOME=/var/lib/aibrain/data/server/xdg/data \
    XDG_STATE_HOME=/var/lib/aibrain/data/server/xdg/state

# Mount the pinned dependency-stage npm for installation, then remove package
# managers from the final runtime along with the installation cache.
# Keep the replacement CLI readonly in this same layer to avoid a later chmod
# copying its entire binary package into another overlay layer.
RUN --mount=type=bind,from=dependencies,source=/usr/local/lib/node_modules/npm,target=/opt/aibrain-build-npm,readonly \
    node /opt/aibrain-build-npm/bin/npm-cli.js install --global --omit=dev --cache=/tmp/aibrain-npm-cache "@openai/codex@0.162.1" "tsx@4.20.6" \
  && mv -f /usr/local/bin/codex /usr/local/bin/codex-real \
  && test "$(/usr/local/bin/codex-real --version)" = "codex-cli 0.162.1" \
  && node -e "if (require('/usr/local/lib/node_modules/tsx/package.json').version !== '4.20.6') process.exit(1)" \
  && chmod -R a-w /usr/local/bin/codex-real /usr/local/lib/node_modules/@openai/codex \
  && rm -rf /tmp/aibrain-npm-cache /app /opt/aibrain-horaria \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# Fail the build if the immutable native base loses a required tool. The real
# image acceptance still exercises their production isolation boundaries.
RUN test "$(node --version)" = "v24.18.1" \
  && test "$(id -u aibrain)" = "${AIBRAIN_UID}" \
  && test "$(id -g aibrain)" = "${AIBRAIN_GID}" \
  && for package in bubblewrap chromium chromium-sandbox libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils python3 python3-venv qpdf restic; do \
       test "$(dpkg-query -W -f='${db:Status-Status}' "$package")" = installed || exit 1; \
     done \
  && test -x /usr/bin/flock \
  && test -x /usr/bin/bwrap \
  && test -x /usr/lib/chromium/chrome-sandbox

RUN /usr/bin/python3 -c "import openpyxl; from PIL import Image"
COPY --chown=root:root infra/hetzner/knowledge-test-requirements.txt /usr/local/share/aibrain/passive-xls-requirements.txt
RUN /usr/bin/python3 -m venv /opt/aibrain-passive-xls \
  && /opt/aibrain-passive-xls/bin/python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /usr/local/share/aibrain/passive-xls-requirements.txt \
  && /opt/aibrain-passive-xls/bin/python -c "import xlrd; assert xlrd.__version__ == '2.0.2'" \
  && chmod -R a-w /opt/aibrain-passive-xls

# Bubblewrap needs a pre-existing mountpoint because the container root is
# deliberately read-only before document conversion begins.
RUN install -d -m 0555 -o root -g root /work

COPY --from=builder --chown=root:root /app/dist/pptxgenjs.cjs /usr/local/share/aibrain/pptxgenjs.cjs
COPY --chown=root:root scripts/container-document-conversion-acceptance.mjs /usr/local/share/aibrain/container-document-conversion-acceptance.mjs
COPY --chown=root:root scripts/xlsx-turn-text.py /usr/local/share/aibrain/xlsx-turn-text.py
COPY --chown=root:root scripts/nominalia-mail.py /usr/local/share/aibrain/nominalia-mail.py
COPY --chown=root:root scripts/xls-passive-read.py /usr/local/share/aibrain/xls-passive-read.py
COPY --chown=root:root scripts/g03-spreadsheet-paged.py /usr/local/share/aibrain/g03-spreadsheet-paged.py
COPY --chown=root:root docs/PRESENTATION_AUTHORING.md /usr/local/share/aibrain/presentations.md

WORKDIR /app
COPY --from=builder --chown=aibrain:aibrain /app/.next/standalone ./
COPY --from=horaria-dependencies --chown=root:root /horaria /opt/aibrain-horaria
COPY --chown=root:root modules/horaria/backend/src /opt/aibrain-horaria/src
RUN /opt/aibrain-horaria/node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x --version
COPY --from=builder --chown=aibrain:aibrain /app/.next/static ./.next/static
COPY --from=builder --chown=aibrain:aibrain /app/public ./public
RUN install -d -m 0755 -o root -g root /usr/local/share/aibrain/internal-agent-context
COPY --from=builder --chown=root:root /app/dist/automation-worker.mjs ./automation-worker.mjs
COPY --from=builder --chown=root:root /app/dist/support-control.cjs /usr/local/share/aibrain/support-control.cjs
COPY --from=builder --chown=root:root /app/dist/initialize-weekly-token-budget.mjs /usr/local/share/aibrain/initialize-weekly-token-budget.mjs
COPY --from=builder --chown=root:root /app/dist/container-app-server-acceptance.mjs /usr/local/share/aibrain/container-app-server-acceptance.mjs
COPY --from=builder --chown=root:root /app/dist/container-presentation-tool-acceptance.mjs /usr/local/share/aibrain/container-presentation-tool-acceptance.mjs
COPY --from=builder --chown=root:root /app/dist/modtime-provision.cjs /app/dist/modtime-readback.cjs /usr/local/share/aibrain/
COPY --from=builder --chown=root:root /app/dist/trinalum-provision.cjs /usr/local/share/aibrain/trinalum-provision.cjs
COPY --from=builder --chown=root:root /app/dist/host-analysis.cjs /usr/local/share/aibrain/host-analysis.cjs
COPY --from=builder --chown=root:root /app/dist/container-xls-passive-acceptance.mjs /usr/local/share/aibrain/container-xls-passive-acceptance.mjs
COPY --from=builder --chown=root:root /app/dist/outlook-desktop-operator.mjs /usr/local/share/aibrain/outlook-desktop-operator.mjs
COPY --from=builder --chown=root:root /app/dist/g03-source-sync-operator.mjs /usr/local/share/aibrain/g03-source-sync-operator.mjs
COPY --chown=root:root tests/fixtures/legacy-passive-links-macros.xls tests/fixtures/legacy-autofilter.xls /usr/local/share/aibrain/
# The scheduler is an explicit server-conditioned ESM bundle. Unlike the app,
# it does not depend on Next's standalone file tracer, tsx, source mounts, or a
# hand-copied `server-only` marker/dependency graph at runtime.
COPY --from=builder --chown=root:root /app/scripts/backup.ts ./scripts/backup.ts
COPY --from=builder --chown=root:root /app/scripts/replicate-backup.ts ./scripts/replicate-backup.ts
COPY --from=builder --chown=root:root /app/scripts/run-operational-alerts.ts ./scripts/run-operational-alerts.ts
COPY --from=builder --chown=root:root /app/scripts/maintain-document-temporaries.ts ./scripts/maintain-document-temporaries.ts
COPY --from=builder --chown=root:root /app/src/config/installation.ts /app/src/config/installation-schema.ts ./src/config/
COPY --from=builder --chown=root:root /app/src/documents/publication-locks.ts ./src/documents/publication-locks.ts
COPY --from=builder --chown=root:root /app/src/documents/maintenance.ts ./src/documents/maintenance.ts
COPY --from=builder --chown=root:root /app/src/operations/backup.ts /app/src/operations/backup-replica.ts ./src/operations/
COPY --from=builder --chown=root:root /app/src/operations/alerts.ts /app/src/operations/alert-collector.ts /app/src/operations/alert-delivery.ts ./src/operations/
COPY --from=builder --chown=root:root /app/src/security/safe-file.ts ./src/security/safe-file.ts
COPY --from=builder --chown=root:root \
  /app/src/storage/atomic-file.ts \
  /app/src/storage/errors.ts \
  /app/src/storage/index.ts \
  /app/src/storage/journal.ts \
  /app/src/storage/regenerable-index.ts \
  /app/src/storage/resource-lock.ts \
  /app/src/storage/schema.ts \
  ./src/storage/
COPY --chown=root:root infra/hetzner/app/entrypoint.sh /usr/local/bin/aibrain-entrypoint
COPY --chown=root:root infra/hetzner/app/worker-sandbox.sh /usr/local/bin/aibrain-codex-worker
COPY --chown=root:root infra/hetzner/app/browser-sandbox.sh /usr/local/bin/aibrain-chrome
COPY --chown=root:root infra/hetzner/app/soffice-safe.sh /usr/local/bin/aibrain-soffice
COPY --chown=root:root infra/hetzner/app/soffice-safe.sh /usr/local/bin/aibrain-pdfinfo
COPY --chown=root:root infra/hetzner/app/soffice-safe.sh /usr/local/bin/aibrain-pdftoppm
COPY --chown=root:root infra/hetzner/app/soffice-safe.sh /usr/local/bin/aibrain-pdftotext
COPY --chown=root:root infra/hetzner/app/soffice-safe.sh /usr/local/bin/aibrain-qpdf
COPY --chown=root:root infra/hetzner/app/xls-passive-safe.sh /usr/local/bin/aibrain-xls-passive
COPY --chown=root:root infra/hetzner/app/g03-paged-spreadsheet-safe.sh /usr/local/bin/aibrain-g03-paged-spreadsheet
COPY --chown=root:root infra/hetzner/app/backup.sh /usr/local/bin/aibrain-backup
COPY --chown=root:root infra/hetzner/app/backup-replicate.sh /usr/local/bin/aibrain-backup-replicate
COPY --chown=root:root infra/hetzner/app/alerts.sh /usr/local/bin/aibrain-alerts
COPY --chown=root:root infra/hetzner/app/alert-controller.sh /usr/local/bin/aibrain-alert-controller
COPY --chown=root:root infra/hetzner/app/alert-controller-healthcheck.mjs /usr/local/share/aibrain/alert-controller-healthcheck.mjs
COPY --chown=root:root infra/hetzner/app/document-maintenance.sh /usr/local/bin/aibrain-document-maintenance
COPY --chown=root:root infra/hetzner/app/healthcheck.mjs /usr/local/share/aibrain/healthcheck.mjs
COPY --chown=root:root infra/hetzner/app/automation-worker-healthcheck.mjs /usr/local/share/aibrain/automation-worker-healthcheck.mjs
COPY --chown=root:root infra/hetzner/app/configure-egress.mjs /usr/local/share/aibrain/configure-egress.mjs
RUN chmod 0755 \
  /usr/local/bin/aibrain-entrypoint \
  /usr/local/bin/aibrain-codex-worker \
  /usr/local/bin/aibrain-chrome \
  /usr/local/bin/aibrain-soffice \
  /usr/local/bin/aibrain-pdfinfo \
  /usr/local/bin/aibrain-pdftoppm \
  /usr/local/bin/aibrain-pdftotext \
  /usr/local/bin/aibrain-qpdf \
  /usr/local/bin/aibrain-xls-passive \
  /usr/local/bin/aibrain-g03-paged-spreadsheet \
  /usr/local/bin/aibrain-backup \
  /usr/local/bin/aibrain-backup-replicate \
  /usr/local/bin/aibrain-alerts \
  /usr/local/bin/aibrain-alert-controller \
  /usr/local/bin/aibrain-document-maintenance \
  && chmod 0444 /usr/local/share/aibrain/healthcheck.mjs /usr/local/share/aibrain/automation-worker-healthcheck.mjs /usr/local/share/aibrain/alert-controller-healthcheck.mjs \
  && chmod 0555 /usr/local/share/aibrain/configure-egress.mjs /usr/local/share/aibrain/container-app-server-acceptance.mjs \
  && chmod -R a-w /app /usr/local/share/aibrain/internal-agent-context

ARG AIBRAIN_REVISION=development
LABEL org.opencontainers.image.title="AiBrain Company Brain" \
      org.opencontainers.image.vendor="GraphikAI" \
      org.opencontainers.image.revision="${AIBRAIN_REVISION}"

USER aibrain:aibrain
EXPOSE 3000
VOLUME ["/var/lib/aibrain/data", "/var/lib/aibrain-restores"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/aibrain-entrypoint"]
CMD ["node", "server.js"]
