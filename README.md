# DeepSeek Harness (dsh) — 懒猫微服 LPK 打包源码

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek 开源的
Agent 开发与运行框架，内置 Web UI、一切皆插件）打包成懒猫微服 `.lpk` 应用的完整源码。

- 应用包名：`f00700f.deepseek-harness`
- 当前版本：`1.1.18`
- 上游 dsh 版本：`0.2.1-rc.5`
- 上游项目：https://github.com/deepseek-ai/deepseek-harness

## 目录结构

```
package.yml                 # LPK 包元数据（包名、版本、多语言商店文案、权限）
lzc-build.yml               # lzc-cli 构建配置（contentdir/icon/pkgout）
lzc-manifest.yml            # 懒猫清单：子域名、upstream、文件桥 inject、服务与持久化挂载
icon.png                    # 应用图标

content/
  entry.sh                          # 容器入口：HOME/工作区持久化、xdg-user-dir shim、
                                    #   插件市场对齐、settings/工作区补丁、启动 dsh web
  dsh-proxy.mjs                     # 3080 → 3081 反向代理：免登录 token 自动注入、插件市场图片代理
  patch-dsh-settings.js             # 设置持久化适配盒子分配的应用域名
  patch-dsh-login-origin.js         # 官方账号登录：回拨 origin 钉到容器回环，绕开域名限制
  patch-dsh-market-images.js        # 插件市场缩略图改走应用内代理（第三方图床不可达）
  patch-dsh-working-directory.js    # Agent 默认工作目录指向 Workspace
  patch-dsh-workspace-dirs.js       # 按记录重建旧版本丢失的工作目录
  lazycat-injects/
    lzc-file-chooser-inject.js      # 懒猫文件选择器（打开/保存/下载）注入脚本

image/
  Dockerfile                  # dsh 运行时镜像（node:24 + 全局安装 @deepseek-ai/dsh + 内置插件市场）
  entry.sh                    # 镜像入口：起 dsh web + 取 token + 起 dsh-proxy

scripts/                      # 重启/升级持久化检查脚本、登录补丁自测
deploy-fresh.sh               # 全新安装 + 容器内自检（需本机 lpk-env 与盒子 SSH）
```

## 构建

```bash
# 1) 构建 LPK（需要 lzc-cli）
lzc-cli project release -o dist/f00700f.deepseek-harness-v1.1.18.lpk

# 2) 静态检查
lzc-cli project lint .
lzc-cli lpk lint dist/f00700f.deepseek-harness-v1.1.18.lpk
```

运行时镜像 `registry.lazycat.cloud/wans/dsh-runtime-0-2-1-rc5` 由 `image/Dockerfile` 构建：
`node:24` 基础镜像 + `npm i -g @deepseek-ai/dsh@0.2.1-rc.5` + 预置 `dshmarket` 插件市场模板。
镜像内部的 `/entry.sh` 负责启动 `dsh web`（仅监听 127.0.0.1）、从日志取一次性的访问 token，
再把 `dsh-proxy.mjs` 起在 3080 上对外提供服务；懒猫子域名通过 `--trusted-host` 放行。

## 打包时做的关键适配

1. **持久化**：`/lzcapp/var/data` 挂到 `/data`，`/data/home` 再 bind 到 `/root`（不能用软链，
   否则 dsh 的 `realpath` 归一化会让工作区记录与真路径字符串不等，会话被静默过滤）。
2. **工作区落网盘**：等待平台挂载 `/lzcapp/documents/<user>`，`/data/documents` 指过去，
   Agent 写的文件落在「网盘 → 应用文稿 → DeepSeek Harness → default-workspace」。
3. **xdg-user-dir shim**：Debian 基础镜像没有 `xdg-user-dirs`，首位启动会报
   `Unable to create default workspace`，入口脚本里补一个最小实现。
4. **免 token 登录 Web UI**：`dsh web` 只监听回环，`dsh-proxy` 在首次请求时把启动 token
   注入 URL 并写入同源 cookie，用户直接打开应用即可使用。
5. **文件选择器注入**：把懒猫的打开/保存/下载桥接脚本注入页面，Agent 相关文件操作可直连网盘。
6. **插件市场可用**：镜像内置 `dshmarket`，跨版本升级时按 semver 对齐；缩略图统一走
   `dsh-proxy` 的 `/dsh-img/` 转发。

## 官方账号登录（OAuth）

早期版本这里写的是「OAuth 必然失败，请用 API Key」。**该结论是错的**，实测可以登录，只是最后
一跳需要手工搬运一次 URL。现在仓库自带 `content/patch-dsh-login-origin.js`，入口脚本会自动打上。

### 为什么原本会失败

dsh 的「DeepSeek Account」登录采用 OAuth + PKCE，两端都要求回调地址是**本机回环**：

- 客户端 `packages/client/ui-settings-account/src/client/index.ts`：Web 端把
  `window.location.origin` 作为 `callbackOrigin` 传给 Host。
- Host `packages/credentials/deepseek-account-platform/src/protocol.ts` 的 `loginOrigin()`：
  只接受 `http://{localhost|127.0.0.1|[::1]}:<非零端口>`。
- **平台侧同样如此**：`POST /auth-api/v0/dsh/auth_init` 对非回环 `redirect_uri` 一律返回
  `50005 PAYLOAD_SCHEMA_MISMATCH`（对 12 种形态实测过：端口和路径任意，但 scheme 必须是
  `http:`、host 必须是回环、端口必须显式）。

所以只放开客户端没有用——平台会在下一跳用同一套规则再拒一次。

懒猫应用跑在 `https://dsh.<box>.heiyu.space` 子域名下，`window.location.origin` 是域名，
`loginOrigin()` 直接抛 `PlatformAuthError('protocol')`，点击后弹窗被关闭、日志里连平台请求都没有。

### 真正断的只有最后一跳

回调**不是独立监听端口**，而是注册在 dsh 自己的 HTTP server 上：

```js
webServer.register({ kind: "exact", path: "/oauth/callback", handler })
```

即容器的 3081，随 attempt 开始注册、结束 dispose，`state` 在进程内比对。因此只要 HTTP 请求能
进到 dsh，从哪个 host 进来都算数——实测经 3080 代理带 `host: dsh.<box>` 打通该路径返回
`400`（state 不匹配），证明**回调可以穿过懒猫反代**。

唯一走不通的是：平台把浏览器 302 到 `127.0.0.1:3081`，而在用户电脑上那台 3081 并不存在。

### 现在的做法

`patch-dsh-login-origin.js` 把 Web 端的 `callbackOrigin` 固定成容器自己的回环地址
（默认 `http://127.0.0.1:3081`，可用 `DSH_LOGIN_ORIGIN` 覆盖），两端都能接受，`redirect_uri`
因此变成 `http://127.0.0.1:3081/oauth/callback`。授权页仍在 `platform.deepseek.com`，
只有最后的跳转目标变了。桌面端登录不受影响。

补丁只替换**一个字符串字面量**，且替换值必须匹配平台自己的回环形状，任意 origin 注入不进来；
遇到未知的 bundle 布局或匹配歧义就 fail-closed（`run_patch` 会打警告并继续启动，不会把应用拖死）。
自测：`sh scripts/login-origin-patch-selftest.sh content/patch-dsh-login-origin.js`（在容器内跑，
用合成 bundle，不碰真实安装；17 项断言覆盖正常路径、幂等、覆盖值、拒绝非回环/零端口、无锚点、
歧义锚点）。链路在 dsh `0.2.1-rc.2` + node `v24.22.0` 上实测通过。

登录步骤：

1. Web UI → Settings → Account → 点击登录，在弹出的平台页面完成授权。
2. 授权后浏览器会跳向 `http://127.0.0.1:3081/oauth/callback?code=...&state=...`，
   本机没有这个端口，页面会**加载失败**——这属于预期，**地址栏里的完整 URL 才是要的东西**。
3. 把地址栏 URL 的 `http://127.0.0.1:3081` 换成应用的域名
   `https://dsh.<box>.heiyu.space`，其余（`/oauth/callback?code=...&state=...`）原样保留，回车。
4. 反代把请求送进容器，dsh 校验 `state` 后落库，回到 Settings 即显示已登录。

### 几个容易踩的点

- **只影响登录那一次**。账号 token 没有过期时间、也没有 refresh 流程
  （上游 `deepseek-account/README.md` 的 Known Limitations 原文：
  "Account tokens have no expiry or refresh flow."），存进 `/data/.credentials.yaml` 后
  重启、升级、容器重建都还在，不需要每次开隧道。
- **持久化位置**：`<harness home>/.credentials.yaml` 的 `records` 段，键
  `deepseek-account-platform/default`；本包已把 `/data` 挂到 `/lzcapp/var/data`，所以它活在持久卷里。
- **凭据与回调地址无关**：`Service.init()` 只比对 `issuer`（默认
  `https://platform.deepseek.com`），不看用户当初从哪个地址登录，换成域名访问照样有效。
- **什么时候会掉**：平台返回 401/40003（自动删记录）、用户在 UI 点退出、`/data` 卷被重建、
  或改了 `platformOrigin` 导致 issuer 不匹配。
- **它是长期凭据**：同 UID 的进程可读，别把它同步到网盘；备份可以在卷重建后免重登，但要当作密钥对待。
- **想彻底不搬运 URL**：可以在自己电脑上开一条隧道
  （`ssh -L 3081:127.0.0.1:3081 <box>`）后再登录，浏览器就能自己走完回调；代价是首次登录要通一次。

仍然可以沿用 API Key：Web UI → Settings → Models → DeepSeek（API Key）或其他 OpenAI 兼容
服务商，填 Key 保存即可。

## License

本仓库的打包脚本与配置以 MIT 协议发布；`dsh` 本身及内置的 `dshmarket`、文件选择器脚本
遵循其各自的上游许可证。
