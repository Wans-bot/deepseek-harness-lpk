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
  patch-dsh-market-images.js        # 插件市场缩略图改走应用内代理（第三方图床不可达）
  patch-dsh-working-directory.js    # Agent 默认工作目录指向 Workspace
  patch-dsh-workspace-dirs.js       # 按记录重建旧版本丢失的工作目录
  lazycat-injects/
    lzc-file-chooser-inject.js      # 懒猫文件选择器（打开/保存/下载）注入脚本

image/
  Dockerfile                  # dsh 运行时镜像（node:24 + 全局安装 @deepseek-ai/dsh + 内置插件市场）
  entry.sh                    # 镜像入口：起 dsh web + 取 token + 起 dsh-proxy

scripts/                      # 重启/升级持久化检查脚本
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

## 已知限制：官方账号登录（OAuth）不可用

dsh 的「DeepSeek Account」登录采用 OAuth + PKCE，**回调地址必须是浏览器可访问的本机回环地址**，
设计上不支持域名反向代理。上游源码位置：

- `packages/client/ui-settings-account/src/client/index.ts`：Web 端把 `window.location.origin`
  作为 `callbackOrigin` 传给 Host。
- `packages/credentials/deepseek-account-platform/src/protocol.ts` 的 `loginOrigin()`：
  只接受 `http://localhost:<port>`、`http://127.0.0.1:<port>`、`http://[::1]:<port>`，
  其余一律抛 `PlatformAuthError('protocol')`。
- `packages/credentials/deepseek-account-platform/src/index.ts`：`/oauth/callback` 路由注册在
  Host 自己的 webServer 上，`redirect_uri` 就是上述回环地址。

懒猫应用通过 `https://dsh.<box>.heiyu.space` 子域名反代访问，容器内的 `localhost` 并不是用户
浏览器的 `localhost`，因此该登录方式在懒猫上必然失败（点击后弹窗被关闭，界面显示登录失败）。

**请使用 API Key 配置模型**：打开 Web UI → Settings → Models → 选择 DeepSeek（API Key）或其他
OpenAI 兼容服务商，填入 Key 后保存即可。

## License

本仓库的打包脚本与配置以 MIT 协议发布；`dsh` 本身及内置的 `dshmarket`、文件选择器脚本
遵循其各自的上游许可证。
