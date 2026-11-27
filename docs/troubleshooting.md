# 排查手册：工具没进会话 / 插件"装了但没跑"

> 适用症状：插件文件都在、profile 也登记了，但模型在会话里看不到它注册的工具（例如 `wake_create`），
> 数据目录一直空着，宿主日志里什么也看不到。
>
> 这份手册来自 2026-11-27 的一次真实排查（dsh-wake 0.1.0 + DSH 桌面 0.2.1-rc.5）。
> **结论几经更正，正文写的是最后核实过的版本，错误的假设也保留了——它们同样有用。**

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

### 第 2 步：`apply()` 被调用了吗

```js
export function apply(ctx, baseConfig = {}) {
	diag('apply-enter', { hasCtx: !!ctx, hasTools: !!ctx?.tools, hasRegister: typeof ctx?.tools?.register === 'function' });
	// ...原逻辑
}
```

| 结果 | 含义 | 下一步 |
| --- | --- | --- |
| 没写 | 加载器 import 了模块，但没把它当插件挂 | 见第 2 节（本案例停在这一层） |
| 写了 | 生命周期开始了 | 进第 3 步 |

### 第 3 步：`tools.register()` 成功了吗

```js
disposeTool = tools.register(tool) ?? null;
diag('register-ok', { hasDispose: disposeTool !== null });
```

### 第 4 步：会话拿到了吗

**全局表里有 ≠ 会话工具清单里有。** 会话 agent 的工具清单在**创建时**快照。

| 检查 | 做法 |
| --- | --- |
| 老会话看不到 | **正常**，开新会话再看 |
| 新会话也看不到 | 检查会话层白名单（例：fish-soul 的 `allowedTools()` / `CHAT_TOOLS`） |

---

## 2. 第 2 步过不去时，怎么缩小范围

本案例停在这里：**模块被 import，`apply` 从不调用。**

下面四条是当时逐一验证并**排除**掉的假设。都记下来，因为每一条都曾经"看着很像"。

### ① 重复 id？—— 排除

包自带 `dsh.bundle.patch` 时，一旦它进了 `dsh.profile.bundles`，宿主会自动插入一行 `id: xxx`。
如果在 profile 的 `cordis.patch.yml` 里再写一条同 id 的覆盖行，理论上可能互相吞掉。

**实测**：删掉覆盖行后，`apply` 依然不调用。**不是这个原因。**

不过这条**仍然是值得遵守的写法**：

```yaml
- id: wake          # 覆盖配置时不要写 insert
  config: { ... }
```

### ② profile 依赖树坏了？—— 排除（这条是**误报**）

曾经用脚本查看 profile 装载结果，看到：

```json
"skippedBundles": [
  "cannot resolve profile bundle @deepseek-ai/dsh-base ...",
  "cannot resolve profile bundle @deepseek-ai/dsh-web-app ..."
]
```

**以为依赖树残缺，其实是脚本传错了参数。**

`loadProfileDirectory(binName, dir, installAnchor)` 的第三个参数要 **`package.json` 的路径**，不是目录：

```js
// ❌ 错：传目录 → 解析失败 → 报 cannot resolve
boot.loadProfileDirectory('dsh', profileDir, 'D:/dsh-rc5/resources/app/dsh');

// ✅ 对：传 package.json
boot.loadProfileDirectory('dsh', profileDir, 'D:/dsh-rc5/resources/app/dsh/package.json');
```

**用正确参数重跑，`skippedBundles` 是空的，六个 bundle 全部正常解析。**

> **教训**：诊断脚本自己也会造出假证据。看到"环境坏了"的结论，先怀疑自己的调用方式。

### ③ insert 行这条路不通？—— 排除

`dsh-screen` 就是用 `insert` 行挂的，它的工具一直可用。
**说明 insert 这条路本身没问题**，不能拿它当替罪羊。

### ④ peer 写成通配符被拒？—— 排除

```json
// 曾经是
"peerDependencies": { "@deepseek-ai/dsh-llm": "*", "@deepseek-ai/schemastery": "*" }

// 改成显式范围后仍然不挂（照 dsh-screen 的写法）
"peerDependencies": { "@deepseek-ai/dsh-llm": ">=0.2.1-rc.5", "@deepseek-ai/schemastery": "~3.18.5" }
```

而且用宿主自己的判定函数验证过，**兼容性是通过的**：

```js
boot.evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.5')   // → undefined（通过）
```

**结论：不是 peer 的问题。**（显式范围仍然值得保留，它比通配符更诚实。）

### ⑤ 剩下的那段空白

四种假设都排除后，范围只剩一句话：

> **cordis 在"模块 import 完成之后、调用 `apply` 之前"把这一行丢掉了。**

再往下就要读 cordis 运行时的 row 装载逻辑（`dsh-app-boot` 只负责生成 entry 列表，
真正挂载在 cordis / dsh-runtime 里）。**本案例到此为止，未继续。**

---

## 3. 临时绕行：借一个"确定能挂"的插件代调 `apply`

```js
// 在一个确定会被挂载的插件里（例：fish-soul 的 apply 末尾）
if (globalThis.__wakeBridge !== true) {
	globalThis.__wakeBridge = true;
	void (async () => {
		const mod = await import('dsh-wake');
		await mod.apply(ctx, cfg);      // 同一个 cordis app，ctx.tools 是同一张表
		log('info', '[bridge] 已代挂 dsh-wake');
	})();
}
```

**为什么可行**：同一个 app 里 `ctx.tools` / `ctx.agents` 都是同一份。
借它的 ctx 调一次 `apply`，效果等同于宿主自己挂。

**代价（必须知道）：**

| 局限 | 说明 |
| --- | --- |
| 依赖那个宿主插件先启动 | 它挂了，被代挂的一起没 |
| 配置不走设置页 | 建议让代挂读一个 `config.json`，改文件即可 |
| 不符合插件规范 | 宿主修好后应删掉这整段 |

**排查用开关**：加一个标记文件（例 `D:/feiyu/wake-bridge.disabled`），
存在时跳代挂，用来验证"正常挂载到底通不通"，避免代挂把结论污染掉。

---

## 4. 本次案例记录（2026-11-27，含错误路径）

**症状**：`wake_create` 在新老会话里都看不到；`~\.dsh\dsh-wake\` 一直是空目录。

**试过并排除的**：

| 尝试 | 结果 |
| --- | --- |
| junction + profile insert 行 | 未挂载 |
| 加进 bundles（同 heartbeat 的挂法） | 未挂载 |
| 两者同时存在 | 更糟（重复 id） |
| node_modules 从 junction 改成实体目录 | 未挂载 |
| 换包名 `dsh-wake-probe` + 换 id | 未挂载（证明与命名无关） |
| 删掉 profile 的覆盖行 | 未挂载（证明不是覆盖行） |
| peer 从 `*` 改成显式范围 | 未挂载（证明不是兼容性） |

**探针给出的事实**：

```
module-import    ✅ 写了（宿主 pid）
apply-enter      ❌ 从来没写过
```

**最终结论**：

- profile **是好的**（六个 bundle 全部正常解析，`skippedBundles` 为空）
- 模块**确实被加载**了
- **`apply` 没有人调用** —— 卡在 cordis 的 row 挂载判定
- 绕行方案：借 fish-soul 的 ctx 代调 `apply`，工具立刻可用

---

## 5. 一页检查清单

```powershell
# ① 宿主能不能解析这个包（从 profile 目录）
cd $env:USERPROFILE\.dsh\profiles\desktop
node --input-type=module -e "await import('dsh-wake'); console.log('import ok')"

# ② 模块顶层标记有没有写（重启后）
Get-Content D:\feiyu\wake-boot.log -Tail 5

# ③ 插件自己的数据目录建了没
Get-ChildItem $env:USERPROFILE\.dsh\dsh-wake

# ④ profile 装载结果（注意第三个参数是 package.json 路径！）
node --input-type=module -e "
const boot = await import('file:///D:/dsh-rc5/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const p = boot.loadProfileDirectory('dsh','C:/Users/<user>/.dsh/profiles/desktop','D:/dsh-rc5/resources/app/dsh/package.json');
console.log('layers:', p.layers.map(l=>l.packageName).join(', '));
console.log('skipped:', JSON.stringify(p.skippedBundles));
"
```

---

## 6. 三条容易踩的坑（都是这次踩过的）

**① 重复 id 会静默失效**

包自带 `dsh.bundle.patch` 且进了 `bundles` 时，profile 层不要再 `insert` 同一个 id。
改配置用覆盖形式（`- id: xxx` + `config:`）。

**② 会话工具清单是快照**

新注册的工具只对**新会话**生效。老会话看不到不是 bug。

**③ 诊断脚本会造假证据**

`loadProfileDirectory` 传错锚点就报 "cannot resolve"，看起来像环境坏了。
**看到"环境有问题"的结论，先核对自己的调用参数。**

---

## 7. 什么时候该停下来

连续三种"看起来正确"的挂载方式都失败时，**不要再改配置**。

先加探针，把"哪一道门没过"测出来。

**今天最省时间的动作不是改配置，是在模块顶层加那一行日志。**
