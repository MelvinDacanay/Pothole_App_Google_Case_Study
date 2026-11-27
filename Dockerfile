FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Browser keys are public, restricted credentials; never pass server secrets here.
ARG VITE_FIREBASE_API_KEY
ARG VITE_GOOGLE_MAPS_API_KEY
ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
RUN test -n "$VITE_FIREBASE_API_KEY" && test -n "$VITE_GOOGLE_MAPS_API_KEY" && npm run build
FROM node:24.22.3-bookworm-slim
WORKDIR /app
ARG VITE_GOOGLE_MAPS_API_KEY
ENV NODE_ENV=production PORT=3000 VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server.ts /app/firebase-applet-config.json ./
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/dist ./dist
# Include tracked runtime data and shared modules used by server imports.
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/docs ./docs
USER node
EXPOSE 3000
CMD ["npm","start"]
