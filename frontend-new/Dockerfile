FROM node:20-alpine AS builder

WORKDIR /app

COPY frontend-new/package*.json ./
RUN npm ci

COPY frontend-new ./
RUN npm run build

FROM nginx:1.27-alpine

COPY frontend-new/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
