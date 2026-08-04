# Stage 1: Build Next.js static export
FROM node:24-alpine AS frontend
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src/ ./src/
COPY public/ ./public/
COPY next.config.ts tsconfig.json postcss.config.mjs components.json ./
RUN pnpm build

# Stage 2: Build Rust server binary + codeg-mcp companion
FROM rust:slim-bookworm AS backend
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app/src-tauri
COPY src-tauri/ ./
# codeg-mcp is the stdio MCP companion the runtime injects per session
# (see acp/delegation/companion.rs). It must ship next to codeg-server so
# `locate_codeg_mcp_binary()` finds it via the exe-sibling lookup.
RUN cargo build --release --bin codeg-server --no-default-features \
 && cargo build --release --bin codeg-mcp --no-default-features

# Stage 3: Runtime
FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y \
    libsqlite3-0 \
    git \
    openssh-client \
    ca-certificates \
    curl \
    ripgrep \
    python3 \
    python3-pip \
    libicu76 \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/codeg-brew-path.sh /etc/profile.d/codeg-brew-path.sh
# These packages are ACP transport adapters only. Their underlying Claude Code
# and Codex executables are selected from host mounts at runtime; host mode
# never uses the compatible fallback binaries bundled by the npm packages.
RUN mkdir -p /opt/codeg/acp \
    && npm install --prefix /opt/codeg/acp --no-save --omit=dev --omit=optional \
       @agentclientprotocol/claude-agent-acp@0.64.1 \
       @agentclientprotocol/codex-acp@1.1.9
# libicu76: OfficeCLI ships as a self-contained binary with an embedded .NET
# runtime, which requires the system ICU library at startup. node:*-trixie-slim
# bundles Node's own ICU statically and so does NOT install system libicu — without
# this, every `officecli` invocation aborts with "Couldn't find a valid ICU package
# installed on the system", breaking both skill sync and office file preview in the
# server/Docker mode. The version (76) is pinned to Debian trixie; update it if
# the runtime base image moves to another Debian release.
# Debian trixie ships glibc 2.41, which is compatible with the current host's
# Homebrew binaries requiring GLIBC_2.39 while retaining the official Node image.

COPY --from=backend /app/src-tauri/target/release/codeg-server /usr/local/bin/codeg-server
COPY --from=backend /app/src-tauri/target/release/codeg-mcp /usr/local/bin/codeg-mcp
COPY --from=frontend /app/out /app/web

ENV CODEG_STATIC_DIR=/app/web
ENV CODEG_DATA_DIR=/data
ENV CODEG_PORT=3080
ENV CODEG_HOST=0.0.0.0
ENV SHELL=/bin/bash
# Docker defaults to host-agent mode. Agent processes are launched directly
# inside this container from host directories mounted by docker-compose; this
# image installs only the ACP adapters and does not install Agent body
# packages, Python packages, or Agent binaries.
ENV HOME=/root
ENV CODEG_AGENT_RUNTIME=host
ENV CODEG_ACP_ADAPTER_DIR=/opt/codeg/acp
ENV CODEG_ACP_NODE=/usr/local/bin/node
ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}
# In-place self-update markers: tells the running server it is a container
# (for the post-upgrade "also pull the image" hint) and how long the
# supervisor waits before relaunching the worker after an upgrade.
ENV CODEG_RUNTIME=docker
ENV CODEG_RESTART_DELAY_MS=2000

EXPOSE 3080
VOLUME /data

# Run under the built-in supervisor (PID 1) so an in-place upgrade can swap
# the binary and have the worker relaunched without stopping the container.
CMD ["codeg-server", "--supervise"]
