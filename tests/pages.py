"""pytest 用的本地测试页：路径 → HTML 片段。/api/slow 由测试服务器延迟 3 秒返回。"""

PAGES = {
    "/hover": """<style>.nav{display:flex;gap:24px;padding:10px;background:#f4f4f4}.menu{position:relative;cursor:pointer}
.menu ul{display:none;position:absolute;top:22px;left:0;background:#fff;border:1px solid #ccc;list-style:none;
padding:6px 12px;margin:0;width:90px}.menu:hover ul{display:block}</style>
<div class=nav><div class=menu>产品<ul><li><a href="#" onclick="r.textContent='已选择手机';return false">手机</a></li>
<li><a href="#" onclick="r.textContent='已选择电脑';return false">电脑</a></li></ul></div>
<div class=menu>服务</div><a href="#">关于我们</a></div><p id=r style="margin-top:120px"></p>""",
    "/blocked": """<h2>限时特卖</h2><button onclick="r.textContent='购买成功'">立即购买</button><p id=r></p>
<div id=mask style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center">
<div style="background:#fff;padding:30px;width:300px">订阅我们的新闻邮件，第一时间获取优惠信息。</div></div>
<script>addEventListener('keydown', e => { if (e.key === 'Escape') mask.remove(); });</script>""",
    "/stuck": """<h2>限时特卖</h2><button onclick="r.textContent='购买成功'">立即购买</button><p id=r></p>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.6)"></div>""",
    "/scroll": """<div id=list></div><p id=r style="position:fixed;top:0;right:0;background:#ff0"></p><script>
let n = 0;
function more() { for (let i = 0; i < 10 && n < 50; i++) { n++; list.insertAdjacentHTML('beforeend',
  `<div style="height:60px">商品 ${n} <button onclick="r.textContent='已加入商品 ${n}'">加入购物车</button></div>`); } }
more(); more();
addEventListener('scroll', () => { if (innerHeight + scrollY > document.body.scrollHeight - 200) setTimeout(more, 300); });
</script>""",
    "/slow": """<div id=box>加载中…</div><p id=r></p><script>
fetch('/api/slow').then(r => r.text()).then(() => { setTimeout(() => {
  box.innerHTML = '<button onclick="r.textContent=\\'结果详情\\'">查看结果</button>'; }, 500); });
</script>""",
    "/upload": """<input type=file id=f multiple style="display:none"
onchange="r.textContent='已选择：'+[...this.files].map(x=>x.name).join(',')">
<button onclick="f.click()" style="padding:8px 16px">上传附件</button><p id=r></p>
<input type=file id=g style="display:none"><button onclick="g.click()">上传头像</button>
<button>没有选择框的按钮</button>""",
    "/pseudo": """<style>.del::after{content:'删除'}.edit::after{content:'编辑'}button{margin:0 4px}</style>
<table border=1 cellpadding=8><tr><td>订单 A</td><td><button class=edit onclick="r.textContent='编辑订单 A'"></button>
<button class=del onclick="r.textContent='已删除订单 A'"></button></td></tr>
<tr><td>订单 B</td><td><button class=edit onclick="r.textContent='编辑订单 B'"></button>
<button class=del onclick="r.textContent='已删除订单 B'"></button></td></tr></table><p id=r></p>""",
    "/calendar": """<style>.grid{display:grid;grid-template-columns:repeat(7,70px);gap:4px}.day{display:flex;
flex-direction:column;align-items:center;border:1px solid #ddd;padding:6px;height:44px}.p{color:#e60;font-size:12px}</style>
<h3>11 月低价日历</h3><div class=grid id=g></div><p id=r></p>
<a href="#" title="The Road to Little Dribbling: Adventures of an American in Britain">The Road to Little ...</a><script>
const prices = {1: 380, 2: 340, 4: 370, 5: 300, 6: 420, 7: 360, 8: 310, 10: 290, 11: 330, 12: 350, 13: 400, 14: 320};
for (let d = 1; d <= 14; d++) g.insertAdjacentHTML('beforeend',
  `<div class=day data-d=${d}><span>${d}</span><span class=p>${prices[d] ? '¥' + prices[d] : ''}</span></div>`);
document.addEventListener('click', e => { const c = e.target.closest('.day'); if (c) r.textContent = '已选择 ' + c.dataset.d + ' 号'; });
</script>""",
    "/effect": """<h3>设置</h3><button>无效按钮</button><button onclick="r.textContent='已保存'">保存</button>
<label><input type=checkbox id=agree> 同意条款</label><input id=name value="张三"><p id=r></p>""",
    "/login": """<button onclick="showToast()">登录</button><div id=t></div><script>
function showToast() { t.innerHTML = '<div style="background:#c00;color:#fff;padding:12px;width:200px">密码错误</div>';
  setTimeout(() => { t.innerHTML = ''; }, 1500); }
</script>""",
}

# /calendar 每一天的价格，没有价格的为 None
CALENDAR = {1: 380, 2: 340, 3: None, 4: 370, 5: 300, 6: 420, 7: 360, 8: 310, 9: None, 10: 290, 11: 330, 12: 350,
            13: 400, 14: 320}
FULL_TITLE = "The Road to Little Dribbling: Adventures of an American in Britain"
