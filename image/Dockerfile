# dsh runtime image — reproduced from the 0.2.1-rc.2 image history on box wans.
#
# Build host notes (box wans, 2026-10-29):
#   * Docker Hub is unreachable (IPv6 dial timeout) → use the daocloud mirror for the base.
#   * The lzc-docker daemon runs with "bridge": "none", so buildx MUST use --network host,
#     otherwise every RUN fails with `network bridge not found`.
#   * entry.sh here is the IMAGE launcher (dsh web + token + dsh-proxy). The LPK's
#     content/entry.sh is a different file (the LazyCat wrapper) and must NOT be copied here:
#     it ends with `exec /entry.sh`, so shipping it as /entry.sh recurses forever.
FROM docker.m.daocloud.io/library/node:24.22.0-bookworm
ARG DSH_VERSION=0.2.1-rc.5
ARG DSMARKET_VERSION=1.66.42
RUN apt-get update \
 && apt-get install -y --no-install-recommends socat ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN test -n "$DSH_VERSION" \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && dsh --version \
 && rm -rf /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/.cache
COPY entry.sh /entry.sh
RUN chmod 0755 /entry.sh
COPY dsh-proxy.mjs /dsh-proxy.mjs
COPY profile-template /opt/dsh-profile-template
RUN set -eu; \
    T=/opt/dsh-profile-template/profiles/web; \
    if [ -n "${DSMARKET_VERSION}" ]; then \
      sed -i "s/\"dshmarket\": \"[^\"]*\"/\"dshmarket\": \"${DSMARKET_VERSION}\"/" "$T/package.json"; \
    fi; \
    cd "$T"; \
    npm install --no-audit --no-fund --omit=dev 2>&1 | tail -5; \
    node -e "console.log('vendored dshmarket', require('$T/node_modules/dshmarket/package.json').version)"; \
    rm -rf "$T/node_modules/.cache" "$T/package-lock.json"
ENV DSH_HOME=/data
WORKDIR /data
EXPOSE 3080
CMD ["node"]
