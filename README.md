# Deploy-Vercel 🚀

基于 **Vercel Serverless** 平台的高性能多协议代理节点服务与智能订阅生成器。

支持 **VLESS (WS)**、**Trojan (WS)** 与 **Shadowsocks (WS)** 三大主流协议，内置高保真伪装站、DNS 内存加速缓存与 Cloudflare 优选 IP 智能生成。

---

## 🌟 核心特性与优化提升

| 功能特性 | 原版状态 | 完善优化后状态 |
| :--- | :--- | :--- |
| **配置方式** | 需手动修改 `index.js` 源代码 | **100% 环境变量配置**，无需改动任何源码，开箱即用 |
| **代码混淆/安全** | 引导用户去第三方在线工具混淆代码 | **无后门纯净开源**，切断向未知名保活平台泄露私有订阅的行为 |
| **连接稳定性** | 目标连接失败时不销毁 WebSocket，导致内存泄漏挂死 | **双向全生命周期流管理**，自动超时释放，杜绝内存与句柄耗尽 |
| **异常防护** | VLESS 解包缺少防御，畸形包会导致整个 Node 进程崩溃 | **全协议多层 `try...catch` 防御**，抵御非法嗅探与探测请求 |
| **DNS 解析** | 每次出站连接均实时发起一次 DoH 请求，延迟高且易阻塞 | **内置 5 分钟 DNS TTL 高速缓存** + Google/Cloudflare 并行回退 |
| **优选 IP 支持** | 只能生成 Vercel 域名节点，需用户手动挨个修改节点地址 | **原生支持 `CF_IP` 环境变量与 `?ip=xxx` 参数**，直接生成优选 CDN 节点 |
| **订阅格式** | 仅输出单一 Base64 编码 | 支持 **标准 Base64 订阅** 与 **`?raw=1` 浏览器明文直读模式** |
| **国内直连反代** | 原反代脚本缺失 `Host` 请求头修正，导致 Vercel 频发 404 | 提供 **专业级 Cloudflare Worker 反代脚本 (`cf-worker.js`)** |

---

## 🛠️ 环境变量完整参考 (Environment Variables)

在 Vercel 控制台的项目设置中即可配置，**无需修改任何代码**：

| 环境变量名 | 默认值 | 是否必填 | 作用说明 |
| :--- | :--- | :---: | :--- |
| `UUID` | 自动生成或默认 | **强烈建议填写** | 节点核心身份凭证（UUID 格式，VLESS/Trojan/SS 密码均使用此值） |
| `DOMAIN` | 自动识别当前 Host | 选填 | 节点绑定的域名（填写反代域名或自定义域名，如 `my-proxy.workers.dev`） |
| `CF_IP` | 空 | 选填 | **Cloudflare 优选 IP 或优选域名**（如 `visa.cn`、`cf.090227.xyz` 等），配置后自动生成优选加速节点 |
| `SUB_PATH` | `vercel` | 选填 | 节点订阅的访问路径（例如设为 `mysecret`，则订阅地址为 `/mysecret`） |
| `WSPATH` | UUID 前 8 位 | 选填 | WebSocket 传输路径（默认截取 UUID 前 8 位） |
| `NAME` | `Vercel` | 选填 | 节点在客户端中显示的名称前缀 |
| `PORT` | `3000` | 选填 | 本地或容器内监听的端口号（Vercel 上会自动管理） |
| `NEZHA_SERVER` | 空 | 选填 | 哪吒探针服务端地址（格式 `nz.example.com:443` 或 `nz.example.com:5555`） |
| `NEZHA_KEY` | 空 | 选填 | 哪吒探针客户端通信密钥 |
| `SHOW_LOG` | `false` | 选填 | 是否打印调试日志（设为 `true` 开启） |

---

## 🚀 5 分钟极速部署教程

### 第一步：Fork 或导入本仓库
1. 点击 GitHub 右上角的 **Fork** 将本仓库复制到你的个人账号（建议设为 **Private 私密仓库**）。

### 第二步：导入到 Vercel
1. 打开 [Vercel 官方控制台](https://vercel.com/dashboard) 并登录。
2. 点击 **“Add New...” ➡ “Project”**。
3. 在 Import Git Repository 列表中找到刚刚 Fork 的仓库，点击 **“Import”**。

### 第三步：配置环境变量与部署
1. 展开 **“Environment Variables”** 面板，添加以下变量：
   - `UUID`：填写你专属的 UUID（可以在 [uuidgenerator.net](https://www.uuidgenerator.net/) 在线生成）。
   - `NAME`：给你的节点起一个名字（如 `MyNode`）。
2. 在 **Build and Output Settings** 中保持默认即可（Install Command 会自动识别执行 `npm install`）。
3. 点击 **“Deploy”**，等待 1~2 分钟直到部署完成。

### 第四步：获取节点订阅
- 部署成功后，Vercel 会为你分配一个官方二级域名（如 `https://your-project.vercel.app`）。
- 打开浏览器访问：
  - **伪装主页**：`https://your-project.vercel.app/`（正常显示环保主题官网）
  - **节点订阅**：`https://your-project.vercel.app/vercel`（复制此链接直接导入客户端）
  - **明文直读**：`https://your-project.vercel.app/vercel?raw=1`（浏览器直接查看生成的节点明文链接）

---

## ⚡ 解决国内无法直连问题（Cloudflare Worker 反代教程）

> [!IMPORTANT]
> 由于 `*.vercel.app` 官方域名在大陆被阻断，直接连接会导致握手超时。  
> 推荐通过 **Cloudflare Workers** 反向代理并配合 **优选 IP** 获得毫秒级访问体验。

### 使用 Cloudflare Worker 反向代理：
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) ➡ **Compute (Workers & Pages)** ➡ **Create application** ➡ **Create Worker**。
2. 将仓库中 [`cf-worker.js`](./cf-worker.js) 的全部内容复制粘贴到 Worker 编辑器中。
3. 修改开头的 `VERCEL_DOMAINS` 为你在 Vercel 上部署成功的域名：
   ```javascript
   const VERCEL_DOMAINS = [
     'your-project-name.vercel.app',
   ];
   ```
4. 点击 **Save and Deploy**。
5. 部署完成后，在 Vercel 项目的 **Settings ➡ Environment Variables** 中：
   - 将 `DOMAIN` 设置为你为 Worker 绑定的自定义域名（例如 `my-worker.yourdomain.com`；注意：若使用默认 `workers.dev` 域名，Cloudflare 官方限制不允许直连优选 IP）。
   - 重新点击 Vercel 的 **Redeploy** 重新部署一次。
6. 以后直接使用 `https://你的Worker域名/vercel` 获取订阅即可！

### 配合优选 IP 极致加速：
如果你有高速的 Cloudflare CDN 优选 IP/域名（例如 `visa.cn`, `cf.090227.xyz`）：
- **方法 1（全局配置）**：在 Vercel 环境变量中添加 `CF_IP = visa.cn`。
- **方法 2（动态参数）**：在订阅链接后面直接加上 `?ip=visa.cn`，例如：
  ```text
  https://你的Worker域名/vercel?ip=visa.cn
  ```
  导出的订阅中将**自动同时包含直连节点与 CDN 优选加速节点**！

> [!NOTE]
> **优选 IP 使用前提**：Cloudflare Anycast 优选 IP 仅接收属于 Cloudflare 自身网络的 SNI 证书。因此必须将环境变量 `DOMAIN` 设置为**接入了 Cloudflare 的自定义域名或绑定了自定义域名的 Cloudflare Worker**，不能直接使用未过 CDN 的 `*.vercel.app` 域名，否则 Cloudflare 会拒绝 TLS 握手。

---

## 🌍 Vercel 优质节点部署地区推荐

在 `vercel.json` 中的 `regions` 字段可自由选择部署机房，推荐选用对亚太网络友好的区域：

| 地区代码 | 城市 | 推荐指数 | 说明 |
| :---: | :---: | :---: | :--- |
| `sin1` | 新加坡 (Singapore) | ⭐⭐⭐⭐⭐ | 亚太首选，国内延迟极佳，推荐默认 |
| `hnd1` | 日本东京 (Tokyo) | ⭐⭐⭐⭐⭐ | 东亚首选，延迟低，联通/电信友好 |
| `kix1` | 日本大阪 (Osaka) | ⭐⭐⭐⭐ | 日本备用机房 |
| `icn1` | 韩国首尔 (Seoul) | ⭐⭐⭐⭐ | 韩国节点 |
| `sfo1` | 美国旧金山 (San Francisco) | ⭐⭐⭐⭐ | 美西节点，稳定性极佳 |
| `iad1` | 美国华盛顿 (Washington D.C.) | ⭐⭐⭐ | 美东节点 |
| `fra1` | 德国法兰克福 (Frankfurt) | ⭐⭐⭐ | 欧洲枢纽 |

*(注：部分冷门区域如 `dxb1`, `jnb1`, `cpt1` 在 Vercel 免费用量下限制较多，请避免选填)*

---

## 📱 客户端导入方法

- **v2rayN / v2rayNG**：点击 `订阅设置` ➡ `添加` ➡ 粘贴订阅 URL ➡ 保存并更新订阅。
- **Shadowrocket (小火箭)**：首页右上角 `+` 号 ➡ 类型选择 `Subscribe` ➡ 粘贴订阅 URL ➡ 点击完成。
- **Clash Verge / Mihomo Party / Sing-box**：直接将订阅链接粘贴进在线订阅转换器（如 [Subconverter](https://sub.xeton.dev/)），选择对应客户端配置后下载即可。

---

## ⚠️ 注意事项与防封建议

1. **合理使用流量**：Vercel 属于前端与 Serverless 托管平台，免费账户每月有 100GB 基础流量额度，请勿用于长时间大流量 P2P 下载或挂机挖矿，避免触发 Fair Use 限制被封号。
2. **探针功能说明**：哪吒探针在无常驻守护进程的 Serverless 容器中可能会休眠断连（这是 Serverless 平台按需调度的特性），建议作为轻量节点使用；如需 7×24 小时常驻探针，推荐部署在传统 VPS 或 Docker 容器中。
3. **保持私密**：请确保你的 GitHub 仓库为 **Private**，避免敏感的 UUID 或自定义域名在公开代码库中暴露。
