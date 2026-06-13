# Build the SPA, then serve it from Caddy (which also proxies /api + /ws — see Caddyfile).
FROM node:24-alpine AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2
COPY --from=build /web/dist /srv/www
