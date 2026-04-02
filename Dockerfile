FROM oven/bun:debian

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}

WORKDIR /app

# Install uv for most mcps
RUN apt update && apt install -y curl procps && \
    curl -LsSf https://astral.sh/uv/install.sh | sh && \
    bun install -g opencode-ai && \
    rm -rf /var/lib/apt/lists/*

# Pre-cache mcp-clickhouse (TODO: Find a better way of doing this pre-caching in a generic fashion
RUN echo | /root/.local/bin/uv run --python 3.10 --with mcp-clickhouse mcp-clickhouse

COPY app/ .
RUN bun install

CMD ["bun", "start"]
