ARG RUNTIME_IMAGE=ghcr.io/lucasmeijer/agents-in-the-cloud-docker@sha256:149efe3189255442091157921511b6c122b0254bb07e24d08d24408b4b79deda
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun
FROM ghcr.io/tailscale/tailscale:v1.102.3@sha256:8c42c4574ab066384fcb72f69e086a2ff1dd3652eb6f56856cee34bcf0d2f680 AS tailscale
FROM ${RUNTIME_IMAGE}
# Keep incident-response tools in the System image, not the shared Docker runtime.
# Profiling needs host kernel support/permissions; installing systemd only supplies
# its diagnostic commands (the container still runs the AgentsInTheCloud supervisor).
RUN apt-get update && apt-get install -y --no-install-recommends \
    atop bpfcc-tools bpftrace btop coreutils dnsutils htop iftop \
    iotop-c iproute2 iputils-ping linux-perf lsof mtr-tiny ncdu nethogs \
    nftables procps psmisc smem strace sysstat systemd tcpdump tmux util-linux \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.source="https://github.com/lucasmeijer/atelier" \
      org.opencontainers.image.title="AgentsInTheCloud System"
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY .build/supervisor.js .build/client.js .build/design-system.css /opt/agents-in-the-cloud-system/
# supervisor.js resolves ../proto/workspace_helper.proto from its own directory.
COPY .build/proto/workspace_helper.proto /opt/proto/workspace_helper.proto
ENTRYPOINT ["/usr/bin/tini", "--", "bun", "/opt/agents-in-the-cloud-system/supervisor.js"]
CMD []
