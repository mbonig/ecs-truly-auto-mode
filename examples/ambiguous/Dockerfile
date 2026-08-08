FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# Stale: the app actually binds 4000. Metrics really do run on 9090.
EXPOSE 8080
EXPOSE 9090
CMD ["node", "src/index.js"]
