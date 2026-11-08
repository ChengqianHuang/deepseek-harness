---
description: "管理用户需求，并将指定版本的实现工作分发给 Codex、OpenCode、Pi 或其他 DSH 子代理 provider。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-requirements

[English](README.md) | 中文

## Summary

按项目、优先级、状态和验收条件管理用户需求，再将已确认的需求版本分发给指定 Agent。SQLite 跨会话保存需求内容和分发结果。选择持久路由后，可以把反馈发回同一个 Codex、Pi 或 OpenCode 会话。执行完成后，需求仍需用户验收。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

### 在当前 checkout 开发

需要 Node.js `^22.19.0 || >=24.0.0`，以及上级 Harness checkout 已安装的开发依赖和已构建的类型声明。此目录不属于 Harness pnpm workspace，不修改内置 profile。在 Harness 仓库根目录执行：

```sh
pnpm --dir dsh-requirements install --ignore-workspace --config.auto-install-peers=false
pnpm --dir dsh-requirements build
pnpm --dir dsh-requirements typecheck
pnpm --dir dsh-requirements test
```

### 添加到 profile

以下安装和配置组合已通过隔离的 `DSH_HOME` 与源码 CLI 验证。请将绝对路径替换为当前 checkout 的位置。父 profile 需要提供 `tools`、`subagents`、`subprocess` 和 `workingDirectory`。基于内置 base 的 profile 已提供这些服务。

```sh
pnpm dsh plugin --profile headless add --config.auto-install-peers=false /Users/hcq/deepseek-harness/dsh-requirements
pnpm dsh --profile headless --patch dsh-requirements/examples/providers.patch.yml --dump-config
```

Bundle 插入 `requirements` 配置行。示例 overlay 添加单轮 Codex 和 OpenCode provider。使用持久路由时，先安装并登录对应 CLI，再让 DSH 通过 `PATH` 或对应的 `command` 设置找到它。发现工具报告已挂载的路由，可执行文件和账号在执行时检查。

### 用户流程

让 DSH agent 收集需求，明确范围和验收条件，再将需求设为就绪。从 `requirement_agents` 返回的目标中选择 agent，分发当前需求版本。检查返回的实现和验证摘要后，再要求将需求设为完成。不同需求可以分别分发；每条需求最多允许一个进行中的分发尝试。

示例：“把这条需求发给 `codex-session`。评审后，把未通过的验收条件发回原会话。”DSH 会用分发 ID 和当前需求版本调用 `requirement_resume`。它使用保存的工作目录，并记录一条关联上次分发的执行尝试。会话缺失或线程不匹配时，本次尝试失败。工具不会自动新开会话。

### 配置

在 profile patch 中为 `requirements` 行添加覆盖项。所有字段均可省略。

```yaml
- id: requirements
  config:
    agents:
      codex: codex
      codex-session: requirements-codex
      opencode: opencode
      opencode-session: requirements-opencode
      pi: requirements-pi
      pi-session: requirements-pi-session
    defaultListLimit: 20
    maxListLimit: 200
    busyTimeoutMs: 5000
    dispatchTimeoutMs: 1800000
    codex:
      command: codex
      maxOutputBytes: 8388608
      graceMs: 3000
    piSession:
      command: pi
    opencode:
      command: opencode
    pi:
      command: pi
      args: []
      maxOutputBytes: 1048576
      graceMs: 3000
```

`databasePath` 默认为 `<DSH_HOME>/requirements/requirements.db`；显式路径展开 `~`，相对路径以宿主启动目录为基准。自定义 `agents` 字典会替换完整路由映射。Pi 还接受显式 `env` 字典，叠加在 subprocess provider 已过滤凭据的环境上；不要提交凭据。插件加载时验证正整数限制，且 `defaultListLimit` 不能大于 `maxListLimit`。分发继承调用方 Agent 的当前工作目录。工具取消、分发超时或插件卸载时，插件会取消该次执行。

## Understand the implementation

<details>
<summary>实现说明</summary>

[`cordis.patch.yml`](cordis.patch.yml) 安装服务和七个工具。[`src/native-session.ts`](src/native-session.ts) 通过原生 CLI 执行持久路由。Codex 允许写入工作区，禁用交互审批。Pi 使用 JSON 模式，OpenCode 启动独立服务进程。三个路由都会核对返回的会话 ID。其他路由使用 `ctx.subagents`。[`src/store.ts`](src/store.ts) 保存分发尝试，跨连接保证每条需求最多有一个活动尝试。编辑和分发都要求提供上次读取的版本。

[`src/pi.ts`](src/pi.ts) 通过 DSH subprocess 服务使用 Pi `--print --no-session` 实现单次执行 provider，需求通过 stdin 传入。成功要求退出码为零、输出非空且完整捕获。释放操作终止并等待整个受管进程树退出。插件卸载先取消并等待已接受的分发，再关闭 SQLite。所有注册均由 Cordis effect 管理。项目没有额外的独立应用入口或 agent loop。

</details>

## Further Exploration

- [Provider 配置 overlay](examples/providers.patch.yml)
- [需求与分发类型](src/types.ts)
- [分发决策记录](../.agents/notes/implemented/architecture/2026-11-04-requirement-dispatch.zh.md)
- [OpenCode CLI 与 ACP](https://opencode.ai/docs/cli/) · [Pi CLI 集成](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli-integration.md)

## Model Experience

模型可以用先前的分发 ID 调用 `requirement_resume`，把反馈发到已保存的线程。工具返回新的执行尝试，其中包含 `resumedFrom` 和可用时的 `session`。DSH 在下一次模型请求前记录工具结果。执行 Agent 会收到当前需求快照和反馈。

## Known Limitations and Deferred Work

每次分发或返工都在前台执行。`codex-session`、`pi-session` 和 `opencode-session` 支持续接。`pi-session` 使用独立的 `piSession` 配置，单轮 `pi` 路由使用 `pi` 配置。单轮 provider 及未保存线程的历史分发没有可恢复的会话。多个需求分发到同一工作目录时可能编辑同一文件。Agent 执行完成后仍需用户验收。

宿主崩溃后，持久化的进行中尝试无法确定外部结果，因此仍保留占用；尚未实现自动恢复或经过验证的人工释放命令。检查外部工作之前，不要编辑 SQLite 或重试。不支持的数据库格式会拒绝打开，不自动迁移。搜索为字面子串匹配，采用 SQLite 的 ASCII 大小写折叠；项目按标签精确匹配。历史记录保存分发结果，不保存每次需求编辑。

### Dev Note

本地测试覆盖保存的线程身份、复用工作目录和拒绝不同线程。使用真实 Codex 和 OpenCode 的验证确认，新进程能恢复第一轮上下文。真实 Pi 对本地测试端点发起的第二次模型请求也包含恢复后的上下文。无密钥的会话快照覆盖已记录的需求读取、编辑和路由发现。
