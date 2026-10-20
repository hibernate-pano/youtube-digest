# ADR-006: 严格 CSP 优先于 Cloudflare 的分析统计

## Status
Accepted（2026-10-20）— 已执行

## Background

同步服务（`ytd.panbo.space`）同时是 API 和网页面板的宿主。面板的响应头
里有一条严格的 CSP：

```
script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'
```

它的意思是：**这个页面只跑自己的脚本，别人的一行都不跑。**

Cloudflare 在 zone 上开着 Web Analytics，它会在每个 HTML 响应里注入一段
内联脚本和一段来自 `static.cloudflareinsights.com` 的 beacon。两条都被这条
CSP 挡掉了——浏览器控制台里能看到两条报错：

```
Executing inline script violates ... 'script-src 'self''
Loading the script 'https://static.cloudflareinsights.com/beacon.min.js/...'
  violates ... 'script-src 'self''
```

## Decision

**保留 CSP，不为了统计统计放宽它，也不去动 zone 上的设置。**

理由：

1. **CSP 是这个产品对用户许下的承诺，不是配置项。** 隐私政策里写着「网页
   控制台只加载自己的脚本和样式，不发送任何分析统计或行为追踪」。这条
   CSP 就是那句话的执行方式；为了几句统计而放宽它，等于让承诺变成谎言。
2. **统计不是这个产品要做的事。** 同步服务是给用户存笔记和生词的地方，
   知道谁在用对它没有任何价值。
3. **不能动 zone 上的设置。** `panbo.space` 上还有博客、教练页、其它面板等
   七八个站点。关掉 zone 级的 Web Analytics 会影响它们，那不是这个项目
   能替别人做的决定。
4. **报错本身无害。** 被挡掉的是第三方脚本，页面自己的功能一点不受影响。
   我们在浏览器里逐条确认过：页面正常、脚本正常、数据正常。

## Consequences

- **控制台里有两条报错。** 每次访问面板都会看到。它们是 CSP 在**工作**的
  证据，不是故障。知道这一点的人不会误以为页面坏了。
- **隐私政策里「不收集分析统计」这句话在事实上成立。** 因为统计脚本从来
  没有被放行过——这句话不是承诺，是现状。
- **zone 级的 Web Analytics 对这个主机无效。** 想让统计真正跑起来，只能
  换一条更松的 CSP，或者在 Cloudflare 侧对这个主机单独关掉。前者我们不
  做，后者需要 zone 的权限。
- 如果将来真的要在这个产品上收集统计，正确的做法是**先写清楚收什么、
  为什么收、存多久**，再改这一条，而不是顺手把 CSP 放宽。

## Alternatives considered

- **给 CSP 加 `unsafe-inline`，让 Cloudflare 的脚本跑起来**：一次改动就
  放弃了整条安全承诺。**否决**。
- **用 nonce 放行 Cloudflare 的内联脚本**：nonce 要每请求生成，而那段脚本
  是 Cloudflare 注入的、我们不控制它的内容。技术上可以做（自己生成 nonce
  并加进响应头），但为了让第三方统计跑起来而给页面开一道口子，收益不配
  成本。**否决**。
- **在 Cloudflare 侧对这个主机关掉 Web Analytics**：这是最干净的办法，但
  它是 zone 级的设置，会影响同一 zone 上的其它站点——越权。**否决**（如果
  将来拿到明确的授权，这一项应该重新考虑）。
