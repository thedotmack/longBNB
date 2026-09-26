FROM node:20-slim
WORKDIR /app
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
