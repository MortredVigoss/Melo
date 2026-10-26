FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/melo
COPY package.json package-lock.json binding.gyp ./
COPY native ./native
RUN npm ci --no-audit --no-fund
# Runtime workers receive neither the build context nor network credentials.
# Dependencies and the Linux native addon remain in the read-only image.
