# 路书

个人旅行记录。页面是静态的，放在 GitHub Pages 上；日志和照片存在同一个仓库里。访客只读这些文件。写作在浏览器里完成，用你自己的 GitHub 令牌把一次记录提交进去，不需要另外的服务器。

## 怎么工作

- 阅读：浏览器向仓库读取 `content` 分支上的 `content/index.json`、每篇的 `journal.md` 和照片。这个分支还没有时，先读 `main`。
- 写作：浏览器持有令牌，调用 `api.github.com`，把正文和照片合成一次提交，写到 `content` 分支。网页仍由 `main` 发布。
- 令牌只放在这台浏览器的 localStorage，不会写进仓库。没有令牌的人打不开写权限。

GitHub Pages 上的网站是公开的。令牌保护的是“谁能改仓库”，不是“谁能看网页”。

## 启用

1. 把这个目录推到一个公开仓库。仓库不能是空的，这次推送就是第一次提交。
2. 仓库 Settings → Pages → Build and deployment，选 Deploy from a branch，分支 `main`，目录 `/ (root)`。
3. 打开 [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)，只选这一座仓库，Repository permissions 里把 Contents 设为 Read and write。
4. 等 Pages 地址可以打开后，点页面上的「设置」。用户名和仓库默认是 `javamr123` / `mylife`，粘贴令牌后点连接。
5. 写日志。照片会先在浏览器里压成较小的 JPG，再和正文一起提交。

发布一篇日志只更新 `content` 分支，Pages 不会因此重新发布。访客读的就是仓库里的这次提交。

本地预览：

```bash
python3 -m http.server 5173
```

然后打开 `http://127.0.0.1:5173`。设置里的用户名和仓库默认已填好。

## 限制

- 浏览器必须能直接访问 `api.github.com` 和 `raw.githubusercontent.com`。
- 不要把令牌发到聊天、截图或仓库里。公用电脑用完后点「清除令牌」。令牌泄露了，去 GitHub 把它撤销。
- 适合个人记录。照片会压缩，不适合当原片仓库。GitHub 对仓库体积有限制。
- 一次最多 24 张照片。GIF 不会被重新压缩，太大的会被拒绝。
