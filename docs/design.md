# dsh-wake 设计说明

## 目标

让模型在**同一个已有会话**里安排一次未来的后台心跳唤醒。插件只负责调度和下发，不负责决定模型醒来后做什么。

```text
模型调用 wake_create
  → 插件保存 wake job
  → 到点唤醒同一个 sessionId 的 agent
  → 注入 source.kind='heartbeat'
  → 模型开始一轮
  → 模型自行决定继续做什么
  → 需要下一次时再次调用 wake_create
```

## 边界

插件负责：

- 保存待唤醒任务；
- 按宿主机本地时间计算 nextAt；
- 恢复/调度同一个会话；
- 注入 heartbeat 唤醒信号；
- 下发失败时最多重试 2 次；
- 静默时段和每日次数限制。

插件不负责：

- 方法注册表；
- 通用插件方法调用；
- 长期记忆写入；
- 替模型决定醒来后做什么；
- 自动向用户发送消息。

## 配置

```json
{
  "enabled": true,
  "quietStart": "01:00",
  "quietEnd": "08:00",
  "maxWakesPerDay": 8,
  "minAfterMinutes": 1,
  "maxAfterMinutes": 1440,
  "maxOverdueMinutes": 180,
  "idleWaitMs": 600000
}
```

- `quietStart` / `quietEnd`：宿主机器本地时间的静默窗口，默认 01:00-08:00；
- `maxWakesPerDay`：每天成功进入模型回合的唤醒次数上限；`0` 表示禁止唤醒；
- `minAfterMinutes` / `maxAfterMinutes`：相对时间范围；
- `maxOverdueMinutes`：任务超过这么久还没下发就跳过；`0` 表示不检查；
- `idleWaitMs`：唤醒后等待目标回合结束的上限，不影响已提交的唤醒。

静默时段内调用 `wake_create` 会直接返回失败，不创建任务。  
如果计算出的下一次唤醒会落在静默时段，也不会创建任务。  
`quietStart` / `quietEnd` 无法解析时回退到默认值，避免配置笔误把静默时段关掉。

## wake_create

```json
{
  "afterMinutes": 30,
  "goal": "继续处理刚才没做完的事"
}
```

工具从调用上下文取当前 sessionId，模型不能传入任意目标会话。

同一个会话同时只保留一个活跃 wake job。重复安排会替换旧的 scheduled job；正在 dispatching 时拒绝新安排。

插件不会自动给没有 job 的会话凭空创建唤醒；第一次需要模型在正常会话中调用 `wake_create`。

## 状态

```text
scheduled
  → dispatching
  → delivered
  → unknown
  → missed
  → failed
```

- `delivered`：followup 成功，唤醒消息已提交给会话；
- `unknown`：followup 可能已经写入，但没有拿到确定结果；
- `missed`：超过 `maxOverdueMinutes` 仍未下发，按过期跳过；
- `failed`：静默时段、日上限或重试耗尽；
- `scheduled`：等待下一次重试或最初的下一次唤醒。

宿主重启时，`dispatching` 状态的任务会被改成 `unknown`：无法确认 `followup`
是否已经写入，补发可能造成同一会话醒来两次。`scheduled` 任务会重新计时；
超过 `maxOverdueMinutes` 的任务会标成 `missed` 并跳过，不补发已经过时的唤醒。

插件只在 DSH 进程运行时调度；DSH 关闭期间不会唤醒。

## 重试

只有**明确还没有进入会话**的失败会重试：

- agent 获取 / resume 失败；
- followup 之前的前置失败。

初始尝试 + 2 次重试，总共最多 3 次尝试。退避为 30 秒、120 秒。

如果已经调用 followup 但结果不确定，标为 `unknown`，不自动重发，避免同一会话被唤醒两次。

## 会话恢复

唤醒时优先复用宿主里活着的 agent。没有活 agent 时调用
`ctx.agents.resume({ resumeSessionId })`，并：

- 用 `agentDefaultModel.currentSelection()` 补齐 `agentOptions`，避免恢复出来的
  agent 没有模型路由；
- 从会话事件里的 `agent-preset/selected` 读回 preset，并调用
  `agentPresets.mount(agent.ctx, presetId)` 重新挂载。否则恢复出来的 agent 是裸
  agent，可能看不到 fish-soul 的人格、记忆 section 和工具。调度时会同时把 preset id
  存进 job，作为会话日志被压缩后的 fallback。

这两步都是 best effort：取不到模型选择或 preset 服务时仍然尝试下发，但会在日志里
留下 `preset=none / ctx-missing / no-api / threw`。

## 宿主依赖

- 唤醒消息必须通过 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 生成。插件不手拼
  消息对象，避免缺少 message id 等宿主字段而污染会话；缺失时按“下发前失败”重试。
- 未安装 `@deepseek-ai/dsh-llm` 的宿主无法完成唤醒。

## 计数

每日计数是全局的（所有会话共用一个上限），只在 `followup` 成功后增加。  
重试属于同一次唤醒，不重复计数。  
静默时段和日上限拒绝的请求不计数。

## 与 fish-soul 等插件

唤醒消息使用：

```text
source.kind = 'heartbeat'
source.plugin = 'dsh-wake'
source.form = 'wake'
```

不能使用 `source.kind = 'user'`。其他插件如果使用了 fish-soul 这类会话记忆体系，应把 `heartbeat` 识别为机器来源：

- 可以挂人格和记忆 section；
- 不写入 journal；
- 不登记成用户说话；
- 不自动转发成 QQ / 抖音回复；
- 只有模型主动调用 `remember` 时才写入长期记忆。

详细约定见 `docs/heartbeat-source-contract.md`。
