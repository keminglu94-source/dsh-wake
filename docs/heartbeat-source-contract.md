# `source.kind = 'heartbeat'` 约定

## 目的

`dsh-wake` 注入的是一条机器唤醒信号，不是用户聊天消息。

```text
source.kind = 'heartbeat'
source.plugin = 'dsh-wake'
source.form = 'wake'
source.wakeId = '<job id>'   # 可选，用于排查
```

## 唤醒流程

```text
wake_create
  → 保存 wake job
  → 到点
  → 同一个 sessionId 的 agent.followup
  → 模型开始一轮
  → 模型自行决定做什么
  → 模型可再次调用 wake_create 安排下一次
```

## 与其他插件的关系

### fish-soul

如果目标会话属于 fish-soul，fish-soul 应该把 `heartbeat` 视为机器来源：

- 仍然为 agent 挂人格和记忆 section；
- 不把唤醒文本写进 journal；
- 不登记成“主人刚说过话”；
- 不把唤醒当成普通用户入站消息；
- 模型主动调用 `remember` 时，才写入 fish-soul 的长期记忆。

当前 fish-soul 的 `noteInteraction` 只跳过自己的来源列表；如果未识别 `heartbeat`，唤醒提示可能被 journal 记录。接入前应增加机器来源判断。

以 `dsh-fish-soul` v0.19.4 为例，`lib/index.js` 的 `agent/inbox/inserted`
处理里有三段需要注意：

1. `ours === true` 时先调用 `mountSectionsFor(agent)`，然后才检查来源。  
   → 心跳进入 fish-soul 自己的会话时，人格/记忆 section **会**挂上，这是需要的。
2. 来源跳过列表只包含 `qq / proactive / bili / douyin`，不包含 `heartbeat`。  
   → 心跳会继续走 `life.noteInteraction(...)` 和 `beginTurn(...)`，等于把机器唤醒
   记成“主人刚说过话”。
3. `beginTurn` 里 `desktop: ours && source.kind === 'user'`，心跳不会命中。  
   → 不会自动把唤醒当成桌面端用户消息转发，但 journal/动态页仍可能多出一条。

建议的最小改动（本次不改 fish-soul 代码，只记录契约）：

```js
const isDshWake = source.kind === 'heartbeat' && source.plugin === 'dsh-wake';
if (isDshWake) {
  // 仍然给 ours 的会话挂 section；只是不登记为用户互动、不写 journal。
  if (ours) mountSectionsFor(payload?.agent);
  return;
}
```

注意：`return` 必须放在 `mountSectionsFor` 之后，否则心跳会话拿不到人格和记忆。
另外，`heartbeat` 不应该被 `beginTurn` 当成 `desktop: true`，也不应该触发
QQ / 抖音自动回复。

**不要只按 `kind === 'heartbeat'` 一刀切**：`@kanadego/dsh-heartbeat` 也使用
`source.kind = 'heartbeat'`（`plugin: 'heartbeat'`），但它的消息是主动投递内容，
不一定应该按 `dsh-wake` 的后台唤醒处理。用 `source.plugin === 'dsh-wake'`
或 `source.form === 'wake'` 区分，避免影响 dsh-heartbeat。

### 工具可见性（接入前必须处理）

fish-soul 默认 `tools.sessionAllow = memory`，`setupAgent` 会把会话工具收窄到
`CHAT_TOOLS + WEB_TOOLS + OWN_WEB_TOOL`。`wake_create` 不在这个列表里，所以
**默认的 QQ / 抖音会话看不到 `wake_create`**，模型无法安排第一次唤醒。

要让模型能调用，fish-soul 需要把 `'wake_create'` 加入 `CHAT_TOOLS`
（`lib/gateway-session.js` 第 20 行附近），或者加入 `allowedTools()` 的 `base`。

```js
export const CHAT_TOOLS = [...QQ_SESSION_TOOLS, RELAY_TOOL, RELAY_FRIEND_TOOL, DOUYIN_VIDEO_TOOL, ...SCHEDULED_TASK_TOOLS, 'wake_create'];
```

工具本身已经在 execute 时校验静默时段和每日上限，所以放进 allow-list 不会绕过
这些限制。主人的桌面会话本来就不 restrict，通常已经能看到 `wake_create`。

### 记忆

`dsh-wake` 不写任何 fish-soul 记忆。长期记忆是否产生，由目标会话里的模型是否调用 `remember`、以及目标插件自己的整理流程决定。

### 自动回复

`heartbeat` 不应被当成用户消息自动转发出 QQ / 抖音。是否主动说话，应由目标会话的模型自己决定。
