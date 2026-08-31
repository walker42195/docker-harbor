# glibc-bas (inte alpine/musl): nvidia-container-toolkit injicerar
# glibc-länkade binärer, så nvidia-smi kan inte köras på Alpine.
FROM node:20-slim

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 6969

ENV PORT=6969

CMD ["npm", "start"]
