# Multistage build: API + static frontend in one container
# Stage 1: install server deps
FROM node:20-alpine AS server
WORKDIR /app
COPY server/package.json ./server/
# Use npm install instead of npm ci because there's no lockfile in repo
RUN cd server && npm install --omit=dev
COPY server ./server

# Stage 2: collect frontend (static)
COPY frontend /app/public

# Final image
FROM node:20-alpine
WORKDIR /app

# Copy server and public from previous stage
COPY --from=server /app/server ./server
COPY --from=server /app/public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/server.js"]
