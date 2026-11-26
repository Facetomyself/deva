# Development target: authenticated web workbench. This is not an Electron/Xvfb desktop.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY .npmrc package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY apps/headless/package.json ./apps/headless/package.json
RUN corepack enable && pnpm install --frozen-lockfile --filter @deva/desktop --filter @deva/headless
COPY apps/desktop ./apps/desktop
COPY apps/headless ./apps/headless
COPY scripts/workbench ./scripts/workbench
RUN pnpm workbench:build && pnpm --filter @deva/headless build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /opt/deva
ENV NODE_ENV=production DEVA_HOME=/data DEVA_RUN_DIR=/run/deva DEVA_MASTER_KEY_FILE=/keys/master.key DEVA_WEB_DIR=/opt/deva/web DEVA_HOST=127.0.0.1 DEVA_PORT=8787
RUN test -x /usr/bin/flock && install -d -m 0700 -o node -g node /data /keys /run/deva
COPY --from=build /src/apps/headless/package.json ./apps/headless/package.json
COPY --from=build /src/apps/desktop/package.json ./apps/desktop/package.json
COPY --from=build /src/apps/headless/src ./apps/headless/src
COPY --from=build /src/apps/headless/dist ./apps/headless/dist
COPY --from=build /src/apps/desktop/out/workbench ./web
# The source checkout may use umask 077. Keep code owned by root, but make it readable
# and directories traversable for the unprivileged runtime. Private volumes are untouched.
RUN chmod -R u=rwX,go=rX /opt/deva/apps /opt/deva/web
USER node:node
EXPOSE 8787
ENTRYPOINT ["node", "/opt/deva/apps/headless/src/cli.mjs"]
CMD ["serve"]
