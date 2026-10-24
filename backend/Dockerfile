# 校園剩食系統：後端 API ＋ 前端靜態檔（同一個程序一起服務）。
#
# build context 必須是 lunch-leftovers 目錄，不是 backend：
#   docker build -f backend/Dockerfile -t lunch-api .
# 因為 server.js 是用 express.static(path.join(__dirname, '..')) 服務前端，
# 也就是 index.html / app.js / style.css 都在 backend 的**上一層**。
# 只複製 backend 進去的話，網頁會 404 而 API 看起來卻是好的——很難查。
FROM node:20-slim

WORKDIR /srv/lunch-leftovers

# 先裝相依，讓程式碼變動不必重裝套件
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# 後端
COPY backend ./backend

# 前端（server.js 會從上一層服務這些檔案）
COPY index.html app.js firebase-config.js style.css ./

# 不用 root 跑。node 映像自帶 node 使用者。
USER node

WORKDIR /srv/lunch-leftovers/backend
ENV NODE_ENV=production \
    PORT=8787

EXPOSE 8787

# 健康檢查用後端自己的 /health（server.js 有定義）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
