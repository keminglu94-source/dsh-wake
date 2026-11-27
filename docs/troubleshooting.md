# 排查手册：工具没进会话 / 插件"装了但没跑"

> 适用症状：插件文件都在、profile 也登记了，但模型在会话里看不到它注册的工具（例如 `wake_create`），
> 数据目录一直空着，宿主日志里什么也看不到。
>
> 这份手册来自 2026-11-27 的一次真实排查（dsh-wake 0.1.0 + DSH 桌面 0.2.1-rc.5）。

---

## 0. 先记住一件事

**"插件装上了"和"插件跑起来了"是两个不同的事实。**

中间至少有四道门，任何一道静默失败，表现都一样：**工具不在**。

```
① 包能不能被 import        → 模块顶层执行了没
② 宿主有没有调 apply()      → 插件生命周期开始了没
③ tools.register() 成功了没  → 工具进全局表了没
④ 会话创建时有没有带上它     → 进去的是"新会话"还是"老会话"
```

**没有探针就只会在配置层反复改，因为四个失败长得一模一样。**

---

## 1. 四步定位法

### 第 1 步：模块被 import 了吗

在 `lib/index.js` **模块顶层**（不是 `apply` 里面）加一行：

```js
try {
	const fsm = process.getBuiltinModule ? process.getBuiltinModule('node:fs') : null;
	if (fsm) fsm.appendFileSync('D:/feiyu/wake-boot.log', JSON.stringify({
		at: new Date().toISOString(),
		pid: process.pid,
		stage: 'module-import',
		argv: process.argv.slice(0, 3).join(' ')
	}) + '\n');
} catch { /* 自检失败不影响加载 */ }
```

重启宿主，看日志。

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| **没写** | 加载器根本没加载这个包 | 查 profile 依赖树、bundles、patch 行 |
| 写了，`argv` 里是宿主的 exe | 加载器认这个包 | 进第 2 步 |
| 写了，但 `pid` 每次不同、`argv` 是 node | 那是你自己测试时写的，不是宿主 | 别被自己的日志骗了 |

> **这一步最重要。** 它把"没加载"和"加载了没跑"一刀切开，
> 而这两种情况此前的修法完全不同。

### 第 2 步：`apply()` 被调用了吗

```js
export function apply(ctx, baseConfig = {}) {
	diag('apply-enter', { hasCtx: !!ctx, hasTools: !!ctx?.tools, hasRegister: typeof ctx?.tools?.register === 'function' });
	// ...原逻辑
}
```

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| 没写 | 加载器 import 了模块，但没把它当插件挂 | 进注 A（挂载判定） |
| 写了 | 生命周期开始了 | 进第 3 步 |

### 第 3 步：`tools.register()` 成功了吗

```js
disposeTool = tools.register(tool) ?? null;
diag('register-ok', { hasDispose: disposeTool !== null });
```

- `hasDispose: true` → 工具进了全局表
- 抛错 → 看 `register-fail` 里的 error

### 第 4 步：会话拿到了吗

**全局表里有 ≠ 会话工具清单里有。**

会话 agent 的工具清单在**创建时**快照。

| 检查 | 做法 |
| --- | --- |
| 老会话看不到 | **正常**，开新会话再看 |
| 新会话也看不到 | 检查会话层的工具白名单（例如 fish-soul 的 `allowedTools()` / `CHAT_TOOLS`） |

> fish-soul 这类"收窄工具"的插件要特别看一处：
> 它会用 `CHAT_TOOLS` 之类的白名单过滤宿主工具。
> **新工具必须加进那份名单**，否则宿主注册了也到不了会话。

---

## 2. 注 A：加载器 import 了却不挂载

先确认 profile 的依赖树是不是完整的。用一个几十行的脚本直接跑宿主的 loader：

```js
const boot = await import('file:///D:/dsh-rc5/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const prof = boot.loadProfileDirectory('dsh', 'C:/Users/<user>/.dsh/profiles/desktop', 'D:/dsh-rc5/resources/app/dsh');
console.log('skippedBundles:', JSON.stringify(prof.skippedBundles, null, 1));
console.log('用户层 rows:', prof.patches.map((p) => p.id ?? Object.keys(p)).join(', '));
```

**如果 `skippedBundles` 里连宿主自己的 `@deepseek-ai/dsh-base` / `dsh-web-app` 都在**：

> 这个 profile 的依赖树本来就是残缺的。
> **新插件不会被挂载**，无论你写 insert 还是放进 bundles —— 两条路都静默跳过。

这时不要继续在配置层试。两条出路：

**① 修依赖树（彻底，但风险大）**

重装 profile 依赖（等价于 `dsh plugin --profile <name> install`）。
风险：fish-soul / heartbeat 这些正在用的插件可能一起被牵动。

**② 借一个确定能挂的插件代调 `apply`（临时，但立刻可用）**

```js
// 在一个"确定会被挂载"的插件里（例：fish-soul 的 apply 末尾）
if (globalThis.__wakeBridge !== true) {
	globalThis.__wakeBridge = true;
	void (async () => {
		const mod = await import('dsh-wake');
		await mod.apply(ctx, { enabled: true });
		log('info', '[bridge] 已代挂 dsh-wake');
	})();
}
```

**为什么可行**：同一个 cordis app 里，`ctx.tools` 是同一张表；`ctx.agents` 也在。
所以借它的 ctx 调一次 `apply`，效果等同于宿主自己挂。

**必须知道的代价：**

| 局限 | 说明 |
| --- | --- |
| 依赖那个宿主插件先启动 | 它挂了，被代挂的一起没 |
| 配置写在代码里 | 改配置要改代码，不走设置页 |
| 不符合插件规范 | 宿主修好后应删掉这整段 |

---

## 3. 本次案例记录（2026-11-27）

**症状**：`wake_create` 在新老会话里都看不到；`~\.dsh\dsh-wake\` 一直是空目录。

**试过并排除的（每一步都"看起来对"）**：

| 尝试 | 结果 |
| --- | --- |
| junction + profile insert 行（同 tieba 的挂法） | 未挂载 |
| 加进 bundles（同 heartbeat 的挂法） | 未挂载 |
| 两者同时存在 | 更糟（重复 id，两个都不落地） |
| node_modules 从 junction 改成实体目录 | 未挂载 |
| 换包名 `dsh-wake-probe` + 换 id `wake-probe` | 未挂载（证明与包名/ id 无关） |
| 检查 manifest 的 `engines.dsh` / peer 兼容性 | 三个插件都不触发拒绝 |

**加探针后才知道的事实**：

```
module-import    ✅ 写了（宿主 pid，argv 是 DeepSeek Harness.exe）
apply-enter      ❌ 从来没写过
```

**根因**：`skippedBundles` 里有

```json
{"packageName":"@deepseek-ai/dsh-base","reason":"cannot resolve profile bundle ..."}
{"packageName":"@deepseek-ai/dsh-web-app","reason":"cannot resolve profile bundle ..."}
```

→ profile 依赖树残缺，装载链对新插件整体失效。

**解决**：借 fish-soul 的 ctx 代调 `apply()`。

**结果**：

```
apply-enter    hasTools:true  hasRegister:true
register-ok    hasDispose:true      ← 工具进表
apply-ready    dataDir:C:\Users\<user>\.dsh\dsh-wake
```

---

## 4. 一页检查清单

```powershell
# ① 宿主能不能解析这个包（从 profile 目录）
cd $env:USERPROFILE\.dsh\profiles\desktop
node --input-type=module -e "await import('dsh-wake'); console.log('import ok')"

# ② 模块顶层标记有没有写（重启后）
Get-Content D:\feiyu\wake-boot.log -Tail 5

# ③ 插件自己的数据目录建了没
Get-ChildItem $env:USERPROFILE\.dsh\dsh-wake

# ④ profile 装载器怎么看这个 profile
node -e "..."   # 见第 2 节脚本，重点看 skippedBundles
```

---

## 5. 三条容易踩的坑（都是这次踩过的）

**① 重复 id 会静默失效**

包自带 `dsh.bundle.patch` 的话，一旦它进了 `dsh.profile.bundles`，
宿主就会自动插入一行 `id: xxx`。
此时 profile 的 `cordis.patch.yml` 里**不要再写 `insert` 同一个 id**。

要改配置就用覆盖形式：

```yaml
- id: wake          # 不写 insert
  config: { ... }
```

**② 会话工具清单是快照**

新注册的工具只对**新会话**生效。老会话看不到不是 bug。

**③ 探针不要留在生产代码里**

`diag()` 这类写入只该在排查期存在。
定位完就删掉，或改成环境变量开关。

---

## 6. 什么时候该停下来

如果连续三种"看起来正确"的挂载方式都失败，**不要再改配置**。

先加探针，把"哪一道门没过"测出来。

**今天最省时间的动作不是改配置，是在模块顶层加那一行日志。**
