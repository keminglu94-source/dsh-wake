# dsh-wake

给 DSH 模型用的最小唤醒插件：模型可以调用 `wake_create`，让**当前已有会话**在指定分钟后再醒来一次。

它不是通用定时任务，也不是方法注册表。插件只负责：

- 接收模型的 `wake_create`；
- 按宿主机器本地时间计算下一次唤醒；
- 到点在同一会话注入 `source.kind = 'heartbeat'` 的唤醒信号；
- 失败最多重试 2 次；
- 控制静默时段和每日次数；
- 恢复会话时重新挂载该会话原本的 preset。

模型醒来之后做什么，由模型自己决定。

## 安装

把 `dsh-wake` 目录放进 DSH 的插件目录，或通过 profile 的 `cordis.patch.yml` 挂载：

```yaml
- insert:
    - id: wake
      name: dsh-wake
```

在 profile 自己的 `cordis.patch.yml` 里可以按 id 覆盖配置：

```yaml
- id: wake
  config:
    quietStart: "01:00"
    quietEnd: "08:00"
    maxWakesPerDay: 4
```

## 工具

### `wake_create`

```json
{
  "afterMinutes": 30,
  "goal": "继续处理刚才没做完的事"
}
```

规则：

- 目标会话由工具调用上下文自动确定，模型不能指定别的会话；
- `afterMinutes` 必须在配置范围内；
- 默认本地时间 `01:00-08:00` 不能创建唤醒；
- 如果下一次唤醒会落在静默时段，也会失败；
- 全局每天醒来次数由 `maxWakesPerDay` 控制；只有成功提交给会话（`followup` 成功）的唤醒才计数，失败的调度重试不单独计数；设为 `0` 表示禁止唤醒；
- 同一个会话同时只保留一个待唤醒任务。

第一次唤醒需要模型（或用户在对话中让模型）调用一次 `wake_create` 建立首个 wake job；插件不会凭空唤醒一个没有任务记录的会话。

任务下发只在**明确还没有进入会话**时重试，最多 2 次。  
如果已经调用 `followup` 但结果不确定，会记为 `unknown` 并且不自动重发，避免同一会话被唤醒两次。

插件进程在 `dispatching` 状态下重启时，同样会把该任务标成 `unknown`，不会补发。

## 配置

默认值：

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

时间判断使用宿主机器本地时间，不依赖虚拟时钟。

唤醒依赖 DSH 进程在运行：DSH 关闭期间不会唤醒。重新启动时，超过
`maxOverdueMinutes`（默认 180 分钟）的过期任务会被跳过，不会补发一个已经过时的唤醒。

同一个 `dataDir` 只应由一个 DSH 进程使用；多个进程共享同一个目录时没有跨进程锁，
可能重复下发同一个 wake job。

运行数据：

- `<dataDir>/jobs.json`：每个 wake job 的状态、nextAt、lastError；
- `<dataDir>/stats.json`：当天已经成功醒来的次数。

默认 `dataDir` 是 `$DSH_HOME/dsh-wake`，没有 `DSH_HOME` 时是 `~/.dsh/dsh-wake`。

`quietStart` / `quietEnd` 写错时会回退到默认的 `01:00-08:00`，不会因为配置错误而静默关闭静默时段。想关闭静默时段，把两个值设成相同时间（例如 `00:00` / `00:00`）。

## 宿主依赖

- `@deepseek-ai/dsh-llm`：唤醒消息必须由宿主的 `createUserMessage` 生成。插件不会手拼消息对象；缺失时本次唤醒按“下发前失败”重试，重试耗尽后记录失败。
- `agentPresets`（可选）：恢复会话后如果宿主提供该服务，会按会话事件里的 `agent-preset/selected` 重新挂载 preset。没有该服务时退化为裸 agent。

## 唤醒信号约定

插件注入的唤醒消息使用：

```text
source.kind = 'heartbeat'
source.plugin = 'dsh-wake'
source.form = 'wake'
```

不要用 `source.kind = 'user'`。否则其他插件（例如 fish-soul）会把它当成人发的消息。
`@kanadego/dsh-heartbeat` 也用 `kind='heartbeat'`，消费方应同时看
`source.plugin === 'dsh-wake'`，不要只按 kind 一刀切。

详细设计见 [docs/design.md](docs/design.md)，来源约定见 [docs/heartbeat-source-contract.md](docs/heartbeat-source-contract.md)。

## 醒来后模型能用到什么

唤醒是**在同一个 session 里继续一轮**，不是新建会话：

- 会话历史还在，模型能看到之前的聊天；
- 如果会话属于 fish-soul，恢复后会重新挂载该会话的 preset，`remember` / `recall` /
  人格 section 仍然可用；
- 模型调用 `remember` 时，记忆写入 fish-soul 自己的库；`dsh-wake` 本身不写记忆；
- `heartbeat` 不是用户消息。fish-soul 侧需要把 `heartbeat` 识别为机器来源，
  才不会把唤醒文本记成“主人刚说过话”（见来源约定文档）。
