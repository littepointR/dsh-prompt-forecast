# Prompt Forecast

DeepSeek Harness Web 输入框里的「下一句提示词」幽灵预测，交互方式参考 Codex / Claude Code 的 prompt suggestions。

每轮对话完成后，Host 半会让当前会话使用的模型预测用户最可能输入的下一条消息，通过客户端可见的 session projection 发布；Client 半在输入框为空时把这句话以灰色文字显示在第一行。按 **Tab** 写入草稿，按 **Esc** 忽略；开始输入后自动消失，已输入的内容不会被替换。

## 依赖要求

- **DSH `0.2.1-rc.2` 及以上、且仍在 `0.2.x` 范围内**，声明为 `engines.dsh: ^0.2.1-rc.2`。
- 插件依赖 0.2.1-rc.2 的客户端与 Host 接口：`conversation.input.overlay` 输入框浮层
  slot、`InputActions.captureInsertion()` / `insertText()`，以及由
  `agent/turn-stopping` 驱动的 session projection。
- `dsh plugin add` 安装前会检查该范围，profile 启动时还会再检查一次。范围不满足时
  插件会被拒绝加载；请升级 DSH，或安装 `engines.dsh` 与当前运行时匹配的插件版本。
  DSH `0.3` 需要插件发布对应版本，而不是靠豁免绕过检查。

## 行为

- 基于真实对话预测：最近的人类消息、最新助手回复，以及本轮用到的工具名。
- 使用用户当前书写的语言，输出一行短句。
- 使用刚服务完本轮请求的模型路由（找不到时回退到配置默认模型），无需额外配置 provider。
- 跳过子代理会话和没有人类输入的轮次。
- 静默失败：预测超时、被取消或请求失败都不会在对话里报错。

## 配置

`cordis.patch.yml` 中该行的 `config` 块可以覆盖全部默认值：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册 Host 半 |
| `maxTokens` | `256` | 预测请求的输出预算 |
| `temperature` | `0.4` | 采样温度 |
| `timeoutMs` | `2000` | 请求硬超时；更慢的答案会被丢弃 |
| `maxPromptChars` | `80` | 预测文本的裁剪长度 |
| `maxInputChars` | `6000` | 发送给模型的对话摘要大小上限 |
| `skipSubagents` | `true` | 子代理会话不预测 |
| `provider` | 本轮路由 | 显式指定 provider |
| `model` | 本轮路由 | 显式指定 model |

预测在轮次边界提交前（`agent/turn-stopping`）生成，因此文本会随完成的一轮一起到达，不需要轮询。代价是 `timeoutMs`：超过预算的预测会被放弃，该轮结束时不显示建议。

## 安装

### 从 GitHub 安装（无需构建）

```bash
dsh plugin --profile web add github:littepointR/dsh-prompt-forecast
dsh web
```

`dsh plugin add` 会把参数转发给目标 profile 里的 pnpm，安装包，并因为包声明了
`dsh.bundle.patch` 而自动把它加入 `dsh.profile.bundles`。安装后需要重启 profile
才会加载插件。本包是纯 JavaScript、没有 `prepare` 构建脚本，所以 git 安装不需要
额外的 pnpm 构建授权。

固定到已打标签的版本：

```bash
dsh plugin --profile web add github:littepointR/dsh-prompt-forecast#v0.1.1
```

Desktop 应用的 `desktop` profile 由 Electron 独占，CLI 会拒绝
`--profile desktop`。在 Desktop 里请使用 设置 → 插件 安装，或安装到 CLI profile。

### 从本地目录安装

在 Plugin Manager 中把本目录作为 bundle 安装。bundle patch 会插入
`prompt-forecast` 行；作为普通 profile bundle，它会在重启后保留。

## 限制

- 只在输入框为空时显示建议。补全已经输入一半的草稿需要 slot 尚未暴露的光标几何信息，不在当前版本范围内。
- 建议只是提示，不是动作：按 Tab 只把纯文本插入草稿，不会发送。
- 预测质量取决于会话模型；过小的模型可能给出泛泛的追问。

## 开发

```bash
node --test test/host.test.mjs test/client.test.mjs
node --check index.js && node --check client.js
```

- `index.js` — Host 半：`agent/turn-stopping` 生成预测，`promptForecast` projection 发布。
- `client.js` — Client 半：注册 `conversation.input.overlay`，渲染幽灵文本并处理 Tab/Esc。
- `test/host.test.mjs` — 文本清洗、上下文摘要、projection 折叠。
- `test/client.test.mjs` — Client 渲染分支的结构性冒烟测试（不模拟 DOM）。

## License

MIT
