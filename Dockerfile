FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_REPO_URL
ENV NEXT_PUBLIC_REPO_URL=$NEXT_PUBLIC_REPO_URL
RUN npm run build
FROM caddy:2-alpine
COPY --from=build /app/out /srv
COPY Caddyfile /etc/caddy/Caddyfile
