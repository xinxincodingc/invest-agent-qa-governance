FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci --omit=dev
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
