FROM node:20-alpine
WORKDIR /app
COPY package.json .
# No npm install needed — zero dependencies
COPY index.js .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
