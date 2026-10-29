# 测试

tests/smoke.py 是冒烟测试：用本地测试页和 .env 里配置的真实模型跑两遍主流程，第一遍各步骤由模型完成并写缓存，第二遍检查 act、read、download 全部按缓存回放；最后以子进程启动 MCP 服务，检查握手、goto、page_state、按编号和按指令的 act。缓存写到临时目录，不访问外网，浏览器无头运行。

```powershell
python tests/smoke.py                  # 用 .env 里的模型
python tests/smoke.py --env 其他配置    # 用另一个配置文件
```

换模型测试时，也可以直接在命令行设置 MODEL_BASE_URL、MODEL_NAME、MODEL_KEY，它们优先于 .env。全部通过时退出码为 0；失败时保留缓存目录和失败截图，并打印路径。

pytest 测试（先安装：pip install -e .[test]）分三档，默认只跑第一档：

| 档 | 命令 | 内容 | 需要 |
| --- | --- | --- | --- |
| 默认 | pytest | 单元测试（模型输出校验、约束解码与回退、任务名）；浏览器 + 本地测试页 + 假模型的功能测试（hover、blocked、scroll、wait_for、upload、伪元素名称、事件委托元素、extract 文本、没有效果的判断、失败截图、缓存目录），能缓存的跑两遍检查回放；MCP 进程内测试 | 无网络、无模型，约 2 分钟 |
| --real | pytest --real | 再加上用 .env 里真实模型的测试：同样的本地测试页，检查模型会不会输出 hover、blocked，extract 是否对齐，两遍回放 | 真实模型，约 3 分钟 |
| --site | pytest --site | 再加上练习站 the-internet.herokuapp.com 上的测试：悬停头像、进入即弹广告、无限滚动、慢加载、上传文件、表格提取、错误密码 | 外网 + 真实模型，约 3 分钟 |

测试页在 tests/pages.py，假模型和辅助函数在 tests/support.py，夹具在 tests/conftest.py。每个测试用自己的临时缓存目录，不影响 .obact。
