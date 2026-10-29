# syntax=docker/dockerfile:1
# One image for the relayer, the front-end API and the operator commands - compose.yaml picks which
# entry point each container runs.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
# A broken build or failing test stops the image from being built, so it never reaches `up`.
RUN npm run typecheck && npm test && npm run build

FROM node:22-bookworm-slim
WORKDIR /opt/xon-relayer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# A fixed non-root uid with no matching account on the host, so only root (and this container) can
# read the state directory and key file once they're chowned to it - see "Running on a server".
RUN groupadd --system --gid 10001 xonrelayer \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin xonrelayer
USER 10001:10001

ENV CHECKPOINT_DIR=/var/lib/xon-relayer
CMD ["node", "dist/index.js"]
