FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 6969

ENV PORT=6969

CMD ["npm", "start"]
