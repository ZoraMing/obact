# 待内核修复的夹具测试

这三个测试文件已经写好，失败原因是内核（packages/core）的问题，不是夹具或测试本身。
它们暂不进入 `npm test`；内核修好后移回 `fixtures/test/`（改回 `./helpers.ts` 的导入路径）。

```bash
node --test fixtures/pending-tests/*.test.ts   # 目前 13 通过、8 失败
```

| 测试 | 发现的内核问题 |
|---|---|
| forms-files：axtree 视图不泄露令牌 | 元素列表里令牌已打码，但可访问性树视图里输入框的值仍以明文出现（如 `StaticText "tok-…"`） |
| forms-files：upload_file 中文文件名 | 上传中文文件名的文件时 act 返回 ok，但文件输入框里没有文件 |
| forms-files：下载链接 | 浏览器下载得到的文件名是 `download`，不是响应头里的中文文件名（待确认是内核还是夹具的 content-disposition 写法） |
| forms-files：handle_dialog 很快返回 | 关闭对话框后 handle_dialog 约 2 秒才返回（被挂起的动作拖住） |
| forms-files：prompt 默认值 | 不给 prompt_text 时，prompt 应按默认值确认，实际得到空字符串 |
| overlays：规则里用 act 处理弹窗 | 在 onObscured 回调里用 act 关弹窗后，外层动作的 effects.navigated 被误报为 true |
| redesign：改版后误点为 0 | 改版 v4（移动位置）上，“关闭通知”的定位器按角色+名称命中了“通知详情”，点错元素；BW-6 要求误点为 0 |
