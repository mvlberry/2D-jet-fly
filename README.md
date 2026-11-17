# 2D Jet Fly

这是一个用于学习和测试的私有工作副本，可在浏览器中运行像素风战斗机飞行演示。

## 来源与作者声明

- 原始作品：[fighter · Forge](https://forge.ui8.ai/share/frag_1eb8944c-57b1-42ca-a909-5c2d7e517c24)
- 原始在线演示：[fly.ui8.dev](https://fly.ui8.dev/)
- 当前 Forge 私有 Remix：[fighter](https://forge.ui8.ai/projects/frag_bbe3b8f9-c928-4990-b83a-43b0cde26214)

本仓库维护者 **不是原始作品作者**。原始游戏代码、图片、音频及相关创作的权利归其各自权利人所有。本仓库仅保存通过原始 Forge 分享页的 Remix 功能取得的私人工作副本。

本仓库没有为原始作品重新授予 MIT、Apache-2.0 或其他开源许可证，也不应被视为原作者的官方仓库。未经原始权利人明确许可，请勿公开再分发源码或资源。

## 本地适配

为了在 Forge 之外运行，当前副本增加了：

- Vite + React 独立站点入口
- Tailwind CSS 构建配置
- 支持部署到子目录的相对资源路径
- TypeScript 类型检查和生产构建脚本

## 开发与构建

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

构建产物位于 `dist/`。请通过 HTTP 服务器访问，不要直接使用 `file://` 双击打开 HTML。

## 许可状态

原始作品未附带可验证的开源许可证。详见 [SOURCE_AND_RIGHTS.md](./SOURCE_AND_RIGHTS.md)。
