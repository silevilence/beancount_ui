# 应用图标

日用账本使用琥珀色账本与豆形镂空组成的图标，沿用界面的琥珀配色。原图及全部 PNG、ICO 都使用真实透明背景，书脊间隙和豆形镂空也透明。

## 资源与入口

| 资源 | 用途 |
| --- | --- |
| `assets/app-icon.png` | 生成原图，所有尺寸的唯一来源 |
| `frontend/public/icons/app-icon-64.png` / `app-icon-128.png` | 工作台与访问页共用的 `Brand` 组件、README |
| `frontend/public/icons/app-icon-192.png` / `app-icon-512.png` | 浏览器大图标、Web App Manifest 的应用/快捷方式图标 |
| `frontend/public/favicon.ico` | 浏览器标签、收藏夹、Windows 手动设置快捷方式、Swagger UI 与 ReDoc 标签 |
| `frontend/public/apple-touch-icon.png` | 180×180 的 Apple 主屏幕图标 |
| `frontend/public/site.webmanifest` | 应用名称、启动地址、图标与窗口主题色 |

ICO 包含 16、24、32、48、64、128、256 像素版本。透明图标只声明 `any` 用途，不声明要求实心安全背景的 `maskable`。系统可能自行给主屏幕图标添加底色或遮罩；图片资源本身保持透明。Manifest 提供应用元数据，不增加离线缓存。

Vite 会将 public 资源原样复制进生产构建，现有 Docker 构建自动包含它们。FastAPI 使用同一套资源；源码开发尚无 dist 时，从 public 提供图标。图标在私网模式登录前可加载，API 文档仍受原访问认证保护。

NAS 中手动创建网页入口时，可上传 512 像素 PNG；Windows 手动设置快捷方式可选择 ICO。仓库没有原生桌面安装包或 NAS 启动器配置。更新现有部署需要重新构建并部署；已缓存的收藏夹/主屏幕图标可能需要重新添加入口。

## 重建

在仓库根目录运行：

```powershell
uv run --script scripts/build_icons.py
npm --prefix frontend run build
```

脚本用独立声明的 Pillow 依赖缩放和封装已有原图，保留 alpha，不调用生成服务，也不新增运行时依赖。更新设计时先替换原图，再执行脚本。

## 生成记录

2026-10-05 使用内置 imagegen 生成，然后按用户要求将背景及深色镂空改为透明；未使用 CLI/API 后备模式。最终采用第二次输出。

初始提示词：

```text
Use case: logo-brand
Asset type: production app icon for 日用账本 (The Daily Ledger), a local-first Beancount bookkeeping web app.
Primary request: Create one polished, distinctive square application icon, a simple upright closed ledger book with an elegant bean-shaped negative-space inset on its cover, communicating daily bookkeeping. Bold readable silhouette at 16px. One large centered amber-gold ledger symbol, a short subtle spine and two thick ledger lines, restrained geometric design.
Style: precise flat vector-like icon, premium quiet productivity software, crisp curves, no 3D, no shadows, no texture, no mockup.
Color palette: amber #ffb454 and pale gold #ffd479 on solid deep midnight navy #10161f, matching the existing app.
Composition: square 1024x1024 full-bleed solid navy background, no rounded outer corners, no frame; all symbol artwork within the central 64 percent of canvas so the icon is safe for circular and rounded-square OS masks. Symbol strong and clear.
Text: no text, no letters, no numbers, no watermark. Deliver a single icon, not a presentation sheet.
```

最终透明化编辑提示词（`transparent_background: true`）：

```text
Edit the attached Daily Ledger application icon. Remove the entire dark navy background to genuine alpha transparency, including all dark negative spaces inside the book, the bean-shaped cover cutout and gaps around the spine and page lines. Keep the amber/gold book shape, pale golden bean highlight, proportions, arrangement and crisp smooth edges unchanged. The final icon must have a truly transparent background, not a checkerboard or white fill. Keep the square canvas. No new objects, no text, no border, no drop shadow. This is a production app icon and all navy pixels must become transparent while preserving the golden artwork.
```
