ARG BUILD_FROM
FROM $BUILD_FROM

RUN apk add --no-cache nodejs npm jq bash

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/
COPY run.sh /

RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
