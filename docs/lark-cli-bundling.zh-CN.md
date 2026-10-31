# 内置 lark-cli：打包、运行与卸载策略

飞书连接器（导出/导入）依赖 lark-cli。本文件说明 **内置 CLI 如何随应用安装/卸载**、
**它与用户电脑自带 CLI 的关系**，以及 **环境变量的继承与隔离**。

代码位置：

| 环节 | 文件 |
| --- | --- |
| 构建准备（下载 + 校验 + manifest） | `apps/desktop/scripts/prepare-lark-cli.mjs` |
| 运行时解析 / 环境隔离 | `apps/desktop/src/main/runtime/lark-cli-runtime.ts` |
| 授权运行器（`config init` / `auth login`） | `apps/desktop/src/main/agent-auth/lark-auth-runner.ts` |
| 网关侧执行器（导出/导入命令） | `apps/gateway/src/modules/documents/agent-export/lark-cli-environment.ts` |
| 卸载清理（Windows） | `apps/desktop/build/installer.nsh` |

## 1. 分发链路（安装包内置）

```
@larksuite/cli@<version>（devDependency，npm 包只是引导器）
  └─ node scripts/prepare-lark-cli.mjs
       ├─ 二进制：node_modules/@larksuite/cli/bin/lark-cli(.exe)
       ├─ 拷贝到：apps/desktop/build/lark-cli/<platform>-<arch>/lark-cli(.exe)
       └─ manifest：build/lark-cli/<platform>-<arch>/manifest.json
              { version, platform, arch, sha256, size, preparedAt }
  └─ electron-builder extraResources：build/lark-cli → <app>/Resources/lark-cli
```

- `prepare-lark-cli.mjs` 在 `dev` / `package:mac` / `package:win` 前执行；**运行时不下载任何东西**。
- manifest + sha256 校验通过时直接复用已有二进制（离线构建/重复构建不重新下载）。
- 拷贝后校验 `lark-cli --version` 必须与 npm 包版本一致，否则构建失败（避免装错版本）。
- 排障开关：
  - `LARK_CLI_PREPARE_FORCE=1`：忽略缓存强制重新准备；
  - `LARK_CLI_PREPARE_ALLOW_VERSION_MISMATCH=1`：允许版本不一致（仅排障用）。

## 2. 运行时解析：内置优先，系统兜底

`createLarkCliRuntime()` 的优先级：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `NXCORE_LARK_CLI_PATH` | 显式覆盖（开发调试 / 企业定制），source=`env` |
| 2 | `Resources/lark-cli/<platform>-<arch>/lark-cli` | **默认路径**，随应用安装，source=`bundled` |
| 3 | `Resources/lark-cli/lark-cli` | 旧的扁平布局兼容 |
| 4 | `apps/desktop/build/lark-cli/...` | 开发态（未打包） |
| 5 | 系统安装位置 | 仅当上面都缺失时兜底，source=`system` |
| 6 | PATH 兜底 | 记为 source=`missing`，状态页显示「不可用」而不是静默使用 |

系统兜底细节（`source=system`）：

- 主动探测常见全局位置（GUI 应用的 PATH 不含登录 shell 的全局 bin 目录）：
  - macOS：`/usr/local/bin`、`/opt/homebrew/bin`、`/usr/bin`、`~/.local/bin`、
    `~/.npm-global/bin`、`~/.volta/bin`、`~/bin`，以及 `PATH` 中各项；
  - Windows：`%APPDATA%\npm\node_modules\@larksuite\cli\bin\lark-cli.exe`、
    `%LOCALAPPDATA%\Programs\lark-cli`、`%PROGRAMFILES%\lark-cli`（npm 的 `.cmd`
    垫片无法被 `shell:false` 直接执行，因此只认真实 exe）。
- 必须通过 `--version` 探测且 **≥ `MIN_SUPPORTED_LARK_CLI_VERSION`（当前 1.0.90）**；
  低于最低版本会被忽略并记录日志（宁可报不可用，也不用不兼容的 CLI 引导授权）。
- 内置/环境变量来源不做版本闸门：内置二进制由本仓库构建流程保证版本一致。

来源与版本只用于**内部诊断**（应用日志 `[lark-cli]` 行、`agent-auth:status` 的
`cliSource` / `cliVersion` 字段），不在连接器等用户界面展示——用户无需感知内置/系统
CLI 的区别。

## 3. 与用户电脑自带 CLI 的关系：配置隔离

**核心结论：应用永远使用自己的私有配置目录，不读写用户 `~/.lark-cli`。**

lark-cli 的配置/凭据落点由 HOME 族环境变量决定。桌面主进程把子进程的：

| 变量 | 值 |
| --- | --- |
| `HOME` | `<userData>/lark-cli/home` |
| `USERPROFILE`（Win） | 同上 |
| `APPDATA` / `LOCALAPPDATA`（Win） | `<home>/AppData/Roaming` / `<home>/AppData/Local` |
| `XDG_CONFIG_HOME` 等 | 不传递（避免绕过 HOME 隔离） |

因此：

- 内置 CLI 写出的 `~/.lark-cli/config.json`、缓存、加密后的 App Secret/token 都在应用私有目录内；
- 用户在终端里用自己安装的 lark-cli 配置的应用/账号 **不受影响**；
- 应用也不会误用用户自己的飞书应用凭据；
- `LARKSUITE_CLI_PROFILE`、`LARKSUITE_CLI_APP_ID`、`FEISHU_APP_ID` 等变量不会被继承，
  避免应用被用户终端里的 profile 设置劫持。

### 不使用系统钥匙串（macOS）

lark-cli 默认把加密主密钥存进 **macOS 登录钥匙串**（`service=lark-cli`、`account=master.key`）。
该条目按登录用户全局共享、不受 HOME 隔离影响：如果机器上已有历史条目（例如用户终端里
安装过 lark-cli），应用内置的签名二进制去读取时会触发 macOS 的 ACL 授权弹窗
（「lark-cli 想使用你钥匙串中的密钥」）。

本应用不使用这条路径：首次调用 lark-cli 之前，会在应用私有目录预置主密钥文件

```
<userData>/lark-cli/home/Library/Application Support/lark-cli/master.key.file
```

（32 字节随机值、权限 0600，由 `ensureLarkCliMasterKey()` 生成）。lark-cli 检测到该文件后
**加解密全部走文件，不再读写系统钥匙串**，因此连接/授权/导出全程不会出现钥匙串弹窗，
也不需要用户点「允许」。已存在的文件绝不覆盖（覆盖会让已保存的凭据无法解密）。

> 文件名/格式是 lark-cli 1.0.93 的实测契约；内置二进制版本由 `prepare-lark-cli.mjs` 的
> manifest 固定，升级 CLI 版本时需重新验证（见 §6 排障）。

> 升级说明：早期版本直接使用用户默认 `~/.lark-cli`，切换到隔离配置后需要重新授权一次
> 飞书（凭据不再复用）。这是有意的隔离取舍。

## 4. 环境变量：白名单继承

lark-cli 子进程环境 = **白名单继承 + 固定注入**，其余全部剥离（allowlist 而非 denylist）。

允许继承：

- 身份/语言：`USER`、`LOGNAME`、`SHELL`、`LANG`、`LANGUAGE`、`LC_ALL`、`LC_CTYPE`、
  `LC_MESSAGES`、`TERM`、`TZ`
- 临时目录：`TMPDIR`、`TMP`、`TEMP`
- 企业网络：`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`（含小写）
- 自定义 CA：`SSL_CERT_FILE`、`SSL_CERT_DIR`、`NODE_EXTRA_CA_CERTS`
- Windows 运行必需：`SYSTEMROOT`、`WINDIR`、`COMSPEC`、`PATHEXT`、`PROGRAMFILES` 等
- `PATH`（去空项/去重后继承）

固定注入：`HOME` 族（见上表）、`NO_COLOR=1`、显式 `LARK_CLI_NO_PROXY=1` 时保留该开关。

被剥离（自然不在白名单内）：`LARK_*`（`LARK_CHANNEL` 等）、`LARKSUITE_CLI_*`、
`FEISHU_*`、`OPENCLAW_*`、`HERMES_*`、`NODE_OPTIONS`、`ELECTRON_*`、`npm_config_*`、
`XDG_*`、`CI` 等。这样无论 EverRoom 从 Finder、终端还是某个 Agent 宿主启动，
lark-cli 都以同一种干净环境运行，不会进入其他 Agent 的工作区，也不会加载外部注入的
Node/Electron 选项。

网关侧使用同一策略（`lark-cli-environment.ts`）：桌面通过
`NXCORE_LARK_CLI_PATH` + `NXCORE_LARK_CLI_HOME` 把二进制与私有 HOME 注入网关，
网关执行导出/导入命令时复用同一份隔离策略。

## 5. 生命周期：安装 / 升级 / 卸载

- **安装**：二进制与 manifest 在 `Resources/lark-cli/`，随应用一起安装并做代码签名校验
  （与 `oo`、`ntn` 等内置 CLI 相同机制）。首次使用前只在应用私有目录写入主密钥文件
  （0600），不写系统钥匙串、不写用户 `~/.lark-cli`；首次授权时在私有 HOME 下创建配置。
- **升级**：新安装包整目录替换 `Resources/lark-cli/`；私有 HOME 保留，已授权状态延续。
- **卸载（macOS）**：二进制在 `.app` 内，随应用拖入废纸篓一起消失；私有配置在
  `<userData>/lark-cli/home`，用户选择「清除本机数据」或手动删除
  `~/Library/Application Support/EverRoom` 时清除。
- **卸载（Windows）**：安装器删除 `Resources/lark-cli/`；`build/installer.nsh` 的
  `customUnInstall` 额外删除 `%APPDATA%\EverRoom\lark-cli` 与
  `%LOCALAPPDATA%\EverRoom\lark-cli`（私有主密钥与配置）。
  安装器要求应用已退出，应用退出时会结束自己启动的 lark-cli 子进程。
- **凭据存储**：应用使用的 lark-cli 不写 macOS 钥匙串——主密钥与加密后的凭据都在上面的
  私有目录内，删除该目录即彻底清除（断连「注销」会调用 `lark-cli auth logout` 清除本机凭据）。
  Windows 上 lark-cli 使用系统凭据管理器，无交互弹窗；安装器只清文件系统内的私有目录。

## 6. 排障

| 现象 | 排查 |
| --- | --- |
| 连接器页提示「lark-cli 未随产品预装或不可用」 | 检查 `Resources/lark-cli/<platform>-<arch>/lark-cli` 是否存在、可执行；打包机是否执行了 `prepare-lark-cli.mjs` |
| 来源显示「回退使用系统已安装的 lark-cli」 | 内置二进制缺失或损坏；重装应用（不要依赖系统 CLI 长期运行） |
| 版本过低被忽略 | 系统 CLI < 1.0.90；更新系统 CLI 或重装应用使用内置版本 |
| 连接时弹出 macOS 钥匙串授权框 | 正常应为 0 次：确认私有目录下存在 `Library/Application Support/lark-cli/master.key.file`；缺失时应用下次启动会重新生成（已有凭据会失效，需重新连接） |
| 授权后重启变回未连接 | 检查私有 HOME 是否被清理（`<userData>/lark-cli/home`）；确认没有外部工具清理应用数据目录 |
| 想看当前解析结果 | 应用日志搜索 `[lark-cli]`（输出 source、路径、版本、私有 HOME） |

手动验证（开发机）：

```bash
cd apps/desktop
node scripts/prepare-lark-cli.mjs          # 准备/校验内置二进制
./build/lark-cli/darwin-arm64/lark-cli --version
HOME="$(mktemp -d)" ./build/lark-cli/darwin-arm64/lark-cli config show   # 隔离后的空配置
```