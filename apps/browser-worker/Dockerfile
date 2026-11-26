ARG NODE_IMAGE=node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
FROM ${NODE_IMAGE} AS broker
WORKDIR /opt/browser-worker
RUN install -d -m 0700 -o node -g node /run/deva-browser-control /run/deva-browser-egress && mkdir -p /etc/deva-browser
COPY apps/browser-worker/src ./src
RUN chmod -R u=rwX,go=rX /opt/browser-worker/src
USER node:node
ENTRYPOINT ["node","/opt/browser-worker/src/cli.mjs"]
CMD ["egress"]

FROM broker AS browser
USER root
# The browser is optional. Install the distro sandbox; the engine checks the running
# renderer's namespaces and seccomp rather than assuming a successful launch is safe.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates chromium chromium-sandbox fonts-liberation fonts-noto-cjk
USER node:node
CMD ["worker"]
