FROM node:18-alpine

RUN apk add --no-cache jq bash python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --production && apk del python3 make g++

COPY server.js ./
COPY public/ ./public/
COPY run.sh /

RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
