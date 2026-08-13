# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 node:24.6.0-bookworm-slim@sha256:9b741b28148b0195d62fa456ed84dd6c953c1f17a3761f3e6e6797a754d9edff

ARG CHROME_FOR_TESTING_VERSION=151.0.7922.108
ARG CHROME_FOR_TESTING_SHA256=c4d5c13b015e84a0d9b575e4ac681a1dfd93db9484e7e4cb26cc2ecc225cedea
ARG XVFB_VERSION=2:21.1.7-3+deb12u12
ARG PNPM_VERSION=10.8.0

ENV DEBIAN_FRONTEND=noninteractive
ENV CHROME_FOR_TESTING_VERSION=${CHROME_FOR_TESTING_VERSION}
ENV CHROME_FOR_TESTING_SHA256=${CHROME_FOR_TESTING_SHA256}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      "xvfb=${XVFB_VERSION}" \
      ca-certificates \
      curl \
      dbus-x11 \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      unzip \
      xauth \
    && curl --fail --silent --show-error --location \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip" \
      --output /tmp/chrome-linux64.zip \
    && printf '%s  %s\n' "${CHROME_FOR_TESTING_SHA256}" /tmp/chrome-linux64.zip | sha256sum --check --strict \
    && mkdir -p /opt/google/chrome-for-testing \
    && unzip -q /tmp/chrome-linux64.zip -d /opt/google/chrome-for-testing \
    && chown root:root /opt/google/chrome-for-testing/chrome-linux64/chrome_sandbox \
    && chmod 4755 /opt/google/chrome-for-testing/chrome-linux64/chrome_sandbox \
    && ln -s /opt/google/chrome-for-testing/chrome-linux64/chrome /usr/bin/google-chrome \
    && google-chrome --version \
    && dpkg-query --show --showformat='${Version}\n' xvfb \
    && rm -f /tmp/chrome-linux64.zip \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && pnpm --version \
    && groupadd --gid 10001 newton \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash newton \
    && mkdir -p /results /work \
    && chown newton:newton /results /work

COPY scripts/smoke/linux-chrome-live/entrypoint.sh /usr/local/bin/newton-linux-chrome-live
COPY scripts/smoke/linux-chrome-live/prepare-workspace.mjs /usr/local/lib/newton-prepare-workspace.mjs
COPY scripts/smoke/linux-chrome-live/harness-receipt.mjs /usr/local/lib/newton-harness-receipt.mjs
COPY scripts/smoke/linux-chrome-live/bounded-command.mjs /usr/local/lib/newton-bounded-command.mjs
RUN chmod 0755 /usr/local/bin/newton-linux-chrome-live

USER newton
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/newton-linux-chrome-live"]
