FROM node:22-slim AS deps
WORKDIR /srv/web
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /srv/web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /srv/web/node_modules ./node_modules
COPY . .
ARG BACKEND_URL=http://api:8000
ENV BACKEND_URL=$BACKEND_URL
RUN npm run build

FROM node:22-slim
WORKDIR /srv/web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system app && useradd --system --gid app --no-create-home app
COPY --from=build /srv/web/.next/standalone ./
COPY --from=build /srv/web/.next/static ./.next/static
COPY --from=build /srv/web/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
# Note: the working directory must not be "/app" — Next.js mis-resolves the root layout when the
# project root is /app and the routes live in app/app/ (reproduced with Next 15.5).
