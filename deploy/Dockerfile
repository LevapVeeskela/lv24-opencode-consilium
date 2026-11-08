# syntax=docker/dockerfile:1
# LV24 opencode-consilium image. Build from the repository root:
#   docker build -f deploy/Dockerfile -t lv24-opencode-consilium:local .
# Release images (linux/amd64, linux/arm64) are published to
# ghcr.io/levapveeskela/lv24-opencode-consilium by
# .github/workflows/container.yml.
#
# The build stage runs on the build host; the runtime stage installs the
# OpenCode CLI for the target architecture.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG VERSION=dev
ARG COMMIT=dev
ARG DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/LevapVeeskela/lv24-opencode-consilium" \
      org.opencontainers.image.description="LV24 opencode-consilium: a council of AI experts for OpenCode (CLI, MCP and V2 plugin)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.documentation="https://github.com/LevapVeeskela/lv24-opencode-consilium#readme" \
      org.opencontainers.image.url="https://github.com/LevapVeeskela/lv24-opencode-consilium" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${DATE}"

# git is needed for `consilium --diff`; OpenCode CLI is the engine the council
# drives. Pin the CLI version so a rebuild is reproducible; bump it together
# with the image tag. Model credentials and config are mounted at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g opencode-ai@1.19.5 \
    && npm cache clean --force

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY schema ./schema
COPY consilium.config.example.json ./
RUN chmod +x bin/cli.js bin/mcp.js \
    && ln -s /app/bin/cli.js /usr/local/bin/consilium \
    && ln -s /app/bin/cli.js /usr/local/bin/lv24-opencode-consilium \
    && ln -s /app/bin/mcp.js /usr/local/bin/consilium-mcp

RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace
USER node
ENV HOME=/home/node

ENTRYPOINT ["consilium"]
CMD ["--help"]
