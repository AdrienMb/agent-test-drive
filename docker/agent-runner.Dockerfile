# check=skip=InvalidDefaultArgInFrom
# Image that runs ONE coding agent (Claude Code or Codex) for ONE prompt.
# One image per agent, built from the monorepo root:
#   docker build -f docker/agent-runner.Dockerfile --build-arg AGENT=claude -t agent-runner-claude:latest .
#   docker build -f docker/agent-runner.Dockerfile --build-arg AGENT=codex  -t agent-runner-codex:latest .
# No default on purpose: building without --build-arg AGENT fails.
ARG AGENT

# ---- build stage: install, compile, then prune to production deps ----
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Manifests first so the install layer is cached until dependencies change.
# Every workspace manifest is needed for `--immutable` to match yarn.lock.
COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/runner/package.json packages/runner/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN yarn install --immutable

COPY packages/shared packages/shared
COPY packages/runner packages/runner
RUN yarn workspace @atd/shared build \
 && yarn workspace @atd/runner build \
 && yarn workspaces focus @atd/runner --production

# ---- prune stage: drop the other agents' SDKs (their native CLIs are ~350 MB each) ----
# Pruning must happen before the runtime COPY; deleting in a later layer would not shrink the image.
FROM build AS pruned-claude
RUN rm -rf node_modules/@openai

FROM build AS pruned-codex
RUN rm -rf node_modules/@anthropic-ai node_modules/@modelcontextprotocol

FROM pruned-${AGENT} AS pruned

# ---- runtime stage (identical for every agent) ----
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DISABLE_AUTOUPDATER=1

COPY --from=pruned /app/node_modules /app/node_modules
COPY --from=pruned /app/packages /app/packages

RUN mkdir /workspace && chown node:node /workspace
USER node
RUN git config --global user.name "agent" \
 && git config --global user.email "agent@localhost" \
 && git config --global init.defaultBranch main
WORKDIR /workspace
RUN git init -q

ENTRYPOINT ["node", "/app/packages/runner/dist/main.js"]
