## 改动说明

<!-- 这个 PR 做了什么、为什么 -->

## 验证方式

<!-- 至少一条：doctor / rehearse 输出、真实掉线的 audit.jsonl 片段（脱敏） -->

```
node src/cli.mjs doctor
node src/cli.mjs rehearse
```

## 检查清单

- [ ] 没有提交 `config.local.json` / token / 账号明文 / 未脱敏日志
- [ ] 新增策略参数已进 `config` 并有默认值
- [ ] 新增动作有审计日志、失败可回退
- [ ] 涉及 ADB/UI 流程的改动附真实掉线验证（或说明为何无法验证）
- [ ] 未引入绕过风控 / 代扫 / 批量骚扰类能力
