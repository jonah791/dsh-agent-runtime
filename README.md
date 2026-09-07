# dsh-agent-runtime

> 守护运行时服务：环境发现 + webman 进程管理（单一来源）。
> DeepSeek Harness 自研插件 · v0.1.0

## 定位

守护体系的**事实来源层**：统一发现运行时环境（bin / port / profile）并管理 webman 进程（spawn / kill / portOwner），消除 sentinel / guardian 各自重复发现环境的冗余。

## 功能特性

- **runtime 环境发现**：bin / port / profile 单一来源——所有守护插件从同一处取环境事实，不各自猜测
- **webman 进程管理**：spawn（拉起）/ kill（停止）/ portOwner（查端口占用者）
- **服务化**：提供 `ctx.runtime` 服务，供 sentinel（重启）、guardian（拉起/自愈）消费

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-runtime.git self-plugins/dsh-agent-runtime
cd self-plugins/dsh-agent-runtime && pnpm install && pnpm build
```

挂载到 watch profile（与 sentinel / guardian / preflight 协作）。

## 使用

- 守护进程模式：挂载后自动提供服务，无需人工调用
- 组合行 id：`agent-agent-runtime`

## 技术要点

- **单一来源**：杜绝「sentinel 认为端口是 X、guardian 认为是 Y」的认知分裂
- 三插件（sentinel/guardian/preflight）+ runtime 构成完整的守护体系：runtime 给事实、preflight 把关、sentinel 协调、guardian 保活

## License

MIT