# stage 1 - BUILD THE BASE

FROM node:16-alpine as base
WORKDIR /app
COPY src ./src
COPY package*.json ./
COPY tsconfig*.json ./
RUN npm install

# stage 2 - BUILD THE APP

FROM base as build
WORKDIR /app
RUN npm run build

# stage 3 - PRODUCTION

FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only-production
COPY --from=build /app/build ./
CMD ["node", "main.js"]