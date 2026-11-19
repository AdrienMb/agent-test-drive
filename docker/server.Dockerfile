# The deployed app: NestJS API + built web app in one service, running agents in Railway sandboxes.
#   docker build -f docker/server.Dockerfile -t agent-test-drive .
# Railway builds it as configured in .railway/railway.ts. The agent SDKs are not in this image: the server installs
# them in a Railway sandbox template from packages/runner/dist/sandbox-deps.json.

FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifests first so the install layer is cached until dependencies change.
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN yarn install --immutable

COPY packages packages
COPY apps apps
RUN yarn workspace @atd/shared build \
 && yarn workspace @atd/runner build \
 && yarn workspace @atd/server build \
 && yarn workspace @atd/web build \
 && yarn workspaces focus @atd/server --production

FROM node:22-slim
ENV NODE_ENV=production \
    SANDBOX_PROVIDER=railway
WORKDIR /app

# Same layout as the repo: the server finds the runner and the web app relative to its own dist.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/runner/package.json packages/runner/
COPY --from=build /app/packages/runner/dist packages/runner/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

USER node
CMD ["node", "--enable-source-maps", "apps/server/dist/main.js"]
