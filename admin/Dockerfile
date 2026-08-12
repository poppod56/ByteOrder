FROM node:20-slim AS builder
# Update npm to get patched bundled deps (tar, minimatch, glob, cross-spawn).
# Pinned to a major: npm@latest has moved to a release that requires Node >=22
# and breaks the build on this base image.
RUN npm install -g npm@11
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci
COPY . .
RUN npm run build && \
    npm prune --omit=dev

FROM node:20-slim
# Update npm to get patched bundled deps in the runtime image too.
# Pinned to a major: npm@latest has moved to a release that requires Node >=22
# and breaks the build on this base image.
RUN npm install -g npm@11
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY server ./server
COPY --from=builder /app/dist ./dist
USER node
EXPOSE 3001
CMD ["node", "server/index.js"]
