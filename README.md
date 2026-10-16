# Yizima 的电影手帐

一个原生 HTML/CSS/JavaScript 静态个人影音收藏页，适配 Vercel 静态托管。首页包含电影分组展开、剧照、摄影手记、视频和音乐。

## 共享留言板

- 首页底部留言由 Supabase 项目 `supabase-amber-paddle` 共享保存，留言不要求姓名/邮箱，公开留言只显示内容和时间；留言表不存访客 IP。
- 浏览器只用 Supabase publishable key；留言表启用 RLS，访客只能读取，通过 `submit_guestbook_message` RPC 写入，服务端按匿名浏览器 ID 设置 30 秒冷却（清除浏览器本地存储会重置该 ID）。
- 留言为纯文本，长度限制 1–280 字；前端以 `textContent` 渲染。公开留言可被所有访客阅读。
- 数据库结构与权限脚本位于 `supabase/migrations/20261016_guestbook.sql`。

## 本地预览

直接用本地静态服务器打开目录即可，例如：

```bash
python3 -m http.server 8000
```

然后访问 `http://localhost:8000`。

## 私密公众号草稿编辑器

- 编辑入口：`/admin.html`（页面带 `noindex,nofollow`，但核心访问保护由服务端会话负责）。
- 先以独立后台密码登录，再填写标题、作者、摘要、正文并上传封面/正文图片。
- 保存动作只会调用微信 `draft/add` 将内容存入公众号草稿箱；不会调用发布接口。最终是否发布由站长在公众号平台审核并手动操作。
- 微信 AppSecret、管理员密码和会话签名密钥仅能保存在 Vercel 项目 server-side environment variables，不能使用 `NEXT_PUBLIC_`、`VITE_` 等公开前缀，也不得提交到 Git。

需要在 Vercel 项目设置里由站长安全填写以下变量，并部署后 Function 才可读取：

| 环境变量 | 用途 |
| --- | --- |
| `WECHAT_APPID` | 公众号 AppID |
| `WECHAT_APPSECRET` | 公众号 AppSecret |
| `ADMIN_PASSWORD` | 草稿编辑器独立登录密码 |
| `SESSION_SECRET` | 服务端登录会话签名密钥（使用高熵随机值） |

## 微信图片和草稿

正文图片通过微信上传图文图片接口获取公众号认可的 URL（JPG/PNG，≤1 MB）；封面图先上传为永久图片素材以取得 `thumb_media_id`（编辑器限制 ≤4 MB，以兼容 Vercel Function 请求体限制）；保存文章调用草稿新增接口。草稿成功不代表已经发布。

## 媒体来源

剧照、视频和音乐通过 `https://github.com/yizima0079-web/gallery-videos` 的公开 raw 文件地址加载。17 张摄影照片已随站点保存在 `assets/images/`；视频和音频均需用户主动点击后播放。

## 部署

将 GitHub 仓库导入 Vercel，根目录为项目目录，静态文件无需单独构建。`api/wechat.mjs` 为 Vercel Node.js Function，处理密码会话、微信图片上传和新增草稿。

部署后先检查首页和 `/admin.html`。环境变量缺失时后台会显示服务端配置未完成；请在 Vercel 设置变量后重新部署。不要在聊天或浏览器代码里粘贴 AppSecret、后台密码或会话签名值。
